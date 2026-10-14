//! The agent tab's Rust half: one coding agent per tab, run in its cluster's
//! worktree through `kaava-agent-host`.
//!
//! The crate does the work — the process, the protocol, the transcript. This
//! module decides *where* a session may run and *who* may drive it, which are
//! questions about the shell's layout that the crate cannot answer:
//!
//! - **Only a local worktree.** The cluster's write environment must be
//!   `LocalWorktree`, and the crate's `Worktree::new` refuses a main checkout
//!   on its own as well (handoff §0: no agent on main).
//! - **Only the tab's own frame, or the shell on its behalf.** Every method but
//!   `agent-tab/harnesses` needs the calling instance, which reaches here only
//!   through [`call_for`] from `commands::app_call`. The MCP `app_call` path
//!   has no instance, so an agent cannot prompt or approve for a person.
//! - **Developer mode only**, until the owner signs off V6.
//! - **Only where it started.** A tab that changes cluster, or whose cluster
//!   is repointed, loses its session (see `Home`).
//!
//! Events leave as `agent-tab:event`; `ToolWindow` relays each to its frame.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use kaava_agent_host::{claude_spec, AgentHost, HarnessInfo, HostError, Level, Worktree};
use kaava_rpc::{RpcError, INVALID_PARAMS, METHOD_NOT_FOUND};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::apps::CallContext;
use crate::environments::Environment;
use crate::shell_state::{ShellSnapshot, ShellState};

/// The app id, as `REGISTRY` and the frontend's entry point spell it.
pub const ID: &str = "agent-tab";

/// The event every envelope is emitted as. Mirrored in `src/bindings.ts`.
pub const EVENT: &str = "agent-tab:event";

/// The JSON-RPC code for a refusal this module or the host made. `data.code`
/// says which; the tab draws the words for it from its own `strings.ts`.
pub const REFUSED: i32 = -32010;

/// How long the app's exit waits for agents to die.
const EXIT_WAIT: Duration = Duration::from_secs(3);

/// The methods that act on one tab's session, and so need that tab.
const INSTANCE_METHODS: &[&str] = &[
    "agent-tab/send",
    "agent-tab/attach",
    "agent-tab/cancel",
    "agent-tab/answer",
    "agent-tab/stop",
    "agent-tab/reset",
];

/// The host, built on first use so it can hold the `AppHandle` it emits on,
/// and where each tab's session started.
#[derive(Default)]
pub struct Sessions {
    host: OnceLock<AgentHost>,
    homes: Mutex<HashMap<String, Home>>,
}

/// The cluster a tab's session started in, and what that cluster pointed at
/// then. When any of it changes, the session is no longer this tab's to run.
#[derive(Debug, Clone, PartialEq)]
struct Home {
    cluster_id: String,
    environment: Option<Environment>,
    project: Option<String>,
}

/// Where the tab `instance_id` sits now, or `None` if it is in no tree.
fn home_of(snapshot: &ShellSnapshot, instance_id: &str) -> Option<Home> {
    snapshot
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .find(|c| c.tree.tabs().contains(&instance_id))
        .map(|c| Home {
            cluster_id: c.id.clone(),
            environment: c.environment.clone(),
            project: c.project.clone(),
        })
}

impl Sessions {
    fn homes(&self) -> std::sync::MutexGuard<'_, HashMap<String, Home>> {
        self.homes.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn host(&self, app: &AppHandle) -> &AgentHost {
        self.host.get_or_init(|| {
            let emitter = app.clone();
            AgentHost::new(
                Arc::new(move |envelope| {
                    let _ = emitter.emit(EVENT, &envelope);
                }),
                Arc::new(|level, line| match level {
                    Level::Failure => crate::kaava_log!("{line}"),
                    Level::Info => eprintln!("kaava: {line}"),
                }),
            )
        })
    }

    /// Stop the agents of tabs that have closed, and reset those whose tab
    /// is no longer where its session started.
    fn sync(&self, snapshot: &ShellSnapshot) {
        let Some(host) = self.host.get() else { return };
        let open = |id: &str| snapshot.instances.iter().any(|i| i.id == id);
        let mut homes = self.homes();
        host.retain(|id| open(id));
        homes.retain(|id, _| open(id));
        let moved: Vec<String> = homes
            .iter()
            .filter(|(id, home)| home_of(snapshot, id).as_ref() != Some(*home))
            .map(|(id, _)| id.clone())
            .collect();
        for id in moved {
            homes.remove(&id);
            host.reset(&id);
        }
    }

    /// Note where the session just sent to started. A tab that closed while
    /// it was starting missed `sync`, so its session stops here instead.
    fn record(&self, app: &AppHandle, host: &AgentHost, instance_id: &str) {
        let snapshot = app.state::<ShellState>().snapshot();
        let mut homes = self.homes();
        match home_of(&snapshot, instance_id) {
            Some(home) => {
                homes.entry(instance_id.to_string()).or_insert(home);
            }
            None => host.retain(|id| id != instance_id),
        }
    }

    /// Stop every agent, for the app's exit.
    pub fn stop_all(&self) {
        if let Some(host) = self.host.get() {
            host.stop_all(EXIT_WAIT);
        }
    }
}

/// Called after every layout change, beside `plane_webview::sync_visibility`:
/// a tab that is gone takes its agent with it.
pub fn sync_sessions(app: &AppHandle, snapshot: &ShellSnapshot) {
    if let Some(sessions) = app.try_state::<Sessions>() {
        sessions.sync(snapshot);
    }
}

/// The registry's dispatch, for callers with no instance: the Apps menu, the
/// shell's own menus and MCP `app_call`. Only `agent-tab/harnesses` answers.
pub fn call(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    call_for(app, context, None, method, params)
}

/// The dispatch for a call that names the agent-tab instance it is for.
pub fn call_for(
    app: &AppHandle,
    context: &CallContext,
    instance: Option<&str>,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    if method == "agent-tab/harnesses" {
        return Ok(harnesses(app, context));
    }
    let instance = match instance {
        Some(id) if is_agent_tab(app, id) => id,
        _ => return Err(unreached(method)),
    };
    let sessions = app.state::<Sessions>();
    let host = sessions.host(app);
    let params = params.unwrap_or(Value::Null);
    let done = |result: Result<(), HostError>| result.map(|()| json!({})).map_err(host_error);
    match method {
        "agent-tab/send" => {
            let text = text_param(&params, "text")?;
            if text_param(&params, "harness")? != "claude" {
                return Err(RpcError::new(
                    INVALID_PARAMS,
                    "the only harness is `claude`",
                ));
            }
            refuse_unless_developer(app)?;
            let worktree = worktree(app, context)?;
            let spec = claude_spec(
                std::env::var_os("PATH").as_deref(),
                std::env::var_os("PATHEXT").as_deref(),
            )
            .map_err(|hint| {
                refused(
                    "harness",
                    "Claude or its ACP adapter is not on PATH",
                    json!(hint),
                )
            })?;
            host.send(instance, spec, worktree, &text)
                .map_err(host_error)?;
            sessions.record(app, host, instance);
            Ok(json!({}))
        }
        "agent-tab/attach" => serde_json::to_value(host.attach(instance))
            .map_err(|e| RpcError::new(kaava_rpc::INTERNAL_ERROR, e.to_string())),
        "agent-tab/cancel" => done(host.cancel(instance)),
        // An approval advances the agent as much as a prompt does, so it is
        // gated the same way. Stopping one never is.
        "agent-tab/answer" => {
            refuse_unless_developer(app)?;
            done(host.answer(
                instance,
                &text_param(&params, "itemId")?,
                &text_param(&params, "optionId")?,
            ))
        }
        "agent-tab/stop" => {
            host.stop(instance);
            Ok(json!({}))
        }
        "agent-tab/reset" => {
            sessions.homes().remove(instance);
            host.reset(instance);
            Ok(json!({}))
        }
        _ => Err(unreached(method)),
    }
}

/// What the agent bar and the tab's empty state need before a first prompt:
/// each harness and what stands in its way, and whether this cluster can run
/// one at all.
fn harnesses(app: &AppHandle, context: &CallContext) -> Value {
    let claude = claude_spec(
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("PATHEXT").as_deref(),
    );
    let harnesses = [HarnessInfo {
        harness: kaava_agent_host::Harness::Claude,
        hint: claude.err(),
    }];
    let blocked = refuse_unless_developer(app)
        .and_then(|()| worktree(app, context).map(|_| ()))
        .err()
        .and_then(|e| e.data)
        .and_then(|d| d.get("code").cloned());
    json!({ "harnesses": harnesses, "blocked": blocked })
}

fn refuse_unless_developer(app: &AppHandle) -> Result<(), RpcError> {
    if crate::settings::flag(app, crate::settings::keys::DEVELOPER_MODE) {
        return Ok(());
    }
    Err(refused(
        "developerMode",
        "the agent tab is in testing, and runs only with developer mode on",
        Value::Null,
    ))
}

/// The worktree the calling cluster writes to, or why it has none.
fn worktree(app: &AppHandle, context: &CallContext) -> Result<Worktree, RpcError> {
    let env = context
        .cluster_id
        .as_deref()
        .and_then(|id| app.state::<ShellState>().cluster_write_environment(id));
    let path = worktree_path(env.as_ref())?;
    Worktree::new(&path).map_err(|e| host_error(HostError::NotAWorktree(e)))
}

/// The path of a local worktree environment. Pure, so the rule is tested.
fn worktree_path(env: Option<&Environment>) -> Result<PathBuf, RpcError> {
    match env {
        Some(Environment::LocalWorktree { path, .. }) => Ok(Path::new(path).to_path_buf()),
        _ => Err(refused(
            "notAWorktree",
            "agents run in a local worktree, and this cluster is not on one",
            Value::Null,
        )),
    }
}

/// Whether `id` is an open agent tab. `commands::app_call` takes the instance
/// id from whichever webview called, so this is checked, not assumed.
fn is_agent_tab(app: &AppHandle, id: &str) -> bool {
    app.state::<ShellState>()
        .snapshot()
        .instances
        .iter()
        .any(|i| i.id == id && i.app_id == ID)
}

/// Whether `method` acts on one tab's session. The MCP panel shows these as
/// refused, which is what [`call`] does with them.
pub fn needs_its_tab(method: &str) -> bool {
    INSTANCE_METHODS.contains(&method)
}

/// The answer for a method that reached here without its tab.
fn unreached(method: &str) -> RpcError {
    if needs_its_tab(method) {
        return refused(
            "noInstance",
            &format!("`{method}` acts on one agent tab's session, and only that tab may call it"),
            Value::Null,
        );
    }
    RpcError::new(METHOD_NOT_FOUND, format!("no such method: {method}"))
}

fn host_error(error: HostError) -> RpcError {
    let code = error.code();
    let hint = error.hint();
    refused(code, &error.to_string(), json!(hint))
}

fn refused(code: &str, message: &str, hint: Value) -> RpcError {
    RpcError::with_data(REFUSED, message, json!({ "code": code, "hint": hint }))
}

fn text_param(params: &Value, name: &str) -> Result<String, RpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            RpcError::new(
                INVALID_PARAMS,
                format!("`{name}` must be a non-empty string"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_of(error: &RpcError) -> Option<&str> {
        error.data.as_ref()?.get("code")?.as_str()
    }

    /// Handoff §0: never on main. Only a local worktree has a path to run in.
    #[test]
    fn only_a_local_worktree_runs_an_agent() {
        let worktree = Environment::LocalWorktree {
            name: "x".into(),
            path: "C:/wt/x".into(),
            branch: "wt/x".into(),
            base: "main".into(),
        };
        assert_eq!(
            worktree_path(Some(&worktree)).unwrap(),
            Path::new("C:/wt/x")
        );
        let design = Environment::Design {
            path: "C:/wt/design".into(),
            branch: "wt/design".into(),
        };
        for env in [Some(&Environment::Main), Some(&design), None] {
            let err = worktree_path(env).unwrap_err();
            assert_eq!(code_of(&err), Some("notAWorktree"), "{env:?}");
        }
    }

    /// MCP `app_call` reaches the registry dispatch with no instance, so an
    /// agent can neither prompt another agent nor approve its requests.
    #[test]
    fn a_call_without_its_tab_is_refused() {
        for method in ["agent-tab/send", "agent-tab/answer"] {
            assert!(INSTANCE_METHODS.contains(&method));
            let err = unreached(method);
            assert_eq!(err.code, REFUSED, "{method}");
            assert_eq!(code_of(&err), Some("noInstance"), "{method}");
        }
        assert_eq!(unreached("agent-tab/nonesuch").code, METHOD_NOT_FOUND);
    }

    fn cluster(id: &str, tabs: &[&str], path: &str) -> crate::shell_state::Cluster {
        let mut tree = crate::layout::PaneNode::leaf(format!("pane-{id}"));
        for tab in tabs {
            tree.insert_tab(&format!("pane-{id}"), tab, None);
        }
        crate::shell_state::Cluster {
            id: id.into(),
            name: id.into(),
            tree,
            project: Some(path.into()),
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            environment: Some(Environment::LocalWorktree {
                name: id.into(),
                path: path.into(),
                branch: format!("wt/{id}"),
                base: "main".into(),
            }),
            pinned: false,
            icon: None,
            environment_missing: false,
        }
    }

    fn snapshot(clusters: Vec<crate::shell_state::Cluster>) -> ShellSnapshot {
        ShellSnapshot {
            windows: vec![crate::shell_state::WindowPlacement {
                label: "main".into(),
                active_cluster_id: clusters.first().map(|c| c.id.clone()),
                clusters,
                geometry: None,
                right_page: None,
            }],
            instances: Vec::new(),
            terminals: Vec::new(),
        }
    }

    /// A session belongs to the cluster it started in, pointed where it was
    /// pointed then: a tab dragged away, or a cluster repointed, is a move.
    #[test]
    fn a_tab_is_home_only_in_the_cluster_and_worktree_it_started_in() {
        let before = snapshot(vec![
            cluster("c1", &["agent-tab-1"], "C:/wt/a"),
            cluster("c2", &[], "C:/wt/b"),
        ]);
        let home = home_of(&before, "agent-tab-1").unwrap();
        assert_eq!(home.cluster_id, "c1");

        let dragged = snapshot(vec![
            cluster("c1", &[], "C:/wt/a"),
            cluster("c2", &["agent-tab-1"], "C:/wt/b"),
        ]);
        assert_ne!(home_of(&dragged, "agent-tab-1").as_ref(), Some(&home));

        let repointed = snapshot(vec![cluster("c1", &["agent-tab-1"], "C:/wt/other")]);
        assert_ne!(home_of(&repointed, "agent-tab-1").as_ref(), Some(&home));

        let unchanged = snapshot(vec![cluster("c1", &["x", "agent-tab-1"], "C:/wt/a")]);
        assert_eq!(home_of(&unchanged, "agent-tab-1").as_ref(), Some(&home));
        assert!(home_of(&unchanged, "agent-tab-2").is_none());
    }

    #[test]
    fn a_host_error_carries_its_code_and_hint() {
        let err = host_error(HostError::Busy);
        assert_eq!(err.code, REFUSED);
        assert_eq!(code_of(&err), Some("busy"));
    }

    #[test]
    fn text_params_must_be_non_empty_strings() {
        let params = json!({ "text": "hi", "blank": "  ", "number": 3 });
        assert_eq!(text_param(&params, "text").unwrap(), "hi");
        for name in ["blank", "number", "missing"] {
            assert_eq!(text_param(&params, name).unwrap_err().code, INVALID_PARAMS);
        }
    }
}
