//! The HTTP surface every registered MCP server answers on.
//!
//! One listener, on loopback, with a route per server. `rmcp` implements the
//! protocol and the streamable-HTTP transport; what is here is the binding, the
//! bearer token, the routing table, and the adapter between `rmcp`'s handler
//! trait and [`Registry`](super::Registry).

use super::{route, Registry, ToolAnswer, ToolDescriptor};
use axum::response::IntoResponse;
use base64::Engine;
use rand::RngCore;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorData,
    Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::RequestContext;
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
fn mint_token() -> String {
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

    router.layer(axum::middleware::from_fn_with_state(
        Arc::new(token),
        require_token,
    ))
}

/// Reject anything that does not present the token.
///
/// Loopback already keeps this off the network, but not away from other
/// processes on the same machine: a port is scannable, and these tools reach
/// into the live application. The token is what makes "OpenKaava spawned this shell"
/// the actual admission test.
async fn require_token(
    axum::extract::State(expected): axum::extract::State<Arc<String>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let presented = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    match presented {
        Some(token) if token == expected.as_str() => next.run(request).await,
        _ => axum::http::StatusCode::UNAUTHORIZED.into_response(),
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
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let params = request.arguments.map(serde_json::Value::Object);

        let answered = self.app.state::<Registry>().call(
            &self.app,
            &self.id,
            &request.name,
            params,
            super::dev_mode(&self.app),
        );

        let result = match answered {
            Ok(ToolAnswer::Json(value)) => match ContentBlock::json(value) {
                Ok(content) => CallToolResult::success(vec![content]),
                Err(e) => CallToolResult::error(vec![ContentBlock::text(format!(
                    "the tool answered, but its answer could not be serialised: {e}"
                ))]),
            },
            // Straight through: the base64 is already what the wire carries, so
            // there is nothing here to serialise and nothing that can fail.
            Ok(ToolAnswer::Image { mime, data }) => {
                CallToolResult::success(vec![ContentBlock::image(data, mime)])
            }
            Err(e) => CallToolResult::error(vec![ContentBlock::text(e.message)]),
        };

        Ok(result.into())
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
