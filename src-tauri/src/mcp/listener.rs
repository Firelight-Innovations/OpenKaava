//! The HTTP surface every registered MCP server answers on.
//!
//! One listener, on loopback, with a route per server. `rmcp` implements the
//! protocol and the streamable-HTTP transport; what is here is the binding, the
//! bearer token, the routing table, and the adapter between `rmcp`'s handler
//! trait and [`Registry`](super::Registry).

use super::session::{self, Admission, SessionCluster, Sessions};
use super::{route, Block, Registry, Subscriptions, ToolAnswer, ToolDescriptor};
use axum::response::IntoResponse;
use base64::Engine;
use rand::RngCore;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorData,
    Implementation, ListResourceTemplatesResult, ListResourcesResult, ListToolsResult,
    PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult,
    Resource, ResourceContents, ResourceTemplate, ResourceUpdatedNotificationParam,
    ResourcesCapability, ServerCapabilities, ServerInfo, SubscribeRequestParams,
    SubscriptionFilter, Tool, UnsubscribeRequestParams,
};
use rmcp::service::{RequestContext, SubscriptionContext};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpService,
};
use rmcp::RoleServer;
use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// What a client needs in order to reach us: a port and a token.
///
/// Managed state, empty until [`start`] has bound. Everything that reads it —
/// the pty environment, the `.mcp.json` writer, the status bar — has to cope
/// with `None`, because a machine that would not give us a loopback socket is
/// one where OpenKaava should still open.
#[derive(Default)]
pub struct Endpoint {
    bound: Mutex<Option<Bound>>,
}

#[derive(Clone)]
struct Bound {
    port: u16,
    token: String,
}

impl Endpoint {
    /// The port and token, once bound.
    pub fn get(&self) -> Option<(u16, String)> {
        let guard = self.bound.lock().ok()?;
        guard.as_ref().map(|b| (b.port, b.token.clone()))
    }

    /// The two variables a spawned shell needs, ready to hand to a pty.
    ///
    /// Empty when nothing is bound, which is what makes the caller's loop a
    /// no-op rather than a branch: a terminal opened before the listener came up
    /// simply inherits neither variable and cannot connect, and that is the same
    /// state as a terminal the user opened outside OpenKaava.
    pub fn env(&self) -> Vec<(String, String)> {
        match self.get() {
            Some((port, token)) => vec![
                ("KAAVA_MCP_PORT".to_string(), port.to_string()),
                ("KAAVA_MCP_TOKEN".to_string(), token),
            ],
            None => Vec::new(),
        }
    }
}

/// Bind the listener and start serving, returning the port it took.
///
/// **Binding is synchronous and serving is not**, which is the whole shape of
/// this function. The port has to be known before the first terminal is spawned
/// — that terminal inherits it as an environment variable — and `setup` in
/// `lib.rs` is not async. So a `std` socket is bound here, its port read
/// immediately, and only the serving handed to the runtime.
///
/// **Port zero, deliberately.** There is no preferred port and no fallback
/// ladder, because nothing has to guess this number: the client is told it. A
/// fixed port would buy nothing and would collide with whatever else on the
/// machine had the same idea.
pub fn start(app: &AppHandle) -> Option<u16> {
    let socket = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
    let std_listener = match StdTcpListener::bind(socket) {
        Ok(listener) => listener,
        Err(e) => {
            crate::kaava_log!("could not bind the MCP listener: {e}");
            return None;
        }
    };

    let port = match std_listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            crate::kaava_log!("the MCP listener has no address: {e}");
            return None;
        }
    };

    if let Err(e) = std_listener.set_nonblocking(true) {
        crate::kaava_log!("could not make the MCP listener non-blocking: {e}");
        return None;
    }

    let token = mint_token();
    let endpoint = app.state::<Endpoint>();
    if let Ok(mut bound) = endpoint.bound.lock() {
        *bound = Some(Bound {
            port,
            token: token.clone(),
        });
    }

    // Safe to publish before serving starts: the socket is already bound, so a
    // client that reads this file and connects in the gap below waits in the
    // accept backlog rather than being refused.
    super::handoff::publish(app, port, &token);

    let router = router(app, token);

    // `tauri::async_runtime` is tokio, and is already running. Standing up a
    // second runtime to hold one listener would mean a second thread pool for
    // the lifetime of the process.
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(e) => {
                crate::kaava_log!("could not hand the MCP listener to the runtime: {e}");
                return;
            }
        };

        if let Err(e) = axum::serve(listener, router).await {
            crate::kaava_log!("the MCP listener stopped: {e}");
        }
    });

    Some(port)
}

/// 32 bytes from the OS, base64'd.
///
/// Not a uuid: a v4 uuid carries 122 bits and advertises its own shape. This is
/// 256 bits of the same entropy source with nothing to recognise.
pub(super) fn mint_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// One route per **registered** server, enabled or not.
///
/// Mounting the disabled ones too is what keeps a settings toggle from having to
/// rebuild the router and re-bind the socket. A server that is switched off
/// answers `tools/list` with an empty list — see [`Registry::tools`] — and its
/// key is left out of `.mcp.json`, so a client has no reason to be there at all
/// and gets a coherent answer if it is anyway.
fn router(app: &AppHandle, token: String) -> axum::Router {
    let mut router = axum::Router::new();

    // `list(true)` — every route this build has, developer-only ones included.
    // The router is built once, at boot, and developer mode can move afterwards;
    // a route left unmounted because the flag happened to be off at startup
    // would 404 for the rest of the session. Mounting it costs nothing, because
    // `list_tools` and `call_tool` below ask the flag again on every request.
    for info in app.state::<Registry>().list(true) {
        let path = route(&info.id);
        let handle = app.clone();
        let id = info.id.clone();

        let service = StreamableHttpService::new(
            move || {
                Ok(Bridge {
                    app: handle.clone(),
                    id: id.clone(),
                })
            },
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        );

        router = router.nest_service(&path, service);
    }

    let gate = Gate {
        master: token,
        app: app.clone(),
    };
    router.layer(axum::middleware::from_fn_with_state(
        Arc::new(gate),
        require_token,
    ))
}

/// What [`require_token`] checks a request against.
struct Gate {
    master: String,
    app: AppHandle,
}

/// Reject anything that does not present a token.
///
/// Loopback already keeps this off the network, but not away from other
/// processes on the same machine: a port is scannable, and these tools reach
/// into the live application. The token is what makes "OpenKaava spawned this shell"
/// the actual admission test. An agent tab's session token passes too, on the
/// context route only, and the cluster it was minted for rides along on the
/// request (see [`session`]).
async fn require_token(
    axum::extract::State(gate): axum::extract::State<Arc<Gate>>,
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let presented = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let sessions = gate.app.state::<Sessions>();
    let path = request.uri().path();

    match session::admit(path, presented, &gate.master, &sessions) {
        Admission::Master => next.run(request).await,
        Admission::Session(cluster) => {
            request.extensions_mut().insert(SessionCluster(cluster));
            next.run(request).await
        }
        Admission::Refused => axum::http::StatusCode::UNAUTHORIZED.into_response(),
    }
}

/// One registered server, wearing `rmcp`'s handler trait.
///
/// Holds an id and an `AppHandle` rather than anything from the registry,
/// because the registry is the authority and a copy taken at mount time would go
/// stale the moment a toggle moved. Every call looks the server up again.
#[derive(Clone)]
struct Bridge {
    app: AppHandle,
    id: String,
}

impl Bridge {
    fn reachable(&self) -> bool {
        self.app
            .state::<Registry>()
            .is_reachable(&self.id, super::dev_mode(&self.app))
    }

    /// Refuse a resource this server does not publish, or any while it is off.
    fn require_published(&self, uri: &str) -> Result<(), ErrorData> {
        let published = super::servers::resources(&self.id)
            .iter()
            .any(|r| r.uri == uri);
        if published && self.reachable() {
            Ok(())
        } else {
            Err(not_found(uri))
        }
    }

    /// As [`Self::require_published`], but also passing the references the
    /// context server reads without publishing.
    fn require_readable(&self, uri: &str) -> Result<(), ErrorData> {
        if super::servers::reads_unpublished(&self.id, uri) && self.reachable() {
            return Ok(());
        }
        self.require_published(uri)
    }
}

fn not_found(uri: &str) -> ErrorData {
    ErrorData::resource_not_found(format!("no resource at `{uri}`"), None)
}

/// Which client session a request belongs to: the `mcp-session-id` header the
/// transport minted at `initialize`, which `rmcp` leaves on the request's
/// extensions. Falls back to the request id so a transport that carries none
/// still gets a key, if not a stable one.
fn session_of(context: &RequestContext<RoleServer>) -> String {
    context
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.headers.get("mcp-session-id"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("request-{}", context.id))
}

/// The cluster a session token binds this request to, if it came with one.
fn cluster_of(context: &RequestContext<RoleServer>) -> Option<String> {
    let parts = context.extensions.get::<axum::http::request::Parts>()?;
    parts
        .extensions
        .get::<SessionCluster>()
        .map(|c| c.0.clone())
}

/// Answer from `cluster` whatever the call named: a session token is its
/// cluster's and no other's.
fn pin_cluster(params: &mut Option<serde_json::Value>, cluster: String) {
    let args = params.get_or_insert_with(|| serde_json::json!({}));
    if let Some(map) = args.as_object_mut() {
        map.insert("cluster".into(), serde_json::Value::String(cluster));
    }
}

impl ServerHandler for Bridge {
    /// Built by mutating a default rather than with a struct literal, because
    /// both of these types are `#[non_exhaustive]` — `rmcp` reserves the right
    /// to add fields as the protocol grows, and a literal here would break on
    /// every minor release that used it.
    ///
    /// `enable_tool_list_changed` is declared even though nothing emits the
    /// notification yet. A client decides once, at `initialize`, whether it will
    /// listen for one; claiming the capability now is what lets a settings
    /// toggle start working without every connected agent reconnecting.
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();

        info.capabilities = ServerCapabilities::builder()
            .enable_tools()
            .enable_tool_list_changed()
            .build();

        // Declared only for a server that publishes or reads something.
        // `subscribe` is the part an agent acts on: without it a client will not
        // ask to be told.
        let reads = !super::servers::resource_templates(&self.id).is_empty();
        if reads || !super::servers::resources(&self.id).is_empty() {
            let mut resources = ResourcesCapability::default();
            resources.subscribe = Some(true);
            info.capabilities.resources = Some(resources);
        }

        info.server_info = Implementation::new(
            format!("kaava-{}", self.id),
            env!("CARGO_PKG_VERSION").to_string(),
        );
        info.instructions = super::servers::instructions(&self.id).map(str::to_string);

        info
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = self
            .app
            .state::<Registry>()
            .tools(&self.id, super::dev_mode(&self.app))
            .into_iter()
            .map(into_rmcp_tool)
            .collect();

        // Unpaginated: `with_all_items` sets the cursor to `None`, which tells
        // the client this is the whole list. A server's tool count is a handful
        // by construction — see the rule in `servers` — so there is nothing to
        // page through.
        Ok(uncacheable(ListToolsResult::with_all_items(tools)))
    }

    /// Resources are published only while the server is switched on, for the
    /// reason `list_tools` is empty while it is off.
    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let listed = if self.reachable() {
            super::servers::resources(&self.id)
                .iter()
                .map(|r| {
                    Resource::new(r.uri, r.name)
                        .with_description(r.description)
                        .with_mime_type(r.mime_type)
                })
                .collect()
        } else {
            Vec::new()
        };

        Ok(ListResourcesResult::with_all_items(listed)
            .with_ttl_ms(0)
            .with_cache_scope(CacheScope::Private))
    }

    /// How to write a reference this server reads, for a client that lets
    /// the person pick one. Empty while the server is off.
    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        let templates = super::servers::resource_templates(&self.id);
        let listed = templates
            .iter()
            .filter(|_| self.reachable())
            .map(|t| ResourceTemplate::new(t.uri, t.name).with_description(t.description))
            .collect();
        Ok(templates_result(listed))
    }

    /// Reads run off the async worker: the workspace resource asks each webview
    /// a question and waits for the answer, which is blocking work.
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        self.require_readable(&request.uri)?;

        let (app, id, uri) = (self.app.clone(), self.id.clone(), request.uri.clone());
        let cluster = cluster_of(&context);
        let read = tauri::async_runtime::spawn_blocking(move || {
            super::servers::read_resource(&app, &id, &uri, cluster.as_deref())
        })
        .await
        .map_err(|e| ErrorData::internal_error(format!("the read did not finish: {e}"), None))?;

        let answer = match read {
            Some(Ok(answer)) => answer,
            Some(Err(e)) => return Err(read_error(e)),
            None => return Err(not_found(&request.uri)),
        };

        Ok(
            ReadResourceResult::new(resource_contents(&request.uri, answer))
                .with_ttl_ms(0)
                .with_cache_scope(CacheScope::Private)
                .into(),
        )
    }

    /// `resources/subscribe`, the form of subscription clients on protocol
    /// versions before 2026-07-28 use. The session's `peer` is what carries
    /// notifications back down its event stream, so a task is spawned to move
    /// each queued uri from [`Subscriptions`] onto it.
    #[allow(deprecated)]
    async fn subscribe(
        &self,
        request: SubscribeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        self.require_published(&request.uri)?;

        let session = session_of(&context);
        let mut queue =
            self.app
                .state::<Subscriptions>()
                .subscribe(&self.id, &request.uri, &session);

        let peer = context.peer.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(uri) = queue.recv().await {
                if peer
                    .notify_resource_updated(ResourceUpdatedNotificationParam::new(uri))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        Ok(())
    }

    #[allow(deprecated)]
    async fn unsubscribe(
        &self,
        request: UnsubscribeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        // Not held to the switch: it only forgets, and a client must be able
        // to stop what it started before the server was switched off.
        self.app.state::<Subscriptions>().unsubscribe(
            &self.id,
            &request.uri,
            &session_of(&context),
        );
        Ok(())
    }

    /// The 2026-07-28 form: one `subscriptions/listen` request that stays open
    /// and carries the notifications. We accept the uris we publish and ignore
    /// the rest, none while the server is off, and `listen` below holds the
    /// request open until it ends.
    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        if !self.reachable() {
            return None;
        }
        let published = super::servers::resources(&self.id);
        let uris: Vec<String> = requested
            .resource_subscriptions
            .iter()
            .flatten()
            .filter(|uri| published.iter().any(|r| r.uri == uri.as_str()))
            .cloned()
            .collect();

        (!uris.is_empty()).then(|| {
            SubscriptionFilter::builder()
                .resource_subscriptions(uris)
                .build()
        })
    }

    async fn listen(&self, context: SubscriptionContext) -> Result<(), ErrorData> {
        let session = format!("listen-{}", context.request_context().id);
        let uris = context
            .accepted()
            .resource_subscriptions
            .clone()
            .unwrap_or_default();

        let subscriptions = self.app.state::<Subscriptions>();
        for uri in &uris {
            let mut queue = subscriptions.subscribe(&self.id, uri, &session);
            let sink = context.sink().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(uri) = queue.recv().await {
                    if sink.notify_resource_updated(uri).await.is_err() {
                        break;
                    }
                }
            });
        }

        context.cancelled().await;

        // Dropping the entries closes each queue, which ends its forwarder.
        for uri in &uris {
            subscriptions.unsubscribe(&self.id, uri, &session);
        }
        Ok(())
    }

    /// A tool that fails comes back as a **result** carrying `is_error`, not as
    /// a protocol error.
    ///
    /// That distinction is the one worth getting right: a protocol error says
    /// the request was malformed and is the client's problem, where an errored
    /// result says the tool ran and could not do the thing — which is something
    /// the model can read, reason about, and retry differently. Handing it a
    /// transport failure instead throws that away.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let mut params = request.arguments.map(serde_json::Value::Object);
        if let Some(cluster) = cluster_of(&context) {
            pin_cluster(&mut params, cluster);
        }

        let answered = self.app.state::<Registry>().call(
            &self.app,
            &self.id,
            &request.name,
            params,
            super::dev_mode(&self.app),
        );

        let result = match answered {
            Ok(answer) => tool_result(answer),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(e.message)]),
        };

        Ok(result.into())
    }
}

/// An answer as the contents of the resource at `uri`: JSON as JSON, text as
/// text, and each picture as a blob.
fn resource_contents(uri: &str, answer: ToolAnswer) -> Vec<ResourceContents> {
    let blob = |mime: String, data: String| ResourceContents::blob(data, uri).with_mime_type(mime);
    match answer {
        ToolAnswer::Json(value) => {
            vec![ResourceContents::text(value.to_string(), uri).with_mime_type("application/json")]
        }
        ToolAnswer::Image { mime, data } => vec![blob(mime, data)],
        ToolAnswer::Blocks(blocks) => blocks
            .into_iter()
            .map(|block| match block {
                Block::Text(text) => ResourceContents::text(text, uri),
                Block::Image { mime, data } => blob(mime, data),
            })
            .collect(),
    }
}

/// A template list as [`uncacheable`] says a tool list must be.
fn templates_result(listed: Vec<ResourceTemplate>) -> ListResourceTemplatesResult {
    ListResourceTemplatesResult::with_all_items(listed)
        .with_ttl_ms(0)
        .with_cache_scope(CacheScope::Private)
}

/// A failed read as a protocol error: a reference that is malformed, missing
/// or refused is the caller's to fix, and anything else is ours.
fn read_error(e: kaava_rpc::RpcError) -> ErrorData {
    if e.code == kaava_rpc::INVALID_PARAMS {
        ErrorData::invalid_params(e.message, None)
    } else {
        ErrorData::internal_error(e.message, None)
    }
}

/// A tool's answer as MCP content.
fn tool_result(answer: ToolAnswer) -> CallToolResult {
    match answer {
        ToolAnswer::Json(value) => match ContentBlock::json(value) {
            Ok(content) => CallToolResult::success(vec![content]),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(format!(
                "the tool answered, but its answer could not be serialised: {e}"
            ))]),
        },
        // Straight through: the base64 is already what the wire carries, so
        // there is nothing here to serialise and nothing that can fail.
        ToolAnswer::Image { mime, data } => {
            CallToolResult::success(vec![ContentBlock::image(data, mime)])
        }
        ToolAnswer::Blocks(blocks) => CallToolResult::success(
            blocks
                .into_iter()
                .map(|block| match block {
                    Block::Text(text) => ContentBlock::text(text),
                    Block::Image { mime, data } => ContentBlock::image(data, mime),
                })
                .collect(),
        ),
    }
}

/// Say explicitly that a tool list must not be cached. Two reasons, both real.
///
/// **Correctness.** The list changes when a settings toggle moves, so a client
/// holding one past that moment is reasoning about an OpenKaava that no longer
/// exists.
///
/// **Interop.** `ttlMs` and `cacheScope` are *required* by MCP 2026-07-28.
/// `rmcp` makes them optional and omits them when unset, to stay compatible
/// with the older versions it also speaks — so a client validating against the
/// newer spec rejects the whole response, citing a field the server never
/// mentioned. Claude Code 2.1.233 does exactly this, and its `expected number,
/// received undefined` at `ttlMs` looks nothing like its cause.
///
/// Setting them satisfies every version: legal and optional in the old ones,
/// mandatory in the new.
///
/// Only the list needs it. `CallToolResult` has no caching fields at all — a
/// tool's answer is never cacheable — so there is nothing there to declare.
fn uncacheable(result: ListToolsResult) -> ListToolsResult {
    result.with_ttl_ms(0).with_cache_scope(CacheScope::Private)
}

/// A registry descriptor as `rmcp` wants it.
///
/// The schema is unwrapped from its `Value` here because `Tool` holds a map
/// rather than an arbitrary value. `Registry::every_schema_is_an_object` is what
/// keeps the fallback below unreachable; an empty object is used rather than a
/// panic so that one malformed schema costs one tool its arguments instead of
/// taking the process down.
pub(super) fn into_rmcp_tool(descriptor: ToolDescriptor) -> Tool {
    let schema = match descriptor.schema {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };

    let tool = Tool::new(descriptor.name, descriptor.description, Arc::new(schema));
    // Only a hint we actually know. `None` leaves the field off the wire rather
    // than claiming a tool is read-only or not.
    match descriptor.read_only {
        Some(read_only) => tool.annotate(rmcp::model::ToolAnnotations::new().read_only(read_only)),
        None => tool,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unbound_endpoint_offers_no_environment() {
        let endpoint = Endpoint::default();
        assert_eq!(endpoint.get(), None);
        assert!(
            endpoint.env().is_empty(),
            "a terminal spawned before the listener is up inherits nothing"
        );
    }

    #[test]
    fn a_bound_endpoint_names_both_variables() {
        let endpoint = Endpoint::default();
        if let Ok(mut bound) = endpoint.bound.lock() {
            *bound = Some(Bound {
                port: 4321,
                token: "sekrit".to_string(),
            });
        }

        let env = endpoint.env();
        assert_eq!(env.len(), 2);
        assert!(env.contains(&("KAAVA_MCP_PORT".to_string(), "4321".to_string())));
        assert!(env.contains(&("KAAVA_MCP_TOKEN".to_string(), "sekrit".to_string())));
    }

    /// Two launches must not share a token, or one instance's terminals could
    /// speak to another instance's listener.
    #[test]
    fn tokens_do_not_repeat() {
        let first = mint_token();
        let second = mint_token();

        assert_ne!(first, second);
        assert!(
            first.len() >= 40,
            "32 bytes of entropy should not encode this short: {first}"
        );
    }

    /// Base64url, so it survives a header, a shell environment and a JSON
    /// string without any of them needing to escape it.
    #[test]
    fn a_token_is_safe_in_a_header_and_in_an_env_var() {
        let token = mint_token();
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "token should be base64url with no padding: {token}"
        );
    }

    #[test]
    fn a_descriptor_becomes_a_tool_with_its_schema_intact() {
        let descriptor = ToolDescriptor {
            name: "ping".to_string(),
            description: "Answers.".to_string(),
            schema: serde_json::json!({ "type": "object", "properties": {} }),
            read_only: None,
        };

        let tool = into_rmcp_tool(descriptor);
        assert_eq!(tool.name, "ping");
        assert_eq!(tool.description.as_deref(), Some("Answers."));
        assert_eq!(tool.input_schema.get("type"), Some(&"object".into()));
    }

    /// **The regression this exists for:** `rmcp` omits `ttlMs` and
    /// `cacheScope` when they are unset, and a client validating against MCP
    /// 2026-07-28 — where they are required — rejects the whole response. The
    /// error it reports names a field we never sent, so nothing about it points
    /// back here. Serialising the real payload is the only way to catch it.
    #[test]
    fn a_tool_list_carries_the_caching_fields_the_newer_spec_requires() {
        let result = uncacheable(ListToolsResult::with_all_items(Vec::new()));
        let json = serde_json::to_value(&result).expect("a tool list serialises");

        assert_eq!(
            json["ttlMs"], 0,
            "omitting this fails validation clientside"
        );
        assert_eq!(json["cacheScope"], "private");
    }

    /// Zero rather than merely short. Our answers describe state a settings
    /// toggle can change between one call and the next, so there is no window
    /// in which a stale one is still true.
    #[test]
    fn nothing_we_return_may_be_cached_for_any_length_of_time() {
        let listed = uncacheable(ListToolsResult::with_all_items(Vec::new()));
        assert_eq!(listed.ttl_ms, Some(0));
        assert_eq!(listed.cache_scope, Some(CacheScope::Private));
    }

    #[test]
    fn a_session_answers_from_its_own_cluster_whatever_the_call_names() {
        let mut named = Some(serde_json::json!({ "uri": "kaava://selection", "cluster": "other" }));
        pin_cluster(&mut named, "mine".into());
        assert_eq!(
            named,
            Some(serde_json::json!({ "uri": "kaava://selection", "cluster": "mine" }))
        );
        let mut none = None;
        pin_cluster(&mut none, "mine".into());
        assert_eq!(none, Some(serde_json::json!({ "cluster": "mine" })));
    }

    #[test]
    fn a_resource_reads_as_text_and_blobs_in_order() {
        let answer = ToolAnswer::Blocks(vec![
            Block::Text("kaava://file/a.png (image): a.png".into()),
            Block::Image {
                mime: "image/png".into(),
                data: "AA==".into(),
            },
        ]);
        let out = serde_json::to_value(resource_contents("kaava://file/a.png", answer)).unwrap();
        assert_eq!(out[0]["mimeType"], "text/plain");
        assert_eq!(out[0]["text"], "kaava://file/a.png (image): a.png");
        assert_eq!(out[1]["mimeType"], "image/png");
        assert_eq!(out[1]["blob"], "AA==");
        assert_eq!(out[1]["uri"], "kaava://file/a.png");

        let json = resource_contents(
            "kaava://workspace/focus",
            serde_json::json!({"a": 1}).into(),
        );
        let json = serde_json::to_value(json).unwrap();
        assert_eq!(json[0]["mimeType"], "application/json");
        assert_eq!(json[0]["text"], r#"{"a":1}"#);
    }

    #[test]
    fn a_template_list_carries_the_caching_fields_too() {
        let json = serde_json::to_value(templates_result(Vec::new())).unwrap();
        assert_eq!(json["ttlMs"], 0);
        assert_eq!(json["cacheScope"], "private");
    }

    #[test]
    fn a_bad_reference_is_the_callers_mistake_and_anything_else_is_ours() {
        let bad = kaava_rpc::RpcError::new(kaava_rpc::INVALID_PARAMS, "no such file".to_string());
        assert_eq!(
            read_error(bad).code,
            ErrorData::invalid_params("", None).code
        );
        let broke = kaava_rpc::RpcError::new(kaava_rpc::INTERNAL_ERROR, "boom".to_string());
        assert_eq!(
            read_error(broke).code,
            ErrorData::internal_error("", None).code
        );
    }

    /// Blocks keep their order and their kinds: text stays text, a picture is
    /// an image a client draws, not base64 in a string.
    #[test]
    fn blocks_become_content_in_order() {
        let answer = ToolAnswer::Blocks(vec![
            Block::Text("lines 10-20".into()),
            Block::Image {
                mime: "image/png".into(),
                data: "iVBORw0KGgo=".into(),
            },
        ]);
        let json = serde_json::to_value(tool_result(answer)).unwrap();
        let content = json["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "lines 10-20");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["mimeType"], "image/png");
        assert_ne!(json["isError"], true);
    }

    /// A schema that is not an object costs that one tool its arguments. It must
    /// not cost the process its life — this runs inside the orchestrator.
    #[test]
    fn a_malformed_schema_degrades_rather_than_panicking() {
        let descriptor = ToolDescriptor {
            name: "broken".to_string(),
            description: "Has a schema that is not an object.".to_string(),
            schema: serde_json::json!([1, 2, 3]),
            read_only: None,
        };

        let tool = into_rmcp_tool(descriptor);
        assert!(tool.input_schema.is_empty());
    }
}
