//! Where the person is working, for any agent connected to OpenKaava.
//! An agent in a terminal pane cannot see the window around it; these three tools say which
//! pane has focus, how panes are arranged, and which project each cluster is on.
//!
//!
//! **Read-only, and on in every build.** Unlike [`super::debug`] there is no
//! developer gate, because nothing here reaches past what the person can see on
//! screen: no input, no `eval`, no failures buffer, no window geometry. What
//! `shell_snapshot` carries that this leaves out (geometry, band heights,
//! restore bookkeeping, agent-finished dots) is internal to the shell.
//!
//! The layout comes from the same [`ShellSnapshot`] `shell_snapshot` reads. Focus
//! lives in the DOM, so each window's shell reports it to [`FocusState`]; `focus`
//! takes who has focus from there, asks each window's page for what only the DOM
//! knows (the way the `context` tool does), and falls back to the layout's active
//! tabs when nothing has reported. The `kaava://workspace/focus` resource serves
//! the same answer and is what a subscribed agent is told has changed.

use super::McpResource;
use crate::devtools;
use crate::layout::PaneNode;
use crate::mcp::{FocusReport, FocusState, McpServer, McpTool, ToolAnswer};
use crate::shell_state::{Cluster, ShellSnapshot, ShellState, SurfaceKind, WindowPlacement};
use kaava_rpc::{RpcError, INTERNAL_ERROR, METHOD_NOT_FOUND};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub static SERVER: McpServer = McpServer {
    id: ID,
    name: "Workspace",
    description: "Where the person is working: which pane has focus, how the panes are \
                  arranged, and which project each cluster is on. Read-only.",
    tools: TOOLS,
    call,
    dev_only: false,
};

/// The server id, which the subscription table and the notifier key on.
pub const ID: &str = "workspace";

/// What an agent subscribes to in order to hear that focus moved. Reading it
/// returns exactly what the `focus` tool does.
pub const FOCUS_URI: &str = "kaava://workspace/focus";

pub static RESOURCES: &[McpResource] = &[McpResource {
    uri: FOCUS_URI,
    name: "focus",
    description: "Where the person is working right now: the same answer as the `focus` tool.                   Subscribe to be sent notifications/resources/updated when it changes, then                   read it again.",
    mime_type: "application/json",
}];

/// Answer a `resources/read`. `None` for a uri this server does not publish.
pub fn read_resource(app: &AppHandle, uri: &str) -> Option<Result<Value, RpcError>> {
    (uri == FOCUS_URI).then(|| Ok(focus_answer(app)))
}

fn focus_answer(app: &AppHandle) -> Value {
    let snapshot = app.state::<ShellState>().snapshot();
    focus_view(&snapshot, &page_contexts(app))
}

static TOOLS: &[McpTool] = &TOOL_LIST;

const TOOL_LIST: [McpTool; 3] = [
    McpTool {
        name: "focus",
        description: "What the person is looking at right now: the focused pane, the app and \
                      instance in it, the file it shows and its selection when the app reports \
                      one, plus every surface visible on screen. Call this first when the \
                      person says \"this\", \"here\" or \"the open file\". Focus is often in \
                      the terminal you are running in; `visible` then lists the apps beside it.",
        schema: no_params,
    },
    McpTool {
        name: "layout",
        description: "Every window, cluster and pane, with what each pane holds (app, \
                      instance id, title, file where known) and which tab is active. Use the \
                      instance ids with the canvas server's tools.",
        schema: no_params,
    },
    McpTool {
        name: "project",
        description: "The project each cluster is working on: the project folder, the folder \
                      its files are actually read from (a worktree's, when it has one), and \
                      the branch. Also says which cluster is active.",
        schema: no_params,
    },
];

fn no_params() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

fn call(app: &AppHandle, tool: &str, _params: Option<Value>) -> Result<ToolAnswer, RpcError> {
    let snapshot = app.state::<ShellState>().snapshot();
    match tool {
        "focus" => Ok(focus_answer(app).into()),
        "layout" => Ok(layout_view(&snapshot, &page_contexts(app)).into()),
        "project" => Ok(project_view(&snapshot).into()),
        other => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("the workspace server has no tool named `{other}`"),
        )),
    }
}

/// What one window's page says about focus.
///
/// Evaluated in the page because the backend never learns where DOM focus is.
/// `reports` come from `window.__kaavaContext`, which an app defines to say what
/// it is showing (the canvas app reports its open canvas and selection).
const FOCUS_BODY: &str = r#"
const a = deepActive();
const apps = [];
for (const f of document.querySelectorAll('iframe')) {
  let report = null;
  try { const fn = f.contentWindow.__kaavaContext; report = typeof fn === 'function' ? fn() : null; } catch { report = null; }
  apps.push({ instance: instanceOf(f), title: f.getAttribute('title'), focused: f === a.frame, visible: shown(f, document), report });
}
let text = '';
try { text = String(a.doc.getSelection ? a.doc.getSelection() : ''); } catch { text = ''; }
return JSON.stringify({
  focusIn: a.frame ? 'app' : (terminal(a.el) ? 'terminal' : (a.el ? 'shell' : 'nothing')),
  instance: instanceOf(a.frame || a.el),
  windowHasFocus: document.hasFocus(),
  apps,
  selectedText: text.slice(0, 2000),
  selectedTextLength: text.length,
});
"#;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct PageContext {
    pub focus_in: String,
    pub instance: Option<String>,
    pub window_has_focus: bool,
    pub apps: Vec<PageApp>,
    pub selected_text: String,
    pub selected_text_length: usize,
    /// The pane the shell treats as active, from the shell's focus report.
    pub pane: Option<String>,
    /// The cluster on screen, from the shell's focus report.
    pub cluster: Option<String>,
}

impl PageContext {
    /// Make the stored report the answer for who has focus.
    ///
    /// The page's own probe still supplies what only the DOM knows at this
    /// moment (the apps' reports, the selection); *where focus is* comes from
    /// the report, so the `focus` tool and the resource a subscriber re-reads
    /// can never disagree with the notification that sent them.
    fn with_report(mut self, report: &FocusReport) -> Self {
        self.window_has_focus = report.window_has_focus;
        self.focus_in = report.focus_in.clone();
        self.instance = report.instance.clone();
        self.pane = report.pane.clone();
        self.cluster = report.cluster.clone();
        self
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct PageApp {
    pub instance: Option<String>,
    pub focused: bool,
    pub visible: bool,
    pub report: Option<Value>,
}

/// What every window's page said, and why any of them did not.
#[derive(Debug, Clone, Default)]
pub(super) struct Pages {
    pub windows: Vec<(String, PageContext)>,
    pub errors: Vec<String>,
}

impl Pages {
    fn of(&self, window: &str) -> Option<&PageContext> {
        self.windows
            .iter()
            .find(|(l, _)| l == window)
            .map(|(_, p)| p)
    }
}

/// Ask every window. A window that will not answer costs its own entry and
/// nothing else, so one blocked webview does not blind the rest.
///
/// Where focus is comes from [`FocusState`]. A window whose probe fails still
/// answers from its report, with no app detail, rather than going missing.
pub(super) fn page_contexts(app: &AppHandle) -> Pages {
    let reports = app.state::<FocusState>();
    let mut pages = Pages::default();
    for label in devtools::window_labels(app) {
        let asked = super::ui::evaluate(
            app,
            Some(&label),
            &super::ui::script(FOCUS_BODY, &Value::Null),
        );
        let parsed = asked.and_then(|v| {
            let text = v.as_str().unwrap_or_default().to_string();
            serde_json::from_str::<PageContext>(&text)
                .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("the page's answer: {e}")))
        });
        let report = reports.report_for(&label);
        match (parsed, report) {
            (Ok(page), Some(report)) => pages.windows.push((label, page.with_report(&report))),
            (Ok(page), None) => pages.windows.push((label, page)),
            (Err(_), Some(report)) => pages
                .windows
                .push((label, PageContext::default().with_report(&report))),
            (Err(e), None) => pages.errors.push(format!("{label}: {}", e.message)),
        }
    }
    pages
}

/// One pane's tab, resolved against the flat instance and terminal lists.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Surface {
    pub instance: String,
    pub app: String,
    pub kind: &'static str,
    pub title: String,
    pub window: String,
    pub cluster: String,
    pub pane: String,
    pub active_tab: bool,
    pub focused: bool,
    pub visible: bool,
    pub report: Option<Value>,
}

impl Surface {
    /// The file or canvas the app says it is showing, if it says.
    pub fn file(&self) -> Option<String> {
        let report = self.report.as_ref()?;
        ["file", "path", "canvas"]
            .iter()
            .find_map(|k| report.get(*k).and_then(Value::as_str))
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }

    fn to_json(&self) -> Value {
        json!({
            "instance": self.instance,
            "app": self.app,
            "kind": self.kind,
            "title": self.title,
            "window": self.window,
            "cluster": self.cluster,
            "pane": self.pane,
            "activeTab": self.active_tab,
            "focused": self.focused,
            "visible": self.visible,
            "file": self.file(),
            "report": self.report,
        })
    }
}

fn kind_name(kind: SurfaceKind) -> &'static str {
    match kind {
        SurfaceKind::App => "app",
        SurfaceKind::Tool => "tool",
        SurfaceKind::Terminal => "terminal",
    }
}

/// Every leaf as `(pane id, tabs, active tab)`, in tree order.
fn leaves(node: &PaneNode) -> Vec<(&str, &[String], Option<&str>)> {
    match node {
        PaneNode::Leaf {
            id,
            tabs,
            active_tab,
        } => vec![(id.as_str(), tabs.as_slice(), active_tab.as_deref())],
        PaneNode::Split { children, .. } => children.iter().flat_map(leaves).collect(),
    }
}

/// The surface behind a tab id, from `instances` then `terminals`.
fn identify(snapshot: &ShellSnapshot, id: &str) -> Option<(String, &'static str, String)> {
    if let Some(i) = snapshot.instances.iter().find(|i| i.id == id) {
        return Some((i.app_id.clone(), kind_name(i.kind), i.title.clone()));
    }
    snapshot
        .terminals
        .iter()
        .find(|t| t.id == id)
        .map(|t| ("terminal".to_string(), "terminal", t.title.clone()))
}

pub(super) fn surfaces(snapshot: &ShellSnapshot, pages: &Pages) -> Vec<Surface> {
    let mut out = Vec::new();
    for window in &snapshot.windows {
        let page = pages.of(&window.label);
        for cluster in &window.clusters {
            let on_screen = window.active_cluster_id.as_deref() == Some(cluster.id.as_str());
            for (pane, tabs, active) in leaves(&cluster.tree) {
                for tab in tabs {
                    let Some((app, kind, title)) = identify(snapshot, tab) else {
                        continue;
                    };
                    let entry = page
                        .and_then(|p| p.apps.iter().find(|a| a.instance.as_deref() == Some(tab)));
                    let active_tab = active == Some(tab.as_str());
                    out.push(Surface {
                        instance: tab.clone(),
                        app,
                        kind,
                        title,
                        window: window.label.clone(),
                        cluster: cluster.id.clone(),
                        pane: pane.to_string(),
                        active_tab,
                        focused: page.is_some_and(|p| {
                            p.window_has_focus && p.instance.as_deref() == Some(tab)
                        }),
                        visible: entry.map_or(active_tab && on_screen, |a| a.visible),
                        report: entry.and_then(|a| a.report.clone()),
                    });
                }
            }
        }
    }
    out
}

/// The window and cluster the person is in: the window that has focus, else
/// `main`, else the first.
pub(super) fn active_cluster(snapshot: &ShellSnapshot, pages: &Pages) -> Option<(String, String)> {
    let focused = pages
        .windows
        .iter()
        .find(|(_, p)| p.window_has_focus)
        .and_then(|(label, _)| snapshot.windows.iter().find(|w| &w.label == label));
    let window = focused
        .or_else(|| snapshot.windows.iter().find(|w| w.label == "main"))
        .or_else(|| snapshot.windows.first())?;
    let cluster = window.active_cluster_id.clone()?;
    Some((window.label.clone(), cluster))
}

fn cluster_of<'a>(
    snapshot: &'a ShellSnapshot,
    id: &str,
) -> Option<(&'a WindowPlacement, &'a Cluster)> {
    snapshot
        .windows
        .iter()
        .find_map(|w| w.clusters.iter().find(|c| c.id == id).map(|c| (w, c)))
}

fn environment_json(cluster: &Cluster) -> Value {
    use crate::environments::Environment;
    match &cluster.environment {
        Some(Environment::Main) => json!({ "kind": "main", "readOnly": true }),
        Some(Environment::LocalWorktree { branch, base, .. }) => {
            json!({ "kind": "worktree", "branch": branch, "base": base, "readOnly": false })
        }
        Some(Environment::Design { branch, .. }) => {
            json!({ "kind": "design", "branch": branch, "readOnly": false })
        }
        Some(Environment::Cloud { branch, .. }) => {
            json!({ "kind": "cloud", "branch": branch, "readOnly": false })
        }
        None => Value::Null,
    }
}

/// The folder a cluster's files are read from: its environment's, else its
/// worktree's, else its project.
fn root_of(cluster: &Cluster) -> Option<String> {
    let project = cluster.project.as_deref().map(std::path::Path::new);
    cluster
        .environment
        .as_ref()
        .and_then(|e| e.root(project))
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(|| cluster.worktree.as_ref().map(|w| w.path.clone()))
        .or_else(|| cluster.project.clone())
}

fn cluster_json(cluster: &Cluster, active: bool) -> Value {
    json!({
        "id": cluster.id,
        "name": cluster.name,
        "active": active,
        "project": cluster.project,
        "root": root_of(cluster),
        "environment": environment_json(cluster),
    })
}

fn tree_json(node: &PaneNode, surfaces: &[Surface]) -> Value {
    match node {
        PaneNode::Split {
            id, dir, children, ..
        } => json!({
            "kind": "split",
            "id": id,
            "dir": dir,
            "children": children.iter().map(|c| tree_json(c, surfaces)).collect::<Vec<_>>(),
        }),
        PaneNode::Leaf {
            id,
            tabs,
            active_tab,
        } => json!({
            "kind": "pane",
            "id": id,
            "activeTab": active_tab,
            "tabs": tabs
                .iter()
                .filter_map(|t| surfaces.iter().find(|s| &s.instance == t))
                .map(Surface::to_json)
                .collect::<Vec<_>>(),
        }),
    }
}

pub(super) fn layout_view(snapshot: &ShellSnapshot, pages: &Pages) -> Value {
    let all = surfaces(snapshot, pages);
    let windows: Vec<Value> = snapshot
        .windows
        .iter()
        .map(|w| {
            let clusters: Vec<Value> = w
                .clusters
                .iter()
                .map(|c| {
                    let active = w.active_cluster_id.as_deref() == Some(c.id.as_str());
                    let mut row = cluster_json(c, active);
                    row["tree"] = tree_json(&c.tree, &all);
                    row["terminals"] = json!(snapshot
                        .terminals
                        .iter()
                        .filter(|t| t.cluster_id == c.id)
                        .map(|t| json!({
                            "id": t.id,
                            "title": t.title,
                            "active": c.active_terminal.as_deref() == Some(t.id.as_str()),
                        }))
                        .collect::<Vec<_>>());
                    row
                })
                .collect();
            json!({
                "label": w.label,
                "activeCluster": w.active_cluster_id,
                "page": w.right_page.as_ref().map(|p| p.id.clone()),
                "clusters": clusters,
            })
        })
        .collect();
    json!({ "windows": windows, "pageErrors": pages.errors })
}

pub(super) fn project_view(snapshot: &ShellSnapshot) -> Value {
    let mut clusters = Vec::new();
    for w in &snapshot.windows {
        for c in &w.clusters {
            let active = w.active_cluster_id.as_deref() == Some(c.id.as_str());
            let mut row = cluster_json(c, active);
            row["window"] = json!(w.label);
            clusters.push(row);
        }
    }
    json!({ "clusters": clusters })
}

pub(super) fn focus_view(snapshot: &ShellSnapshot, pages: &Pages) -> Value {
    let all = surfaces(snapshot, pages);
    let from_page = pages.windows.iter().find(|(_, p)| p.window_has_focus);
    let focus_in = from_page.map_or("unknown", |(_, p)| p.focus_in.as_str());

    let focused_surface = all.iter().find(|s| s.focused);
    let focused_other = from_page
        .and_then(|(_, p)| p.instance.as_deref())
        .filter(|_| focused_surface.is_none())
        .and_then(|id| identify(snapshot, id).map(|(app, kind, title)| (id, app, kind, title)));

    let located = active_cluster(snapshot, pages);
    let active = located.as_ref().and_then(|(_, cluster)| {
        cluster_of(snapshot, cluster).map(|(w, c)| {
            let mut row = cluster_json(c, true);
            row["window"] = json!(w.label);
            row
        })
    });

    let visible: Vec<Value> = all
        .iter()
        .filter(|s| s.visible && s.kind != "terminal")
        .filter(|s| located.as_ref().is_none_or(|(_, c)| &s.cluster == c))
        .map(Surface::to_json)
        .collect();

    let focused = match (focused_surface, focused_other) {
        (Some(s), _) => s.to_json(),
        (None, Some((id, app, kind, title))) => {
            json!({ "instance": id, "app": app, "kind": kind, "title": title })
        }
        _ => Value::Null,
    };

    let selected = from_page.map(|(_, p)| p.selected_text.clone());
    json!({
        "focusSource": if from_page.is_some() { "page" } else { "layout" },
        "windowHasFocus": from_page.is_some(),
        "focusIn": focus_in,
        "activePane": from_page.and_then(|(_, p)| p.pane.clone()),
        "focused": focused,
        "activeCluster": active,
        "visible": visible,
        "selectedText": selected,
        "selectedTextLength": from_page.map_or(0, |(_, p)| p.selected_text_length),
        "pageErrors": pages.errors,
        "hint": hint(focus_in, from_page.is_some()),
    })
}

fn hint(focus_in: &str, has_page: bool) -> &'static str {
    match (has_page, focus_in) {
        (false, _) => {
            "OpenKaava is not the foreground window (or no page answered), so `focused` is \
             empty. `visible` is each pane's active tab in the active cluster: the person's \
             last view."
        }
        (true, "terminal") => {
            "Focus is in a terminal, probably the one you run in. The person is most likely \
             talking about one of the `visible` apps beside it."
        }
        (true, "app") => "`focused` is the app the person is working in; its `file` is what they mean by \"this\".",
        _ => "Nothing app-level has focus; see `visible` for what is on screen.",
    }
}

#[cfg(test)]
pub(super) mod fixtures {
    use super::*;
    use crate::layout::SplitDir;
    use crate::shell_state::{Cluster, SurfaceInstance, TerminalSession, WindowPlacement};

    pub fn cluster(id: &str, project: Option<&str>, tree: PaneNode) -> Cluster {
        Cluster {
            id: id.to_string(),
            name: id.to_string(),
            tree,
            project: project.map(str::to_owned),
            worktree: None,
            active_terminal: None,
            band_height: Some(240.0),
            page: None,
            environment: None,
            pinned: false,
            environment_missing: false,
        }
    }

    pub fn leaf(id: &str, tabs: &[&str], active: Option<&str>) -> PaneNode {
        PaneNode::Leaf {
            id: id.to_string(),
            tabs: tabs.iter().map(|t| (*t).to_string()).collect(),
            active_tab: active.map(str::to_owned),
        }
    }

    /// One window, one active cluster: `canvas-1` and `canvas-2` side by side,
    /// and a terminal pane. A second cluster holds `canvas-3`.
    pub fn snapshot() -> ShellSnapshot {
        let tree = PaneNode::Split {
            id: "split-1".into(),
            dir: SplitDir::Row,
            sizes: vec![0.4, 0.3, 0.3],
            children: vec![
                leaf("pane-1", &["canvas-1"], Some("canvas-1")),
                leaf("pane-2", &["canvas-2"], Some("canvas-2")),
                leaf("pane-3", &["term-1"], Some("term-1")),
            ],
        };
        let instance = |id: &str, app: &str| SurfaceInstance {
            id: id.to_string(),
            app_id: app.to_string(),
            kind: SurfaceKind::App,
            title: id.to_string(),
        };
        ShellSnapshot {
            windows: vec![WindowPlacement {
                label: "main".into(),
                clusters: vec![
                    cluster("cluster-1", Some("C:/work/game"), tree),
                    cluster(
                        "cluster-2",
                        Some("C:/work/other"),
                        leaf("pane-9", &["canvas-3"], Some("canvas-3")),
                    ),
                ],
                active_cluster_id: Some("cluster-1".into()),
                geometry: None,
                right_page: None,
            }],
            instances: vec![
                instance("canvas-1", "canvas"),
                instance("canvas-2", "canvas"),
                instance("canvas-3", "canvas"),
            ],
            terminals: vec![TerminalSession {
                id: "term-1".into(),
                title: "claude".into(),
                cluster_id: "cluster-1".into(),
                agent_finished: false,
                group_id: None,
            }],
        }
    }

    pub fn page(window_has_focus: bool, instance: Option<&str>, focus_in: &str) -> PageContext {
        let app = |id: &str, canvas: &str, visible: bool| PageApp {
            instance: Some(id.to_string()),
            focused: instance == Some(id),
            visible,
            report: Some(
                json!({ "app": "canvas", "canvas": canvas, "elementIds": [], "diagram": null }),
            ),
        };
        PageContext {
            focus_in: focus_in.to_string(),
            instance: instance.map(str::to_owned),
            window_has_focus,
            apps: vec![
                app("canvas-1", "levels/one", true),
                app("canvas-2", "levels/two", true),
            ],
            selected_text: String::new(),
            selected_text_length: 0,
            pane: None,
            cluster: None,
        }
    }

    pub fn pages(page: PageContext) -> Pages {
        Pages {
            windows: vec![("main".to_string(), page)],
            errors: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn the_server_is_ordinary_and_read_only() {
        assert!(!SERVER.dev_only, "workspace ships to everyone");
        let names: Vec<&str> = SERVER.tools.iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["focus", "layout", "project"]);
        for tool in SERVER.tools {
            assert_eq!(
                super::super::read_only_hint("workspace", tool.name),
                Some(true),
                "{} must be advertised read-only",
                tool.name
            );
            let schema = (tool.schema)();
            assert_eq!(schema["type"], "object");
            assert_eq!(schema["additionalProperties"], false);
        }
    }

    #[test]
    fn focus_in_an_app_names_the_instance_pane_and_file() {
        let pages = pages(page(true, Some("canvas-2"), "app"));
        let out = focus_view(&snapshot(), &pages);
        assert_eq!(out["focusSource"], "page");
        assert_eq!(out["focusIn"], "app");
        assert_eq!(out["focused"]["instance"], "canvas-2");
        assert_eq!(out["focused"]["pane"], "pane-2");
        assert_eq!(out["focused"]["cluster"], "cluster-1");
        assert_eq!(out["focused"]["file"], "levels/two");
        assert_eq!(out["activeCluster"]["project"], "C:/work/game");
    }

    /// The common case: the agent's own terminal has focus, so the answer has to
    /// say that and still hand back the apps the person is looking at.
    #[test]
    fn focus_in_a_terminal_still_lists_the_visible_apps() {
        let pages = pages(page(true, Some("term-1"), "terminal"));
        let out = focus_view(&snapshot(), &pages);
        assert_eq!(out["focusIn"], "terminal");
        assert_eq!(out["focused"]["app"], "terminal");
        let visible: Vec<&str> = out["visible"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["instance"].as_str().unwrap())
            .collect();
        assert_eq!(visible, vec!["canvas-1", "canvas-2"]);
        assert!(out["hint"].as_str().unwrap().contains("terminal"));
    }

    #[test]
    fn without_a_page_focus_falls_back_to_the_active_tabs() {
        let out = focus_view(&snapshot(), &Pages::default());
        assert_eq!(out["focusSource"], "layout");
        assert_eq!(out["focused"], Value::Null);
        let visible = out["visible"].as_array().unwrap();
        assert_eq!(visible.len(), 2, "terminals are not listed as visible apps");
        assert!(visible.iter().all(|v| v["cluster"] == "cluster-1"));
    }

    #[test]
    fn layout_nests_panes_and_leaves_out_dev_internals() {
        let out = layout_view(&snapshot(), &pages(page(false, None, "nothing")));
        let window = &out["windows"][0];
        assert_eq!(window["activeCluster"], "cluster-1");
        let first = &window["clusters"][0];
        assert_eq!(first["tree"]["kind"], "split");
        assert_eq!(
            first["tree"]["children"][1]["tabs"][0]["file"],
            "levels/two"
        );
        assert_eq!(first["terminals"][0]["id"], "term-1");
        let text = out.to_string();
        assert!(
            !text.contains("bandHeight") && !text.contains("geometry"),
            "{text}"
        );
    }

    #[test]
    fn project_lists_every_cluster_with_its_folder() {
        let out = project_view(&snapshot());
        let clusters = out["clusters"].as_array().unwrap();
        assert_eq!(clusters.len(), 2);
        assert_eq!(clusters[0]["project"], "C:/work/game");
        assert_eq!(clusters[0]["active"], true);
        assert_eq!(clusters[1]["root"], "C:/work/other");
        assert_eq!(clusters[1]["active"], false);
    }

    fn report(window_has_focus: bool, instance: Option<&str>, focus_in: &str) -> FocusReport {
        FocusReport {
            window: "main".into(),
            window_has_focus,
            focus_in: focus_in.into(),
            instance: instance.map(str::to_owned),
            pane: Some("pane-2".into()),
            cluster: Some("cluster-1".into()),
        }
    }

    /// One source of truth: whatever the page probe saw, the stored report wins
    /// for who has focus, and the probe's app detail survives.
    #[test]
    fn a_report_overrides_the_probe_for_where_focus_is() {
        let probed = page(false, None, "nothing");
        let merged = probed.with_report(&report(true, Some("canvas-2"), "app"));
        let out = focus_view(&snapshot(), &pages(merged));

        assert_eq!(out["focusIn"], "app");
        assert_eq!(out["focused"]["instance"], "canvas-2");
        assert_eq!(out["activePane"], "pane-2");
        assert_eq!(
            out["focused"]["file"], "levels/two",
            "the app report from the probe is kept"
        );
    }

    /// A window whose probe fails still answers from its report.
    #[test]
    fn a_report_alone_is_enough_to_answer_focus() {
        let only = PageContext::default().with_report(&report(true, Some("term-1"), "terminal"));
        let out = focus_view(&snapshot(), &pages(only));

        assert_eq!(out["focusSource"], "page");
        assert_eq!(out["focusIn"], "terminal");
        assert_eq!(out["focused"]["app"], "terminal");
    }

    #[test]
    fn the_focus_resource_is_published_and_readable_as_json() {
        assert_eq!(RESOURCES.len(), 1);
        assert_eq!(RESOURCES[0].uri, FOCUS_URI);
        assert_eq!(RESOURCES[0].mime_type, "application/json");
        assert_eq!(super::super::resources(ID).len(), 1);
        assert!(super::super::resources("echo").is_empty());
    }

    #[test]
    fn the_active_cluster_follows_the_focused_window() {
        let found = active_cluster(&snapshot(), &Pages::default());
        assert_eq!(found, Some(("main".to_string(), "cluster-1".to_string())));
    }
}
