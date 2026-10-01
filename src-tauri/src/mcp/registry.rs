//! Which MCP servers this build hosts, and which of them are switched on.
//!
//! Deliberately shaped like `apps::REGISTRY`: an id, a display name, a
//! description, and the function that answers a call. The difference is that
//! this one is a `Vec` built at boot rather than a `const` slice, because a
//! server can be switched off from settings and the exposed set has to be
//! allowed to change while a client is connected — see `notify_changed` in the
//! parent module.

use kaava_rpc::{RpcError, METHOD_NOT_FOUND};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::AppHandle;

/// One tool an MCP server exposes.
///
/// `schema` is a function rather than a pre-built `Value` because a static
/// cannot hold one, and rather than a `&'static str` of JSON because that moves
/// a malformed schema from a compile error to a runtime one nobody would see
/// until a client asked for `tools/list`.
///
/// `Copy` because a tool belongs to more than one server now: `agent` composes
/// its list out of `ui`'s and `debug`'s entries rather than restating them, and
/// a const array cannot be indexed to build another one unless the element type
/// can be copied out. Every field is already a `&'static str` or a fn pointer,
/// so this costs nothing and prevents the alternative — the same description
/// written twice, drifting the first time one of them is edited.
#[derive(Clone, Copy)]
pub struct McpTool {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: fn() -> Value,
}

/// What a tool answers with.
///
/// JSON covered every tool until one had to answer with a *picture*. A
/// screenshot base64'd into a JSON string is not a screenshot as far as a client
/// is concerned: no MCP client will render it, and the model is handed a wall of
/// characters it has to be told to ignore. MCP has a content type for images, so
/// the registry needs a way to say which kind a tool produced.
///
/// The `From<Value>` below keeps that from being a tax on the tools that answer
/// with facts — they go on returning `Ok(json!(...).into())`.
pub enum ToolAnswer {
    Json(Value),
    /// Base64, with the MIME type a client needs to decode it.
    Image {
        mime: String,
        data: String,
    },
}

impl From<Value> for ToolAnswer {
    fn from(value: Value) -> Self {
        ToolAnswer::Json(value)
    }
}

/// An MCP server's implementation: the function every `tools/call` lands in.
///
/// The same shape as `apps::Dispatch`, and it fails with the same `RpcError`,
/// so a server that wants to hand a call through to an app's Rust half can do
/// it without translating an error vocabulary in between.
type Call = fn(&AppHandle, &str, Option<Value>) -> Result<ToolAnswer, RpcError>;

/// One server this build hosts.
pub struct McpServer {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub tools: &'static [McpTool],
    pub call: Call,
    /// Hidden, unadvertised and undispatchable unless `developer.mode` is on.
    ///
    /// For a server that exists to work *on* OpenKaava rather than in it. Somebody
    /// who is not writing the shell has no use for one, and one of them can
    /// drive this window — so the default has to be that it is not there, and
    /// the switch that reveals it has to be a deliberate thing to find.
    ///
    /// The flag itself is not stored here. See [`Registry`].
    pub dev_only: bool,
}

/// A registered server as the settings UI needs to see it.
///
/// Owned `String`s rather than the `&'static str`s above: this crosses to the
/// frontend through `serde_json`, and a borrowed lifetime cannot.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    /// What the client connects to, relative to the listener's origin.
    pub path: String,
    /// The key this server occupies in a project's `.mcp.json`.
    pub config_key: String,
    pub tool_count: usize,
    /// True for a row only developer mode reveals, so the panel can mark it.
    pub dev_only: bool,
}

/// One tool as the listener needs it: owned, and free of any protocol's field
/// names. See [`Registry::tools`] for why the shaping happens a layer up.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub schema: Value,
    /// MCP's `readOnlyHint`, only where [`servers::read_only_hint`] knows.
    pub read_only: Option<bool>,
}

/// What one server declares, in the shape `tools/list` is served from.
fn describe(server: &McpServer) -> Vec<ToolDescriptor> {
    server
        .tools
        .iter()
        .map(|t| ToolDescriptor {
            name: t.name.to_string(),
            description: t.description.to_string(),
            schema: (t.schema)(),
            read_only: super::servers::read_only_hint(server.id, t.name),
        })
        .collect()
}

/// One tool as the panel draws it, spelled the way MCP spells it on the wire
/// (`inputSchema`, `annotations.readOnlyHint`) so the two are comparable.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PanelTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<PanelAnnotations>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PanelAnnotations {
    pub read_only_hint: bool,
}

impl From<ToolDescriptor> for PanelTool {
    fn from(d: ToolDescriptor) -> Self {
        Self {
            name: d.name,
            description: d.description,
            input_schema: d.schema,
            annotations: d
                .read_only
                .map(|read_only_hint| PanelAnnotations { read_only_hint }),
        }
    }
}

/// A server's id and its tools, for the panel.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerCatalog {
    pub id: String,
    pub tools: Vec<PanelTool>,
}

/// The `.mcp.json` key and URL path for a server id.
///
/// Prefixed because that file is the user's, shared with whatever else they
/// have configured, and an unprefixed `acme` would both read as theirs and
/// stand a real chance of colliding with it. The prefix also keeps us clear of
/// the names Claude Code reserves for its own built-in servers — `workspace`,
/// `computer-use` and the rest — which are rejected at load time rather than
/// renamed.
pub fn config_key(id: &str) -> String {
    format!("kaava-{id}")
}

/// Where a server answers, relative to the listener's origin.
pub fn route(id: &str) -> String {
    format!("/mcp/{id}")
}

struct Entry {
    server: &'static McpServer,
    enabled: bool,
}

impl Entry {
    /// Whether a client can reach this server, for a given developer mode.
    ///
    /// Two conditions, different in kind. `enabled` is the switch on the row.
    /// `dev_only` against `dev_mode` is whether the row exists to be switched at
    /// all — a developer-only server with developer mode off is not "off", it is
    /// absent, and a client has to be told the same thing about it as about a
    /// server this build was never compiled with.
    fn reachable(&self, dev_mode: bool) -> bool {
        self.enabled && (dev_mode || !self.server.dev_only)
    }
}

/// Every server this build hosts, and its on/off state.
///
/// The lock is a plain `std::sync::Mutex` even though the callers are async,
/// which is only sound because **no method here returns a guard**. Every one of
/// them copies what it needs and drops the lock before returning, so a guard can
/// never be alive across an `.await` — the deadlock this choice would otherwise
/// invite. Keep that property when adding a method.
///
/// **Developer mode is a parameter, not a field.** It is a setting, and settings
/// live in `settings::Registry`; a copy cached here would be a second answer to
/// one question, wrong for however long it took something to notice a change and
/// push it across. Every method it can affect takes it instead, so the flag is
/// read at the moment of use and there is nothing to keep in step.
/// `mcp::dev_mode` is the one-line reader every caller uses.
#[derive(Default)]
pub struct Registry {
    entries: Mutex<Vec<Entry>>,
}

impl Registry {
    /// Put a server on the list. Switched on, unless it is developer-only.
    ///
    /// Re-registering an id replaces it rather than shadowing it. Two entries
    /// answering to one name would leave `find` silently picking whichever came
    /// first, and the settings UI drawing a row whose toggle changed the other
    /// one.
    ///
    /// A developer-only server starts **off**, so that switching developer mode
    /// on reveals a switch rather than throws one. Revealing and enabling are
    /// two decisions, and a server that can click things in the user's own
    /// window is worth charging both.
    pub fn register(&self, server: &'static McpServer) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };

        let entry = Entry {
            server,
            enabled: !server.dev_only,
        };

        match entries.iter().position(|e| e.server.id == server.id) {
            Some(at) => entries[at] = entry,
            None => entries.push(entry),
        }
    }

    /// Every server the user should see, on or off, for the settings UI.
    ///
    /// A developer-only row is absent with `dev_mode` false, rather than greyed
    /// out or marked unavailable. A row whose purpose is to explain that it is
    /// not for you is still a row, and the point of the flag is that most people
    /// never learn these servers exist.
    pub fn list(&self, dev_mode: bool) -> Vec<ServerInfo> {
        let Ok(entries) = self.entries.lock() else {
            return Vec::new();
        };

        entries
            .iter()
            .filter(|e| dev_mode || !e.server.dev_only)
            .map(|e| ServerInfo {
                id: e.server.id.to_string(),
                name: e.server.name.to_string(),
                description: e.server.description.to_string(),
                enabled: e.enabled,
                path: route(e.server.id),
                config_key: config_key(e.server.id),
                tool_count: e.server.tools.len(),
                dev_only: e.server.dev_only,
            })
            .collect()
    }

    /// The ids a client can currently reach — what routes are mounted and what
    /// goes into `.mcp.json`.
    pub fn enabled_ids(&self, dev_mode: bool) -> Vec<String> {
        let Ok(entries) = self.entries.lock() else {
            return Vec::new();
        };

        entries
            .iter()
            .filter(|e| e.reachable(dev_mode))
            .map(|e| e.server.id.to_string())
            .collect()
    }

    /// Every server whose switch is not where it shipped, for the store.
    ///
    /// Sparse, like `settings::Registry::changed`, and for the same reason: a
    /// later build that changes what a server ships as should reach everybody
    /// who never disagreed with the old answer. A file listing every server
    /// would freeze today's defaults onto every machine that ever opened the
    /// settings screen.
    pub fn switched(&self) -> BTreeMap<String, bool> {
        let Ok(entries) = self.entries.lock() else {
            return BTreeMap::new();
        };

        entries
            .iter()
            .filter(|e| e.enabled != !e.server.dev_only)
            .map(|e| (e.server.id.to_string(), e.enabled))
            .collect()
    }

    /// Put back what the store remembers, dropping ids this build does not have.
    ///
    /// Dropped rather than kept: an id nobody registered cannot be drawn,
    /// advertised or called, so carrying it forward would only mean writing it
    /// back out again forever.
    pub fn hydrate(&self, switched: BTreeMap<String, bool>) {
        for (id, enabled) in switched {
            if !self.set_enabled(&id, enabled) {
                crate::kaava_log!("no MCP server named {id:?}, dropping its saved switch");
            }
        }
    }

    /// Switch a server on or off. `false` if no such id is registered.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };

        match entries.iter_mut().find(|e| e.server.id == id) {
            Some(entry) => {
                entry.enabled = enabled;
                true
            }
            None => false,
        }
    }

    /// What one server exposes right now, for whoever is answering
    /// `tools/list`.
    ///
    /// Owned and protocol-neutral on purpose. The registry knows what a tool
    /// *is*; it does not know that MCP spells the schema field `inputSchema`,
    /// and keeping that here would mean the wire format of a protocol had leaked
    /// into the data structure the settings UI reads. The listener owns the
    /// shape; this owns the content.
    ///
    /// A **disabled** server has no tools rather than an error. Its route is
    /// still mounted — see the listener for why toggling does not rebuild the
    /// router — so this is the answer a client gets while it is switched off,
    /// and an empty list is the one a client already knows how to handle.
    pub fn tools(&self, id: &str, dev_mode: bool) -> Vec<ToolDescriptor> {
        let Ok(entries) = self.entries.lock() else {
            return Vec::new();
        };

        entries
            .iter()
            .find(|e| e.server.id == id && e.reachable(dev_mode))
            .map(|e| describe(e.server))
            .unwrap_or_default()
    }

    /// Every server the user should see, with every tool it declares.
    ///
    /// For the settings panel. Built from [`describe`], the same function
    /// [`Registry::tools`] builds `tools/list` from, so the panel cannot say
    /// something the wire does not. Unlike `tools`, a switched-off server still
    /// lists its tools: the panel is where somebody decides whether to switch
    /// it on.
    pub fn catalog(&self, dev_mode: bool) -> Vec<ServerCatalog> {
        let Ok(entries) = self.entries.lock() else {
            return Vec::new();
        };

        entries
            .iter()
            .filter(|e| dev_mode || !e.server.dev_only)
            .map(|e| ServerCatalog {
                id: e.server.id.to_string(),
                tools: describe(e.server)
                    .into_iter()
                    .map(PanelTool::from)
                    .collect(),
            })
            .collect()
    }

    /// Route one `tools/call` to the server that owns it.
    ///
    /// The lookup copies the function pointer out and drops the lock before
    /// calling it. A handler can take as long as it likes, and can re-enter this
    /// registry, without holding every other request behind it.
    pub fn call(
        &self,
        app: &AppHandle,
        id: &str,
        tool: &str,
        params: Option<Value>,
        dev_mode: bool,
    ) -> Result<ToolAnswer, RpcError> {
        let resolved = {
            let entries = self.entries.lock().map_err(|_| {
                RpcError::new(
                    kaava_rpc::INTERNAL_ERROR,
                    "the MCP registry lock is poisoned",
                )
            })?;

            entries
                .iter()
                .find(|e| e.server.id == id && e.reachable(dev_mode))
                .map(|e| (e.server.call, e.server.tools.iter().any(|t| t.name == tool)))
        };

        let Some((call, known)) = resolved else {
            return Err(RpcError::new(
                METHOD_NOT_FOUND,
                format!("no MCP server with id `{id}`"),
            ));
        };

        // Checked here rather than left to the handler so that every server
        // answers an unknown tool the same way, and so a handler's `match` can
        // end in an arm that is genuinely unreachable rather than in a duplicate
        // of this message.
        if !known {
            return Err(RpcError::new(
                METHOD_NOT_FOUND,
                format!("`{id}` has no tool named `{tool}`"),
            ));
        }

        call(app, tool, params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        serde_json::json!({ "type": "object", "properties": {} })
    }

    fn unreachable_call(_: &AppHandle, _: &str, _: Option<Value>) -> Result<ToolAnswer, RpcError> {
        // Reaching this would mean `call` dispatched without an `AppHandle`,
        // which these tests cannot construct — so the tests below exercise
        // everything up to the handler and stop there.
        Err(RpcError::new(kaava_rpc::INTERNAL_ERROR, "not called"))
    }

    static TOOLS: &[McpTool] = &[
        McpTool {
            name: "ping",
            description: "Answers.",
            schema,
        },
        McpTool {
            name: "echo",
            description: "Says it back.",
            schema,
        },
    ];

    static SERVER: McpServer = McpServer {
        id: "echo",
        name: "Echo",
        description: "Proves the plumbing.",
        tools: TOOLS,
        call: unreachable_call,
        dev_only: false,
    };

    static OTHER: McpServer = McpServer {
        id: "other",
        name: "Other",
        description: "A second one.",
        tools: &[],
        call: unreachable_call,
        dev_only: false,
    };

    static DEV: McpServer = McpServer {
        id: "dev",
        name: "Dev",
        description: "Only for whoever is working on the shell.",
        tools: &[],
        call: unreachable_call,
        dev_only: true,
    };

    #[test]
    fn a_registered_server_is_listed_and_on() {
        let registry = Registry::default();
        registry.register(&SERVER);

        let listed = registry.list(false);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "echo");
        assert!(listed[0].enabled);
        assert_eq!(listed[0].tool_count, 2);
    }

    /// Two entries answering to one name would leave `find` picking whichever
    /// came first, and a settings toggle changing the other one.
    #[test]
    fn registering_an_id_twice_replaces_rather_than_duplicates() {
        let registry = Registry::default();
        registry.register(&SERVER);
        registry.register(&SERVER);

        assert_eq!(registry.list(false).len(), 1);
    }

    #[test]
    fn disabling_hides_a_server_from_the_client_but_not_from_settings() {
        let registry = Registry::default();
        registry.register(&SERVER);
        registry.register(&OTHER);

        assert!(registry.set_enabled("echo", false));

        assert_eq!(registry.enabled_ids(false), vec!["other".to_string()]);
        assert_eq!(
            registry.list(false).len(),
            2,
            "settings still draws a row for a server that is switched off"
        );
        assert!(registry.tools("echo", false).is_empty());
    }

    #[test]
    fn toggling_an_unregistered_id_reports_it_rather_than_silently_passing() {
        let registry = Registry::default();
        assert!(!registry.set_enabled("nonesuch", false));
    }

    /// Declaration order is preserved, because it is the order a model reads
    /// the list in and there is no reason to hand it a shuffled one.
    #[test]
    fn tools_are_described_in_declaration_order() {
        let registry = Registry::default();
        registry.register(&SERVER);

        let tools = registry.tools("echo", false);
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "ping");
        assert_eq!(tools[0].description, "Answers.");
        assert!(tools[0].schema.is_object());
        assert_eq!(tools[1].name, "echo");
    }

    /// A tool's schema must be a JSON *object*. MCP's `inputSchema` is a JSON
    /// Schema, and the listener has to hand `rmcp` a map rather than a bare
    /// value — a schema that were an array or a string would have nowhere to go.
    #[test]
    fn every_schema_is_an_object() {
        let registry = Registry::default();
        registry.register(&SERVER);

        for tool in registry.tools("echo", false) {
            assert!(
                tool.schema.is_object(),
                "schema for {:?} must be a JSON object",
                tool.name
            );
        }
    }

    #[test]
    fn an_unregistered_server_has_no_tools() {
        let registry = Registry::default();
        assert!(registry.tools("nonesuch", false).is_empty());
    }

    /// The whole point of the flag: with developer mode off the server is not a
    /// row the settings screen draws, not a key `.mcp.json` names, and not a
    /// route that answers. Any one of those leaking is the feature failing.
    #[test]
    fn a_developer_only_server_is_absent_until_developer_mode_is_on() {
        let registry = Registry::default();
        registry.register(&SERVER);
        registry.register(&DEV);

        let ids: Vec<String> = registry.list(false).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["echo".to_string()]);
        assert_eq!(registry.enabled_ids(false), vec!["echo".to_string()]);
        assert!(registry.tools("dev", false).is_empty());

        let revealed: Vec<String> = registry.list(true).into_iter().map(|s| s.id).collect();
        assert_eq!(revealed, vec!["echo".to_string(), "dev".to_string()]);
    }

    /// Revealed, but not switched on by it. Turning developer mode on is
    /// permission to see the switch, not a decision to have pulled it.
    #[test]
    fn revealing_a_developer_only_server_does_not_also_enable_it() {
        let registry = Registry::default();
        registry.register(&DEV);

        let row = registry.list(true).remove(0);
        assert!(!row.enabled, "a developer-only server starts off");
        assert!(row.dev_only, "and says so, so the panel can mark it");
        assert!(
            registry.enabled_ids(true).is_empty(),
            "nothing is advertised until its own switch moves"
        );

        assert!(registry.set_enabled("dev", true));
        assert_eq!(registry.enabled_ids(true), vec!["dev".to_string()]);
    }

    /// The store holds only what somebody moved, so that a later build changing
    /// what a server ships as reaches everyone who never disagreed.
    #[test]
    fn only_a_switch_away_from_its_shipped_position_is_written_down() {
        let registry = Registry::default();
        registry.register(&SERVER);
        registry.register(&DEV);

        assert!(
            registry.switched().is_empty(),
            "a registry nobody has touched writes nothing"
        );

        registry.set_enabled("dev", true);
        registry.set_enabled("echo", false);

        let switched = registry.switched();
        assert_eq!(switched.len(), 2);
        assert!(switched["dev"], "the developer server was switched on");
        assert!(!switched["echo"], "and echo was switched off");
    }

    /// The round trip the store exists for. A switch that does not come back is
    /// a switch that resets itself overnight.
    #[test]
    fn hydrating_puts_every_moved_switch_back() {
        let registry = Registry::default();
        registry.register(&SERVER);
        registry.register(&DEV);
        registry.set_enabled("dev", true);

        let saved = registry.switched();

        let restarted = Registry::default();
        restarted.register(&SERVER);
        restarted.register(&DEV);
        restarted.hydrate(saved.clone());

        assert_eq!(restarted.switched(), saved);
        assert_eq!(restarted.enabled_ids(true), vec!["echo", "dev"]);
    }

    /// A store written by a build that had a server this one does not must not
    /// take the servers beside it down with it.
    #[test]
    fn a_saved_switch_for_an_unknown_server_is_dropped_not_kept() {
        let registry = Registry::default();
        registry.register(&SERVER);
        registry.hydrate(BTreeMap::from([
            ("acme".to_string(), true),
            ("echo".to_string(), false),
        ]));

        assert_eq!(
            registry.switched(),
            BTreeMap::from([("echo".to_string(), false)])
        );
    }

    /// Switching developer mode back off has to take an *enabled* server away
    /// too. Anything less leaves the dangerous case — a server somebody turned
    /// on, then thought they had put away — reachable.
    #[test]
    fn turning_developer_mode_off_hides_a_server_that_was_switched_on() {
        let registry = Registry::default();
        registry.register(&DEV);
        assert!(registry.set_enabled("dev", true));

        assert_eq!(registry.enabled_ids(true), vec!["dev".to_string()]);
        assert!(registry.enabled_ids(false).is_empty());
        assert!(registry.tools("dev", false).is_empty());
    }

    /// The `.mcp.json` key is prefixed so it cannot collide with a server the
    /// user configured, or with the names Claude Code reserves for its own.
    #[test]
    fn config_keys_and_routes_are_namespaced_under_kaava() {
        assert_eq!(config_key("acme"), "kaava-acme");
        assert_eq!(route("acme"), "/mcp/acme");

        for reserved in ["workspace", "computer-use", "claude-in-chrome"] {
            assert_ne!(config_key(reserved), reserved);
        }
    }

    /// Server ids reach a URL path and a config key, so they are held to the
    /// same rule as app ids and tool ids: `^[a-z][a-z0-9-]*$`.
    #[test]
    fn server_ids_are_url_safe() {
        for server in [&SERVER, &OTHER, &DEV] {
            let mut chars = server.id.chars();
            assert!(
                matches!(chars.next(), Some(c) if c.is_ascii_lowercase()),
                "server id {:?} must start with a lowercase letter",
                server.id
            );
            assert!(
                chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "server id {:?} must match ^[a-z][a-z0-9-]*$",
                server.id
            );
        }
    }

    /// MCP tool names travel through a client that composes them into
    /// `mcp__<server>__<tool>`, so anything outside this set arrives mangled.
    #[test]
    fn tool_names_are_safe_to_compose_into_a_client_side_name() {
        for tool in TOOLS {
            assert!(!tool.name.is_empty(), "a tool must be named");
            assert!(
                tool.name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
                "tool name {:?} must match ^[A-Za-z0-9_-]+$",
                tool.name
            );
        }
    }

    /// The conversion is what keeps [`ToolAnswer`] from being a tax on the
    /// tools that answer with facts. If it ever stopped being free, every one of
    /// them would have to be edited to say so.
    #[test]
    fn a_json_value_becomes_a_json_answer_without_ceremony() {
        let answer: ToolAnswer = serde_json::json!({ "ok": true }).into();

        match answer {
            ToolAnswer::Json(value) => assert_eq!(value["ok"], true),
            ToolAnswer::Image { .. } => panic!("a JSON value must not become an image"),
        }
    }

    /// Every tool needs a description, because the description is the entire
    /// basis on which a model decides whether to call it.
    #[test]
    fn every_tool_describes_itself() {
        for tool in TOOLS {
            assert!(
                !tool.description.trim().is_empty(),
                "tool {:?} has no description",
                tool.name
            );
        }
    }
}
