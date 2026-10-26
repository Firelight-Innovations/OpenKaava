//! Schematify's Rust half — the design layer of Veistra, registered like
//! Home and Files (`docs/design/SCHEMATIFY-PRD.md` §1.3). A thin JSON-RPC
//! layer over `schematify-core`: resolves a project root from
//! [`CallContext`], turns `params` into typed arguments, calls the crate,
//! and shapes the answer back into JSON — one dispatch function rather than
//! one `#[tauri::command]` per operation, matching `home.rs`/`files.rs`
//! (`docs/audits/schematify-baseline.md` §11).
//!
//! PRD §14.5 lists ten operations, wired to all ten, plus `schematify/state`
//! from wave 1a and `schematify/module-dashboard`/`schematify/runs` (wave
//! 9d's own additions) — `search` stays unwired. Wave 10c adds the product
//! layer's 5 writes ([`write_screen`], [`write_flow`], [`write_brief`],
//! [`write_decision`], [`supersede_decision`]) — see the last 2 for how
//! PRD §5.9's append-only rule is enforced here, not merely drawn.
//!
//! Decision SCH-API-003 puts an `actor` (`"human"` or `"agent"`) on every
//! operation. [`actor_param`] refuses a call that omits it, and never admits
//! `"system"` — PRD §7.2's `accepted → stale` actor, used only from inside
//! [`write_node`] by [`apply_stale_cascade`].

use std::fs;
use std::path::Path;

use crate::apps::CallContext;
use schematify_core::{
    contract_fields_changed, ingest_run_file, lint, load_project, stale_cascade, Actor, BudgetTier,
    CoreError, Decision, DecisionStatus, Edge, EdgeKind, Flow, Graph, Lifecycle, Node, NodeKind,
    ProjectBrief, Screen, Store, TestStatus, Uri, Uuid,
};
use serde_json::{json, Value};
use tauri::AppHandle;
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// What `schematify/state` reports.
///
/// `project` mirrors what [`CallContext`] resolved rather than anything
/// Schematify has read for itself — there is no `.veistra/` graph read yet, so
/// the one honest thing to say is *where* it would look once there is. `ready`
/// is the field the frontend keys its empty state off; it is `false` in every
/// build until a real Schematic surface lands behind it, at which point it
/// earns a second value rather than being deleted.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    project: Option<String>,
    ready: bool,
}

fn state(context: &CallContext) -> Result<Value, RpcError> {
    let state = State {
        project: context
            .project
            .as_ref()
            .map(|path| path.display().to_string()),
        ready: false,
    };

    serde_json::to_value(&state)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not answer: {e}")))
}

/// The method match, kept separate from [`call`] so it can be tested without an
/// `AppHandle`. Schematify reads nothing off the handle for any method below —
/// every one of them goes through [`CallContext`] and the filesystem — so
/// threading a live handle through a test would only be there to satisfy the
/// type and not because anything used it.
fn dispatch(context: &CallContext, method: &str, params: Option<Value>) -> Result<Value, RpcError> {
    match method {
        "schematify/state" => state(context),
        "schematify/open-project" => open_project(context, params.as_ref()),
        "schematify/load-graph" => load_graph(context, params.as_ref()),
        "schematify/write-node" => write_node(context, params.as_ref()),
        "schematify/write-edge" => write_edge(context, params.as_ref()),
        "schematify/write-layout" => write_layout(context, params.as_ref()),
        "schematify/read-layout" => read_layout(context, params.as_ref()),
        "schematify/lint" => lint_graph(context, params.as_ref()),
        "schematify/transition" => transition(context, params.as_ref()),
        "schematify/reconcile-status" => reconcile_status(context, params.as_ref()),
        "schematify/write-screen" => write_screen(context, params.as_ref()),
        "schematify/write-flow" => write_flow(context, params.as_ref()),
        "schematify/write-brief" => write_brief(context, params.as_ref()),
        "schematify/write-decision" => write_decision(context, params.as_ref()),
        "schematify/supersede-decision" => supersede_decision(context, params.as_ref()),
        "schematify/ingest-run" => ingest_run(context, params.as_ref()),
        "schematify/module-dashboard" => module_dashboard(context, params.as_ref()),
        "schematify/runs" => list_runs(context, params.as_ref()),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

/// Route one `invoke` from the Schematify app. See [`dispatch`] for the actual
/// matching.
pub fn call(
    _app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    dispatch(context, method, params)
}

// --- Shared parameter and context helpers -------------------------------

/// The project root this call's cluster is pointed at, or the refusal to hand
/// back. Every method below except `schematify/state` needs a real directory
/// to read or write against, and a defaulted root would silently point one
/// cluster's write at another's project.
fn require_project(context: &CallContext) -> Result<&Path, RpcError> {
    context.project.as_deref().ok_or_else(|| {
        RpcError::new(
            INTERNAL_ERROR,
            "no project is open in this cluster — open one in Home first",
        )
    })
}

/// The `actor` every one of these operations carries, per decision
/// SCH-API-003. Refused rather than defaulted: [`transition`]'s human-only
/// gate (PRD §7.3) reads exactly what this returns, and a defaulted actor
/// would make that gate meaningless. Every other method still requires it
/// and ignores the value past validation — every call has to say who it is.
fn actor_param(params: Option<&Value>) -> Result<&'static str, RpcError> {
    match params.and_then(|p| p.get("actor")).and_then(Value::as_str) {
        Some("human") => Ok("human"),
        Some("agent") => Ok("agent"),
        Some(other) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("actor must be \"human\" or \"agent\", got {other:?}"),
        )),
        None => Err(RpcError::new(INVALID_PARAMS, "actor is required")),
    }
}

/// A required string parameter, by field name.
fn string_param(params: Option<&Value>, field: &str) -> Result<String, RpcError> {
    match params.and_then(|p| p.get(field)).and_then(Value::as_str) {
        Some(text) if !text.is_empty() => Ok(text.to_owned()),
        Some(_) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("{field} must be a non-empty string"),
        )),
        None => Err(RpcError::new(
            INVALID_PARAMS,
            format!("{field} is required"),
        )),
    }
}

/// A required object-shaped parameter, by field name, deserialized into `T`.
fn typed_param<T: serde::de::DeserializeOwned>(
    params: Option<&Value>,
    field: &str,
) -> Result<T, RpcError> {
    let raw = params
        .and_then(|p| p.get(field))
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("{field} is required")))?;
    serde_json::from_value(raw.clone())
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("{field} is malformed: {e}")))
}

/// Every [`CoreError`] this file can hit is a filesystem or parse failure the
/// caller can only react to by reading the message, so all of them become
/// `-32603` here — the same rule `home.rs`'s own `rpc` helper states — with
/// one exception. [`CoreError::Lifecycle`] is [`transition`] and
/// [`apply_stale_cascade`] refusing the request itself (PRD §7.2's closed
/// table, and §7.3's human-only gate), not a server fault, so it maps to
/// `-32602` instead and carries whatever [`schematify_core::LifecycleError`]'s
/// `Display` states — `HumanOnly` names itself in the message, which is what
/// lets a caller tell "you may not" from "the disk failed" without matching
/// on a variant this module does not re-export.
fn core_rpc(error: CoreError) -> RpcError {
    if let CoreError::Lifecycle(lifecycle_error) = &error {
        return RpcError::new(INVALID_PARAMS, lifecycle_error.to_string());
    }
    // A caller's claimed starting lifecycle disagreeing with disk is a
    // client-caused refusal too - a stale snapshot or a forged `node`, never
    // a server fault - so it gets the same code as the table check above.
    if matches!(error, CoreError::StaleTransitionClaim { .. }) {
        return RpcError::new(INVALID_PARAMS, error.to_string());
    }
    RpcError::new(INTERNAL_ERROR, error.to_string())
}

// --- Methods --------------------------------------------------------------

/// `schematify/open-project`. Opens a project root and validates `.veistra/`
/// under it, per PRD §14.5. "Opens" is `CallContext` resolving the cluster's
/// project, already done before this function runs — what this method adds is
/// telling the caller whether that project actually holds a `.veistra/` tree,
/// so a frontend can offer to create one rather than fail load-graph with a
/// confusing error.
fn open_project(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let store = Store::open(root);
    let veistra_dir = store.veistra_dir();

    Ok(json!({
        "path": root.display().to_string(),
        "veistraDir": veistra_dir.display().to_string(),
        "exists": veistra_dir.is_dir(),
    }))
}

/// `schematify/load-graph`. Walks `.veistra/` and returns every semantic file it
/// found, alongside the validation report PRD §6.4 asks for. `Graph` itself
/// does not implement `Serialize` — it is an in-memory index, not a wire type
/// — so this shapes the answer by hand from its accessors rather than
/// serializing it directly, and the same is true of `Report`'s own contents
/// (`Quarantine`, `IdCollision`, and friends carry no `Serialize` either,
/// deliberately: `crates/schematify-core` is a library, not a wire protocol).
fn load_graph(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;

    let outcome = load_project(root).map_err(core_rpc)?;
    let graph = outcome.graph;
    let report = outcome.report;

    let nodes: Vec<&Node> = graph.nodes().collect();
    let edges: Vec<&Edge> = graph.edges().collect();

    let quarantined: Vec<Value> = report
        .quarantined
        .iter()
        .map(|q| {
            json!({
                "subject": q.subject,
                "field": q.field,
                "reference": q.reference,
                "reason": q.reason.as_str(),
                "file": q.file.display().to_string(),
            })
        })
        .collect();
    let unreadable: Vec<Value> = report
        .unreadable
        .iter()
        .map(|p| {
            json!({
                "file": p.file.display().to_string(),
                "error": p.error.to_string(),
            })
        })
        .collect();
    let slug_collisions: Vec<String> = report
        .slug_collisions
        .iter()
        .map(std::string::ToString::to_string)
        .collect();
    let id_collisions: Vec<Value> = report
        .id_collisions
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "kept": c.kept.display().to_string(),
                "discarded": c.discarded.display().to_string(),
            })
        })
        .collect();
    let misnamed: Vec<Value> = report
        .misnamed
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "file": m.file.display().to_string(),
            })
        })
        .collect();

    Ok(json!({
        "graph": {
            "nodes": nodes,
            "edges": edges,
            "screens": graph.screens().collect::<Vec<_>>(),
            "flows": graph.flows().collect::<Vec<_>>(),
            "decisions": graph.decisions().collect::<Vec<_>>(),
            "rules": graph.rules().collect::<Vec<_>>(),
            "libraries": graph.libraries(),
            "brief": graph.brief(),
        },
        "report": {
            "clean": report.is_clean(),
            "quarantined": quarantined,
            "unreadable": unreadable,
            "slugCollisions": slug_collisions,
            "idCollisions": id_collisions,
            "misnamed": misnamed,
            "durationMs": report.duration_ms,
        },
    }))
}

/// `schematify/write-node`. Writes exactly one node file, per PRD §6.1's
/// one-node-per-file rule. `params.node` is the whole node — envelope and
/// kind-specific fields flattened together, the same shape `Node` reads off
/// disk — so the frontend constructs it once rather than this handler
/// re-deriving fields it cannot know (a title, a slug, an `authored_by`).
///
/// PRD §7.4's staleness cascade fires from here rather than from
/// `schematify/transition`: a contract change is an edit to a
/// `contract-method`'s `signature`/`params`/`returns`/`errors` or a
/// service's `exports`, and those fields move through an ordinary node
/// write, not a lifecycle move — the node making the change need not itself
/// transition at all. [`apply_stale_cascade`] only runs when the write
/// actually changed a contract field, checked against the node's shape
/// immediately before this write landed.
fn write_node(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let node: Node = typed_param(params, "node")?;

    let store = Store::open(root);

    // Loaded before the write lands, so `contract_fields_changed` has both
    // shapes to compare and, if it fires, `stale_cascade` walks a graph
    // whose `depends_on` edges have not moved — a field edit never changes
    // containment or dependency edges, so the pre-write graph is still the
    // right one to find this node's dependents in.
    let before = load_project(root).map_err(core_rpc)?;
    let previous = before.graph.node(node.id()).cloned();
    let contract_changed =
        previous.is_some_and(|previous| contract_fields_changed(&previous, &node));

    // Checked and required before anything is written, not after: a missing
    // `at` must never leave the changed node's own file ahead of a cascade
    // that then could not run. An ordinary write that changes no contract
    // field never needs `at` at all.
    let at = contract_changed
        .then(|| string_param(params, "at"))
        .transpose()
        .map_err(|_| {
            RpcError::new(
                INVALID_PARAMS,
                "at is required when a write changes a contract field, to record when the staleness cascade fired",
            )
        })?;

    let path = store.node_path(node.id());
    store.write_node(&node).map_err(core_rpc)?;

    let staled = match at {
        Some(at) => apply_stale_cascade(&store, &before.graph, node.id(), &at)?,
        None => Vec::new(),
    };

    Ok(json!({ "id": node.id(), "path": path.display().to_string(), "staled": staled }))
}

/// PRD §7.4: a contract change on `changed` drops every `accepted` dependent
/// to `stale`, each carrying the [`schematify_core::Staleness`] mark the
/// caption draws from. The drop runs as [`Actor::System`] — the one actor
/// PRD §7.2's `accepted → stale` row names, never admitted from a client
/// (see [`actor_param`]) — through [`Store::write_transition`], so each drop
/// gets its own audit row like any other move.
///
/// `at` is an RFC 3339 timestamp for the cascade, trusted from the caller
/// the same way `node.created` is — `crates/schematify-core` has no clock of
/// its own. [`write_node`] validates its presence before this function runs.
///
/// A dependent's own write can still fail after an earlier one in the same
/// cascade already landed: `Store::write_transition` keeps one node's write
/// and its audit row atomic with each other (PRD §6.3), but names no
/// cross-node transaction, so this loop is best-effort across the *set* of
/// dependents. The changed node's own write has already committed either way.
fn apply_stale_cascade(
    store: &Store,
    graph: &Graph,
    changed: Uuid,
    at: &str,
) -> Result<Vec<Value>, RpcError> {
    let mut staled = Vec::new();
    for drop in stale_cascade(graph, changed, at) {
        let Some(mut dependent) = graph.node(drop.node).cloned() else {
            continue;
        };
        dependent.envelope.stale = Some(drop.staleness);
        let row = store
            .write_transition(
                &mut dependent,
                Lifecycle::Stale,
                Actor::System,
                "schematify",
                at,
                "An upstream contract changed.",
            )
            .map_err(core_rpc)?;
        staled.push(json!({ "node": dependent.id(), "audit": row }));
    }
    Ok(staled)
}

/// `schematify/write-edge`. Writes one edge file — unless it is a `contains`
/// edge, which `Store::write_edge` refuses to write at all, because
/// containment lives on the child node's `parent` field per PRD §4.1 and a
/// second copy in `edges/` would be a second truth. `stored: false` in the
/// response is how the frontend tells the two cases apart.
///
/// A `references_ui` edge additionally re-derives its source module's
/// `ui_refs` cache — decision SCH-ARC-006, PRD §5.11 — through
/// [`sync_ui_refs`]. This is the one edge kind PRD §5.11 names, and it fires
/// on every write of that kind: a new edge or a change to an existing one's
/// `superseded_by` both reach here with the same `source`, so `ui_refs`
/// never has a chance to drift the way `lint::ui_refs_cache_mismatch` (rule
/// L08) checks for.
fn write_edge(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let edge: Edge = typed_param(params, "edge")?;

    let store = Store::open(root);
    let stored = store.write_edge(&edge).map_err(core_rpc)?;
    let path = stored.then(|| store.edge_path(edge.id).display().to_string());

    let ui_refs_synced = stored && edge.kind == EdgeKind::ReferencesUi;
    if ui_refs_synced {
        sync_ui_refs(&store, root, edge.source)?;
    }

    Ok(json!({ "id": edge.id, "stored": stored, "path": path, "uiRefsSynced": ui_refs_synced }))
}

/// Re-derives one module's `ui_refs` cache from its live `references_ui`
/// edges and rewrites the node file if anything changed.
///
/// Mirrors `lint::ui_refs_cache_mismatch`'s own derivation exactly — every
/// *live* `references_ui` edge (`Edge::is_live`) whose `source` is `module`,
/// targets collected into a sorted, deduplicated list — so a project that
/// passes the linter's L08 check today keeps passing it after this call.
///
/// Silently does nothing when `module` does not resolve to a real
/// [`NodeKind::Module`] node: a dangling or misdirected edge source is
/// `load_project`'s and the linter's problem to report, not this sync's to
/// paper over by inventing a node.
fn sync_ui_refs(store: &Store, root: &Path, module: Uuid) -> Result<(), RpcError> {
    let outcome = load_project(root).map_err(core_rpc)?;
    let Some(node) = outcome.graph.node(module) else {
        return Ok(());
    };
    if *node.kind() != NodeKind::Module {
        return Ok(());
    }
    let Ok(mut fields) = node.module() else {
        return Ok(());
    };

    let mut refs: Vec<Uuid> = outcome
        .graph
        .edges()
        .filter(|e| e.kind == EdgeKind::ReferencesUi && e.is_live() && e.source == module)
        .map(|e| e.target)
        .collect();
    refs.sort_unstable();
    refs.dedup();
    let derived: Vec<Uri> = refs.into_iter().map(Uri::screen).collect();
    if fields.ui_refs == derived {
        return Ok(());
    }
    fields.ui_refs = derived;

    // Built from the loaded node rather than from `Node::new`, so that
    // `with_fields` overwrites `ui_refs` on top of the map that was on disk
    // instead of replacing it. A module node may legally carry keys
    // `ModuleFields` does not model — PRD §11.2 registers kinds this build has
    // never seen, and `Node::fields` is an open map precisely so a round trip
    // through this crate cannot drop them. Rebuilding from an empty envelope
    // would delete every one of them as a side effect of caching a screen
    // reference.
    let updated = node
        .clone()
        .with_fields(&fields)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not shape ui_refs: {e}")))?;
    store.write_node(&updated).map_err(core_rpc)
}

/// `schematify/write-layout`. Writes `layout/<slug>.json` and nothing else —
/// the enforcement point for PRD §6.2: a node drag must never dirty a
/// semantic file.
///
/// This does **not** go through `schematify_core::Layout`/`Placement`. That
/// pair models positions alone (PRD §5.10's minimal reading), while
/// `apps/schematify/ui/src/graph/layout.ts`'s `LayoutFile` — what wave 3's
/// engine actually reads and writes — also carries a `version`, a combined
/// `viewport`, and whole `LayoutAnnotation` records (title, author, body) for
/// groups and comments that `Placement` has nowhere to put. Re-shaping the
/// frontend's file to fit the narrower crate type would lose the annotation
/// tier on every write; re-widening the crate type is a wave 3/crate
/// decision, not this wave's to make silently. So this handler writes
/// whatever JSON object the frontend sends, verbatim, through the same atomic
/// writer `Store` itself uses, at the same path `Store::layout_path` computes
/// — honest about the mismatch rather than papering over it. See the wiring
/// handoff for the record of this decision.
fn write_layout(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let slug = string_param(params, "slug")?;
    let layout = params
        .and_then(|p| p.get("layout"))
        .filter(|v| v.is_object())
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "layout must be an object"))?;

    let store = Store::open(root);
    let path = store.layout_path(&slug);
    schematify_core::write_json_atomic(&path, layout)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;

    Ok(json!({ "path": path.display().to_string() }))
}

/// `schematify/read-layout`. The read half of the pair above: `null` when the
/// Schematic has no layout file yet (the first-run state PRD §12.20 draws,
/// not an error), otherwise the raw JSON object last written by
/// `schematify/write-layout`.
///
/// Not one of PRD §14.5's ten named operations — the table lists a writer for
/// every layer but no reader for the cosmetic one, which would leave
/// `openSchematic` (`apps/schematify/ui/src/engine/index.ts`) with a write-only
/// seam. `docs/overnight-jobs/overnight-2/00-AGENT-CONTEXT.md` says to pick the
/// simplest reading where a source is silent and continue; a Schematic that
/// can save a layout but never load one back is not a smaller version of PRD
/// §12.3, it is a different, broken one.
fn read_layout(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let slug = string_param(params, "slug")?;

    let store = Store::open(root);
    read_json_object_or_null(&store.layout_path(&slug))
}

/// A JSON object read verbatim from `path`, or `Value::Null` when the file
/// does not exist — the first-run state every caller of this helper treats
/// as ordinary rather than an error. Shared by `read_layout` and
/// `reconcile_status`: both read a file this crate defines the *location*
/// of but not, for this app's purposes, a typed shape to deserialize into
/// (see `write_layout`'s doc comment for why, and the wiring handoff for
/// `reconcile.json` specifically — its true on-disk shape is
/// `schematify-reconcile`'s own `NodeReconcileFile`, not
/// `schematify_core::ReconcileResult`, so reading it as anything but raw
/// JSON would be guessing which of two live shapes is the real one).
fn read_json_object_or_null(path: &std::path::Path) -> Result<Value, RpcError> {
    if !path.is_file() {
        return Ok(Value::Null);
    }

    let text = fs::read_to_string(path).map_err(|source| {
        core_rpc(CoreError::Io {
            path: path.to_path_buf(),
            source,
        })
    })?;
    let value: Value = serde_json::from_str(&text).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("{} does not hold valid JSON: {e}", path.display()),
        )
    })?;

    if !value.is_object() {
        return Err(RpcError::new(
            INTERNAL_ERROR,
            format!("{} does not hold a JSON object", path.display()),
        ));
    }

    Ok(value)
}

/// `schematify/transition`. Applies one lifecycle move and appends one row
/// to `runs/<node-uuid>/audit.json` — the pair PRD §6.3 allows as a single
/// write. `params.node` carries the same shape `schematify/write-node`'s
/// does, but this handler is not `write-node`'s second entry point:
/// `Store::write_transition` treats `node` as untrusted past its id, reads
/// the real node from disk, and checks `node.lifecycle` only as the
/// caller's *claim* of where the transition starts — refused outright on
/// disagreement (a stale client, or a forged one). See its doc comment for
/// what is and is not persisted. `node` in the response below is the real,
/// disk-sourced node `Store::write_transition` wrote, not the caller's copy.
///
/// PRD §7.3's human-only gate is enforced here by construction, not by a
/// special case in this function: [`actor_param`] admits only `"human"` or
/// `"agent"` from a client, never `"system"`, and `Store::write_transition`
/// calls `check_transition` before writing anything, so an agent asking for
/// `reviewed → accepted` (or `stale → accepted`) is refused — nothing is
/// written, and [`core_rpc`]'s special case for
/// [`schematify_core::CoreError::Lifecycle`] carries the reason back as a
/// stated error rather than a silent no-op.
fn transition(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    let actor_str = actor_param(params)?;
    let root = require_project(context)?;
    let mut node: Node = typed_param(params, "node")?;
    let to: Lifecycle = typed_param(params, "to")?;
    let actor_name = string_param(params, "actorName")?;
    let at = string_param(params, "at")?;
    let reason = string_param(params, "reason")?;

    let actor = match actor_str {
        "human" => Actor::Human,
        "agent" => Actor::Agent,
        other => {
            return Err(RpcError::new(
                INTERNAL_ERROR,
                format!("actor_param admitted an actor this match does not handle: {other}"),
            ))
        }
    };

    let store = Store::open(root);
    let row = store
        .write_transition(&mut node, to, actor, &actor_name, &at, &reason)
        .map_err(core_rpc)?;

    Ok(json!({ "node": node, "audit": row }))
}

/// `schematify/lint`. Loads the project and runs `schematify_core::lint`
/// over the graph it built, returning the whole `LintReport` — findings,
/// sorted errors-then-warnings, and the 4 input counts a test (or a status
/// bar) can check the run actually walked something. `Finding` and its
/// `Location` are fully `Serialize`, unlike `Graph`/`Report` in
/// `load_graph`, so this needs no hand-shaping.
fn lint_graph(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let outcome = load_project(root).map_err(core_rpc)?;
    let report = lint(&outcome.graph);

    serde_json::to_value(&report).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not shape the lint report: {e}"),
        )
    })
}

/// `schematify/reconcile-status`. Reads `runs/<node-uuid>/reconcile.json`
/// verbatim (see `read_json_object_or_null`), or `null` when the node has
/// never been reconciled. `node` is required and must parse as a UUID —
/// `schematify-reconcile` names the directory by the node's identifier, not
/// its slug, so a caller supplies the same `node.id` `load-graph` returned.
fn reconcile_status(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let node = string_param(params, "node")?;
    let node_id = Uuid::parse_str(&node)
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("node must be a UUID: {e}")))?;

    let store = Store::open(root);
    let path = store
        .veistra_dir()
        .join("runs")
        .join(node_id.to_string())
        .join("reconcile.json");
    read_json_object_or_null(&path)
}

// --- The product layer: screens, flows, the brief, and the decision log ---

/// `schematify/write-screen`. Writes one screen file (PRD §5.7). A screen
/// carries no append-only rule — PRD §12.17 draws a per-screen editor with
/// no such restriction, unlike the decision log — so this upserts by id,
/// the same shape as `write_node`.
fn write_screen(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let screen: Screen = typed_param(params, "screen")?;

    let store = Store::open(root);
    let path = store.screen_path(screen.id);
    store.write_screen(&screen).map_err(core_rpc)?;

    Ok(json!({ "id": screen.id, "path": path.display().to_string() }))
}

/// `schematify/write-flow`. Writes one flow file (PRD §5.8). Freely
/// editable, the same reasoning as `write_screen`.
fn write_flow(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let flow: Flow = typed_param(params, "flow")?;

    let store = Store::open(root);
    let path = store.flow_path(flow.id);
    store.write_flow(&flow).map_err(core_rpc)?;

    Ok(json!({ "id": flow.id, "path": path.display().to_string() }))
}

/// `schematify/write-brief`. Writes `brief.json` (PRD §5.12) — the one
/// semantic file addressed by no UUID, so a caller supplies no id and this
/// method always writes the same path.
fn write_brief(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let brief: ProjectBrief = typed_param(params, "brief")?;

    let store = Store::open(root);
    let path = store.brief_path();
    store.write_brief(&brief).map_err(core_rpc)?;

    Ok(json!({ "path": path.display().to_string() }))
}

/// `schematify/write-decision`. Creates exactly one new, standing decision
/// row — never a second write to an existing one. PRD §5.9: "Schematify
/// shall never edit a decision row in place." A disabled edit control (PRD
/// §12.18) proves nothing about a JSON-RPC caller, so the refusal lives
/// here: a payload naming an id that already has a file is refused outright,
/// and so is a payload that arrives already claiming a supersession — the
/// only door to `SUPERSEDED` is `schematify/supersede_decision` below, which
/// is also the only method allowed to touch a second, existing file.
fn write_decision(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let decision: Decision = typed_param(params, "decision")?;

    if decision.status != DecisionStatus::Active
        || decision.supersedes.is_some()
        || decision.superseded_by.is_some()
    {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "a new decision must be active and name no supersession — use schematify/supersede-decision to replace one",
        ));
    }

    let store = Store::open(root);
    let path = store.decision_path(decision.id);
    if path.is_file() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "a decision row already exists at this id and cannot be edited in place",
        ));
    }

    store.write_decision(&decision).map_err(core_rpc)?;
    Ok(json!({ "id": decision.id, "path": path.display().to_string() }))
}

/// `schematify/supersede-decision`. The one path PRD §5.9's "a change adds a
/// new row and marks the prior row `SUPERSEDED`" reaches. Writes a brand new
/// decision (the same pre-conditions as `write_decision`, plus the server —
/// never the caller — deciding its `supersedes`/`superseded_by`), then
/// rewrites the prior row from the copy already on disk, changing only
/// `status` and `superseded_by`. A caller cannot smuggle a changed title,
/// context, decision, consequences or date onto the prior row through this
/// method: every other field on it comes back off the file that was already
/// there, never off the request body.
///
/// The successor is written before the prior row is updated. A failure
/// between the two leaves two `ACTIVE` rows rather than a `SUPERSEDED` row
/// whose `superseded_by` names a file that was never written — the second
/// shape is `Decision::is_superseded_without_successor`, a condition the
/// linter already reports (PRD §5.9's rule L07); the first is not, and is
/// also the state a retried call heals on its own.
fn supersede_decision(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let prior_id = string_param(params, "priorId")?;
    let prior_id = Uuid::parse_str(&prior_id)
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("priorId must be a UUID: {e}")))?;
    let mut successor: Decision = typed_param(params, "decision")?;

    let store = Store::open(root);
    let prior_path = store.decision_path(prior_id);
    let prior_text = fs::read_to_string(&prior_path).map_err(|_| {
        RpcError::new(
            INVALID_PARAMS,
            format!("no decision row exists at {prior_id} to supersede"),
        )
    })?;
    let mut prior: Decision = serde_json::from_str(&prior_text).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!(
                "{} does not hold a valid decision: {e}",
                prior_path.display()
            ),
        )
    })?;
    if prior.status != DecisionStatus::Active {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("decision {prior_id} is already superseded and cannot be superseded again"),
        ));
    }

    // The server decides the successor's own supersession fields, never the
    // caller — a payload naming a different `supersedes`, or one already
    // claiming `superseded_by`, is overwritten rather than trusted, since
    // trusting it would let a client point a new row at the wrong prior
    // decision or fabricate a chain that never happened.
    successor.status = DecisionStatus::Active;
    successor.supersedes = Some(prior_id);
    successor.superseded_by = None;
    if successor.id == prior_id {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "a successor decision needs its own id, distinct from the row it supersedes",
        ));
    }
    let successor_path = store.decision_path(successor.id);
    if successor_path.is_file() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "a decision row already exists at this id and cannot be edited in place",
        ));
    }

    // Only these 2 fields move on the prior row. Everything else — title,
    // context, decision, consequences, date, supersedes — is the value
    // already on disk, read above, never the caller's payload.
    prior.status = DecisionStatus::Superseded;
    prior.superseded_by = Some(successor.id);

    store.write_decision(&successor).map_err(core_rpc)?;
    store.write_decision(&prior).map_err(core_rpc)?;

    Ok(json!({
        "id": successor.id,
        "path": successor_path.display().to_string(),
        "priorId": prior_id,
        "priorPath": prior_path.display().to_string(),
    }))
}

/// `schematify/ingest-run`. The Tauri wiring for wave 9b's
/// `schematify_core::ingest_run_file` (`crates/schematify-core/src/ingest.rs`;
/// see `docs/overnight-jobs/overnight-2/handoffs/w9b-runs.md`), and PRD §8's
/// "Schematify ingests the artifact into `runs/` and draws it." `module` is
/// the scope wave 9b's own doc comment names: the node whose CI workflow
/// produced the run, not a budget node itself, since one workflow answers
/// several budgets in one file. `path` is wherever CI dropped the
/// `veistra-bench-v1` artifact, outside `.veistra/` — Schematify never invokes
/// the probe that produced it, only reads what it wrote.
fn ingest_run(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let module = string_param(params, "module")?;
    let scope = Uuid::parse_str(&module)
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("module must be a UUID: {e}")))?;
    let path = string_param(params, "path")?;

    let outcome = load_project(root).map_err(core_rpc)?;
    let store = Store::open(root);
    ingest_run_file(&outcome.graph, &store, scope, Path::new(&path)).map_err(core_rpc)?;

    Ok(json!({ "module": scope, "ingested": true }))
}

/// `schematify/runs`. S-14, PRD §12.2: "Run number, timestamp, commit,
/// workflow file, ingest state" for the Runs dock tab. Undrawn by any
/// wireframe screen, so this reads the simplest project-wide shape: every
/// run under every node, newest first — the same "whole project, not one
/// tier" scope the Problems panel already draws (wave 7b). A run's presence
/// here is its ingest state: `ingest_run_file` refuses anything that fails
/// its checks before it ever reaches disk, so every row this call returns
/// already reads `Ingested` — there is no "pending" state this crate models.
fn list_runs(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let outcome = load_project(root).map_err(core_rpc)?;
    let graph = &outcome.graph;

    let mut rows: Vec<Value> = Vec::new();
    for node in graph.nodes() {
        for run in graph.runs(node.id()) {
            rows.push(json!({
                "module": {
                    "id": node.id(),
                    "title": node.envelope.title,
                    "slug": node.envelope.slug.as_str(),
                },
                "run": run.run,
                "at": run.at,
                "commit": run.commit,
                "workflow": run.workflow,
            }));
        }
    }
    rows.sort_by(|a, b| {
        let a_at = a["at"].as_str().unwrap_or_default();
        let b_at = b["at"].as_str().unwrap_or_default();
        b_at.cmp(a_at)
    });

    Ok(json!({ "runs": rows }))
}

/// `schematify/module-dashboard`. Shapes PRD §12.13's Module dashboard: 5
/// counters, the budget history, the reconciliation table, and the lifecycle
/// audit log. `module` is a module node's id, the same value `load-graph`
/// hands back on `nodes[].id`. Every field below is read fresh off the graph
/// and the module's own run/audit history on each call — PRD §0.4 forbids
/// storing a count, and this function is where that rule is kept for the
/// dashboard specifically, the same way `lint_graph` keeps it for Problems.
///
/// An id that resolves to a real node of any other kind is refused rather
/// than drawn as a module — this dashboard's counters and history are
/// scoped by `NodeKind::Module` semantics (children, budgets, tests), and
/// silently applying that scope to a service or a leaf node produces
/// numbers that answer nothing real. The slug lookup below already carried
/// this rule; this doc note is the id path catching up to it.
///
/// Contract change history (the dashboard's 4th table) is not shaped here.
/// No schema in this crate records a per-method change log — `AuditRow`
/// records a lifecycle *transition*, not the contract edit that motivated
/// one — so there is nothing on the graph for this function to compute from.
/// See the wave 9d handoff for the recorded gap.
fn module_dashboard(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    actor_param(params)?;
    let root = require_project(context)?;
    let module = string_param(params, "module")?;

    let outcome = load_project(root).map_err(core_rpc)?;
    let graph = &outcome.graph;

    // `module` accepts either a node id or a slug. A UUID is what
    // `load-graph` hands back on `nodes[].id`, the ordinary case once the
    // Module Schematic loads real graph data; a slug is what the Module
    // Schematic's own stand-in engine (`apps/schematify/ui/src/graph/module.ts`
    // — the pre-existing gap wave 7b's handoff §6 item 3 already recorded)
    // can offer today, since it never learned the real backend's uuids. Both
    // resolve to the same node here rather than making the frontend carry a
    // 2nd lookup call before it can even open the dashboard.
    let module_id = match Uuid::parse_str(&module) {
        Ok(id) => id,
        Err(_) => graph
            .nodes()
            .find(|n| *n.kind() == NodeKind::Module && n.envelope.slug.as_str() == module)
            .map(Node::id)
            .ok_or_else(|| {
                RpcError::new(
                    INVALID_PARAMS,
                    format!("no module node with slug {module:?}"),
                )
            })?,
    };
    let node = graph
        .node(module_id)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("no node with id {module_id}")))?;
    if *node.kind() != NodeKind::Module {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("{module_id} is a {}, not a module", node.kind()),
        ));
    }
    let store = Store::open(root);

    // Budgets and tests are graph state — a probe declaration or a linked
    // test status does not wait for a run to be true, so neither is read off
    // `latest_run` below.
    let children: Vec<&Node> = graph
        .children(module_id)
        .iter()
        .filter_map(|&id| graph.node(id))
        .collect();

    let budgets: Vec<(&Node, schematify_core::BudgetFields)> = children
        .iter()
        .filter(|n| *n.kind() == NodeKind::Budget)
        .filter_map(|n| n.budget().ok().map(|fields| (*n, fields)))
        .collect();
    let budgets_with_probe = budgets.iter().filter(|(_, f)| f.probe.is_some()).count();
    let hard_missing_probe = budgets
        .iter()
        .filter(|(_, f)| f.probe.is_none() && f.tier == BudgetTier::Hard)
        .count();

    let tests: Vec<schematify_core::TestCaseFields> = children
        .iter()
        .filter(|n| *n.kind() == NodeKind::TestCase)
        .filter_map(|n| n.test_case().ok())
        .collect();
    let tests_passing = tests
        .iter()
        .filter(|t| t.status == TestStatus::Passing)
        .count();
    let tests_failing = tests
        .iter()
        .filter(|t| t.status == TestStatus::Failing)
        .count();
    let tests_unlinked = tests
        .iter()
        .filter(|t| t.status == TestStatus::Declared)
        .count();

    // `LATEST RUN` per PRD §12.13: the highest run number ingested under this
    // module. `Graph::runs` is empty on a module CI has never run.
    let latest_run = graph.runs(module_id).iter().max_by_key(|run| run.run);

    let budget_history: Vec<Value> = budgets
        .iter()
        .map(|(_, fields)| {
            let measured =
                latest_run.and_then(|run| run.budgets.iter().find(|b| b.metric == fields.metric));
            json!({
                "metric": fields.metric,
                "tier": fields.tier,
                "op": fields.op,
                "threshold": fields.value,
                "unit": fields.unit,
                "hasProbe": fields.probe.is_some(),
                "probeCommand": fields.probe.as_ref().map(|p| p.command.clone()),
                "latestValue": measured.map(|m| m.value),
                "pass": measured.map(|m| m.pass),
                "signOff": fields.sign_off,
            })
        })
        .collect();

    // The reconciliation counters are the latest run's own summary (PRD
    // §5.10, §9.2) — a run artifact is the one place those 4 numbers are
    // recorded. The `SITE` cell is not: no run field carries where a marker
    // was found, only how many, so `reconciliation_sites` reads the
    // `reconcile.json` `veistra reconcile` writes per node (PRD §9.3) for the
    // module and its direct facet children — the same "direct children of
    // scope" boundary wave 9b's own `ingest_run` drew for budgets.
    let reconcile_scope: Vec<Uuid> = std::iter::once(module_id)
        .chain(children.iter().map(|n| n.id()))
        .collect();
    let titles: std::collections::HashMap<Uuid, &str> = std::iter::once(node)
        .chain(children.iter().copied())
        .map(|n| (n.id(), n.envelope.title.as_str()))
        .collect();
    let reconciliation_rows = reconciliation_rows(
        &store,
        &reconcile_scope,
        &titles,
        latest_run.and_then(|run| run.reconcile),
    );

    let audit_log: Vec<Value> = graph
        .audit(module_id)
        .iter()
        .rev()
        .take(5)
        .map(|row| {
            json!({
                "when": row.at,
                "from": row.from,
                "to": row.to,
                "actor": row.actor.as_str(),
                "actorName": row.actor_name,
                "reason": row.reason,
            })
        })
        .collect();

    Ok(json!({
        "module": {
            "id": node.id(),
            "title": node.envelope.title,
            "slug": node.envelope.slug.as_str(),
        },
        "runsPath": format!("runs/{}/", elide_uuid(module_id)),
        "latestRun": latest_run.map(|run| json!({
            "run": run.run,
            "at": run.at,
            "commit": run.commit,
            "workflow": run.workflow,
        })),
        "budgets": {
            "withProbe": budgets_with_probe,
            "total": budgets.len(),
            "hardMissingProbe": hard_missing_probe,
        },
        "tests": {
            "passing": tests_passing,
            "total": tests.len(),
            "failing": tests_failing,
            "unlinked": tests_unlinked,
        },
        "linter": latest_run.and_then(|run| run.linter).map(|l| json!({
            "rules": l.rules,
            "violations": l.violations,
        })),
        "reconciliation": latest_run.and_then(|run| run.reconcile).map(|r| json!({
            "matched": r.matched,
            "declaredAbsent": r.declared_absent,
            "presentUnknown": r.present_unknown,
            "duplicate": r.duplicate,
        })),
        "reconciliationRows": reconciliation_rows,
        "budgetHistory": budget_history,
        "auditLog": audit_log,
    }))
}

/// `0192f4a1-…-a7b8` from a full uuid — PRD §12.13's own elision, for the
/// `runsPath` header line.
fn elide_uuid(id: Uuid) -> String {
    let text = id.to_string();
    let (first, rest) = text.split_once('-').unwrap_or((text.as_str(), ""));
    let last = rest.rsplit('-').next().unwrap_or(rest);
    format!("{first}-\u{2026}-{last}")
}

/// One row of the Reconciliation table: PRD §9.2's drawn outcome name, a
/// `SITE` cell, the count, and whether the 2 independent sources behind
/// them disagree.
///
/// `count` and `site` are never reconciled against each other — §3 of the
/// wave 9d handoff explains why (a run can legitimately land before
/// `veistra reconcile` has caught up, or the reverse) — but a caller still
/// needs to *see* a disagreement rather than have it pass silently, per PRD
/// §12.1's "Errors first · never hidden." `count_mismatch` is that signal:
/// `true` when the number of `reconcile.json` entries this scope's own
/// `outcome_kind` walk actually found disagrees with what the run artifact
/// declared for it.
struct ReconcileRow {
    outcome: &'static str,
    site: String,
    count: u32,
    count_mismatch: bool,
}

impl ReconcileRow {
    fn to_value(&self) -> Value {
        json!({
            "outcome": self.outcome,
            "site": self.site,
            "count": self.count,
            "countMismatch": self.count_mismatch,
        })
    }
}

/// Reads `runs/<id>/reconcile.json` for every id in `scope` (raw JSON, same
/// convention `reconcile_status` uses — see `read_json_object_or_null`'s own
/// doc comment for why this crate does not type it against
/// `schematify-reconcile`'s shape), groups the outcomes it finds by kind, and
/// builds the 4 rows PRD §12.13 draws. `counts` is the latest run's own
/// summary — see `module_dashboard`'s doc comment for why the count and the
/// site text come from two different sources. A count with nothing behind it
/// (no `reconcile.json` on disk yet, the ordinary state for a project that
/// has never run `veistra reconcile`) draws `—`, not a guess.
fn reconciliation_rows(
    store: &Store,
    scope: &[Uuid],
    titles: &std::collections::HashMap<Uuid, &str>,
    counts: Option<schematify_core::ReconcileResult>,
) -> Vec<Value> {
    let mut matched_sites: Vec<String> = Vec::new();
    let mut absent_sites: Vec<String> = Vec::new();
    let mut unknown_sites: Vec<String> = Vec::new();
    let mut duplicate_sites: Vec<String> = Vec::new();

    // The reconciled node's own title, not `reconcile.json`'s own `slug`
    // field — a contract method's slug is kebab-case
    // (`schematify_core::Slug`'s own rule) but PRD §16.1's drawn form
    // (`skew_window — no marker`) is the method's call name, which is what
    // `NodeEnvelope::title` holds for a `contract-method` node. Falls back to
    // the file's own `slug` for a node this dashboard's own graph walk never
    // loaded (should not happen for `scope`, built from the same graph).
    let title_of = |value: &Value| -> String {
        value
            .get("node_id")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok())
            .and_then(|id| titles.get(&id).copied())
            .map(str::to_owned)
            .or_else(|| value.get("slug").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default()
    };

    for &id in scope {
        let path = store
            .veistra_dir()
            .join("runs")
            .join(id.to_string())
            .join("reconcile.json");
        let Ok(value) = read_json_object_or_null(&path) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        match value.get("outcome").and_then(Value::as_str) {
            Some("matched") => {
                if let Some(file) = value
                    .get("site")
                    .and_then(|s| s.get("file"))
                    .and_then(Value::as_str)
                {
                    matched_sites.push(file.to_owned());
                }
            }
            Some("declared_absent") => {
                absent_sites.push(format!("{} — no marker", title_of(&value)));
            }
            Some("present_unknown") => {
                if let Some(file) = value
                    .get("site")
                    .and_then(|s| s.get("file"))
                    .and_then(Value::as_str)
                {
                    unknown_sites.push(file.to_owned());
                }
            }
            Some("duplicate") => {
                duplicate_sites.push(title_of(&value));
            }
            _ => {}
        }
    }

    let counts = counts.unwrap_or_default();
    vec![
        ReconcileRow {
            outcome: "matched",
            site: first_and_overflow(&matched_sites),
            count: counts.matched,
            count_mismatch: matched_sites.len() as u32 != counts.matched,
        }
        .to_value(),
        ReconcileRow {
            outcome: "declared, absent",
            site: first_and_overflow(&absent_sites),
            count: counts.declared_absent,
            count_mismatch: absent_sites.len() as u32 != counts.declared_absent,
        }
        .to_value(),
        ReconcileRow {
            outcome: "present, unknown",
            site: first_and_overflow(&unknown_sites),
            count: counts.present_unknown,
            count_mismatch: unknown_sites.len() as u32 != counts.present_unknown,
        }
        .to_value(),
        ReconcileRow {
            outcome: "duplicate",
            site: first_and_overflow(&duplicate_sites),
            count: counts.duplicate,
            count_mismatch: duplicate_sites.len() as u32 != counts.duplicate,
        }
        .to_value(),
    ]
}

/// PRD §12.13's `SITE` cell form: `src/auth/verifier.ts +3 more`, deduplicated
/// so 7 matches inside 4 files draw as 1 name and 3 more, not 6. `—` when
/// `sites` is empty.
fn first_and_overflow(sites: &[String]) -> String {
    let mut distinct: Vec<&String> = Vec::new();
    for site in sites {
        if !distinct.contains(&site) {
            distinct.push(site);
        }
    }
    match distinct.split_first() {
        None => "—".to_owned(),
        Some((first, [])) => (*first).clone(),
        Some((first, rest)) => format!("{first} +{} more", rest.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// `CARGO_MANIFEST_DIR`, preferring the value Cargo puts in the
    /// environment of a test binary it launches over the one baked in at
    /// compile time.
    ///
    /// Several worktrees sharing one `CARGO_TARGET_DIR` (a deliberate
    /// convention for agents working this repo) hold identical sources, so
    /// Cargo can reuse a test binary compiled in a worktree that has since
    /// been removed, carrying that worktree's absolute path. Reading the
    /// environment first avoids resolving fixtures against a directory that
    /// no longer exists; the check below catches the rarer case where a
    /// stale binary somehow still ran, and names the problem instead of
    /// leaving a bare `NotFound` for the next agent to puzzle over.
    fn manifest_dir() -> PathBuf {
        let dir = PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR")
                .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string()),
        );
        assert!(
            dir.is_dir(),
            "CARGO_MANIFEST_DIR resolved to {}, which does not exist -- this looks like a \
             stale cross-worktree build (a test binary compiled in a worktree that has \
             since been removed and reused from a shared CARGO_TARGET_DIR); rerun \
             `cargo test` from this worktree to force a rebuild",
            dir.display()
        );
        dir
    }

    /// A temp directory that cleans itself up, following `apps/files.rs` and
    /// `project/marker.rs` — these tests are about what a real filesystem
    /// does (atomic writes, directory creation), and a fake one would only be
    /// testing the fake.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let dir = std::env::temp_dir().join(format!("veistra-schematify-{tag}-{stamp}"));
            fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn context_at(root: &Path) -> CallContext {
        CallContext {
            cluster_id: Some("cluster-1".to_string()),
            project: Some(root.to_path_buf()),
        }
    }

    #[test]
    fn state_reports_the_resolved_project_and_is_honestly_not_ready() {
        let context = CallContext {
            cluster_id: Some("cluster-1".to_string()),
            project: Some(PathBuf::from("/repo")),
        };

        let value =
            dispatch(&context, "schematify/state", None).expect("schematify/state does not fail");
        assert_eq!(value["ready"], false);
        assert_eq!(value["project"], "/repo");
    }

    #[test]
    fn state_reports_no_project_as_null_rather_than_guessing() {
        let context = CallContext::default();
        let value = dispatch(&context, "schematify/state", None)
            .expect("schematify/state does not fail with no project");
        assert!(value["project"].is_null());
    }

    #[test]
    fn an_unknown_method_is_method_not_found() {
        let context = CallContext::default();
        let err =
            dispatch(&context, "schematify/nonesuch", None).expect_err("unknown method is refused");
        assert_eq!(err.code, METHOD_NOT_FOUND);
    }

    #[test]
    fn every_method_below_state_refuses_a_missing_actor() {
        let context = CallContext::default();
        for method in [
            "schematify/open-project",
            "schematify/load-graph",
            "schematify/write-node",
            "schematify/write-edge",
            "schematify/write-layout",
            "schematify/read-layout",
            "schematify/lint",
            "schematify/transition",
            "schematify/reconcile-status",
            "schematify/write-screen",
            "schematify/write-flow",
            "schematify/write-brief",
            "schematify/write-decision",
            "schematify/supersede-decision",
            "schematify/ingest-run",
            "schematify/module-dashboard",
            "schematify/runs",
        ] {
            let err = dispatch(&context, method, Some(json!({})))
                .expect_err(&format!("{method} requires an actor"));
            assert_eq!(err.code, INVALID_PARAMS, "method: {method}");
        }
    }

    #[test]
    fn every_method_below_state_refuses_a_call_with_no_open_project() {
        let context = CallContext::default();
        for method in [
            "schematify/open-project",
            "schematify/load-graph",
            "schematify/write-node",
            "schematify/write-edge",
            "schematify/write-layout",
            "schematify/read-layout",
            "schematify/lint",
            "schematify/transition",
            "schematify/reconcile-status",
            "schematify/write-screen",
            "schematify/write-flow",
            "schematify/write-brief",
            "schematify/write-decision",
            "schematify/supersede-decision",
            "schematify/ingest-run",
            "schematify/module-dashboard",
            "schematify/runs",
        ] {
            let err = dispatch(&context, method, Some(json!({ "actor": "human" })))
                .expect_err(&format!("{method} requires an open project"));
            assert_eq!(err.code, INTERNAL_ERROR, "method: {method}");
        }
    }

    #[test]
    fn open_project_reports_whether_veistra_exists() {
        let dir = TempDir::new("open-project");
        let context = context_at(dir.path());

        let before = dispatch(
            &context,
            "schematify/open-project",
            Some(json!({ "actor": "human" })),
        )
        .expect("open-project does not fail on a bare directory");
        assert_eq!(before["exists"], false);

        Store::open(dir.path()).init().expect("init succeeds");

        let after = dispatch(
            &context,
            "schematify/open-project",
            Some(json!({ "actor": "agent" })),
        )
        .expect("open-project does not fail once .veistra exists");
        assert_eq!(after["exists"], true);
    }

    #[test]
    fn load_graph_refuses_a_project_with_no_veistra_directory() {
        let dir = TempDir::new("load-graph-no-veistra");
        let context = context_at(dir.path());

        let err = dispatch(
            &context,
            "schematify/load-graph",
            Some(json!({ "actor": "human" })),
        )
        .expect_err("no .veistra directory is a refusal, not an empty graph");
        assert_eq!(err.code, INTERNAL_ERROR);
    }

    #[test]
    fn load_graph_returns_the_node_this_wave_wrote_and_a_clean_report() {
        let dir = TempDir::new("load-graph-clean");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let node = sample_service_node();
        store.write_node(&node).expect("seed write succeeds");

        let value = dispatch(
            &context,
            "schematify/load-graph",
            Some(json!({ "actor": "human" })),
        )
        .expect("load-graph succeeds against a real .veistra directory");

        let nodes = value["graph"]["nodes"]
            .as_array()
            .expect("nodes is an array");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["id"], node.id().to_string());
        assert_eq!(value["report"]["clean"], true);
    }

    #[test]
    fn write_node_writes_the_content_a_reader_gets_back() {
        let dir = TempDir::new("write-node");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let node = sample_service_node();
        let params = json!({ "actor": "human", "node": node });

        dispatch(&context, "schematify/write-node", Some(params)).expect("write-node succeeds");

        let path = Store::open(dir.path()).node_path(node.id());
        let text = fs::read_to_string(path).expect("the node file exists");
        let written: Node = serde_json::from_str(&text).expect("the file parses as a node");
        assert_eq!(written.envelope.title, "Auth Service");
        assert_eq!(written.envelope.slug.as_str(), "auth-service");
    }

    /// A minimal module envelope, for tests that build a small dependency
    /// graph by hand rather than reaching for `sample_service_node`'s one
    /// fixed shape. Mirrors the `module` closure `lint_reports_a_dependency_
    /// cycle_it_was_given` already uses below.
    fn sample_module(slug: &str, lifecycle: Lifecycle, parent: Option<Uuid>) -> Node {
        use schematify_core::{Authorship, NodeEnvelope, NodeKind, Slug};

        Node::new(NodeEnvelope {
            id: schematify_core::mint_id(),
            slug: Slug::new(slug).expect("legal slug"),
            kind: NodeKind::Module,
            title: slug.to_string(),
            description: None,
            lifecycle,
            layer: None,
            parent,
            decisions: Vec::new(),
            authored_by: Authorship::Human,
            created: "2026-09-03T00:00:00Z".to_string(),
            superseded_by: None,
            stale: None,
        })
    }

    /// A `contract-method` facet, for the same tests. `fields` lets each test
    /// build the "before" and "after" shape `contract_fields_changed` compares
    /// without repeating the whole envelope.
    fn sample_contract_method(
        slug: &str,
        parent: Uuid,
        fields: &schematify_core::ContractMethodFields,
    ) -> Node {
        use schematify_core::{Authorship, NodeEnvelope, NodeKind, Slug};

        Node::new(NodeEnvelope {
            id: schematify_core::mint_id(),
            slug: Slug::new(slug).expect("legal slug"),
            kind: NodeKind::ContractMethod,
            title: slug.to_string(),
            description: None,
            lifecycle: Lifecycle::Accepted,
            layer: None,
            parent: Some(parent),
            decisions: Vec::new(),
            authored_by: Authorship::Human,
            created: "2026-09-03T00:00:00Z".to_string(),
            superseded_by: None,
            stale: None,
        })
        .with_fields(fields)
        .expect("contract-method fields attach")
    }

    /// PRD §7.4, exercised through the RPC boundary rather than
    /// `schematify_core::stale_cascade` directly: `token-issuer` depends on
    /// `crypto-primitives` and is `accepted`; `rate-limiter` depends on the
    /// same module but is `draft`. Changing `sign`'s `params` through
    /// `schematify/write-node` should drop the first to `stale`, with an
    /// audit row, and leave the second exactly where it was.
    #[test]
    fn write_node_stales_an_accepted_dependent_when_a_contract_field_changes() {
        use schematify_core::{ContractMethodFields, EdgeKind};

        let dir = TempDir::new("write-node-cascade");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let crypto = sample_module("crypto-primitives", Lifecycle::Accepted, None);
        let token_issuer = sample_module("token-issuer", Lifecycle::Accepted, None);
        let rate_limiter = sample_module("rate-limiter", Lifecycle::Draft, None);
        for m in [&crypto, &token_issuer, &rate_limiter] {
            store.write_node(m).expect("seed module");
        }
        store
            .write_edge(&Edge::new(
                schematify_core::mint_id(),
                EdgeKind::DependsOn,
                token_issuer.id(),
                crypto.id(),
                "2026-09-03T00:00:00Z",
            ))
            .expect("seed token-issuer -> crypto-primitives");
        store
            .write_edge(&Edge::new(
                schematify_core::mint_id(),
                EdgeKind::DependsOn,
                rate_limiter.id(),
                crypto.id(),
                "2026-09-03T00:00:00Z",
            ))
            .expect("seed rate-limiter -> crypto-primitives");

        let before_fields = ContractMethodFields {
            signature: "sign(bytes: Bytes)".to_owned(),
            params: vec!["bytes: Bytes".to_owned()],
            returns: Some("Signature".to_owned()),
            errors: vec!["SignError".to_owned()],
            semantics: Some("Signs the payload.".to_owned()),
            exported: true,
        };
        let sign = sample_contract_method("sign", crypto.id(), &before_fields);
        store.write_node(&sign).expect("seed sign");

        let mut after_fields = before_fields;
        after_fields.params.push("kid: Kid".to_owned());
        let changed_sign = Node::new(sign.envelope.clone())
            .with_fields(&after_fields)
            .expect("changed fields attach");

        let value = dispatch(
            &context,
            "schematify/write-node",
            Some(json!({
                "actor": "human",
                "node": changed_sign,
                "at": "2026-09-03T12:00:00Z",
            })),
        )
        .expect("write-node succeeds and the cascade runs");

        let staled = value["staled"].as_array().expect("staled is an array");
        assert_eq!(
            staled.len(),
            1,
            "only the accepted dependent goes stale: {staled:?}"
        );
        assert_eq!(staled[0]["node"], token_issuer.id().to_string());
        assert_eq!(staled[0]["audit"]["from"], "accepted");
        assert_eq!(staled[0]["audit"]["to"], "stale");
        assert_eq!(staled[0]["audit"]["actor"], "system");

        let written: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(token_issuer.id()))
                .expect("the dependent's file exists"),
        )
        .expect("the file parses as a node");
        assert_eq!(written.envelope.lifecycle, Lifecycle::Stale);
        let staleness = written
            .envelope
            .stale
            .expect("the dependent carries why it is stale");
        assert_eq!(staleness.source, crypto.id());
        assert_eq!(staleness.member.as_deref(), Some("sign"));
        assert_eq!(staleness.at, "2026-09-03T12:00:00Z");

        let untouched: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(rate_limiter.id()))
                .expect("the draft dependent's file exists"),
        )
        .expect("the file parses as a node");
        assert_eq!(
            untouched.envelope.lifecycle,
            Lifecycle::Draft,
            "a draft dependent is not staled"
        );
    }

    #[test]
    fn write_node_does_not_cascade_when_nothing_but_a_comment_changed() {
        use schematify_core::ContractMethodFields;

        let dir = TempDir::new("write-node-no-cascade");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let crypto = sample_module("crypto-primitives", Lifecycle::Accepted, None);
        store.write_node(&crypto).expect("seed module");

        let fields = ContractMethodFields {
            signature: "sign(bytes: Bytes)".to_owned(),
            params: vec!["bytes: Bytes".to_owned()],
            returns: Some("Signature".to_owned()),
            errors: vec!["SignError".to_owned()],
            semantics: Some("Signs the payload.".to_owned()),
            exported: true,
        };
        let sign = sample_contract_method("sign", crypto.id(), &fields);
        store.write_node(&sign).expect("seed sign");

        // Same contract fields, a retitled node — `contract_fields_changed`
        // does not count this, per its own doc comment, so no `at` is
        // required and the cascade never runs.
        let mut retitled_envelope = sign.envelope.clone();
        retitled_envelope.title = "Sign the payload".to_string();
        let retitled = Node::new(retitled_envelope)
            .with_fields(&fields)
            .expect("fields attach");

        let value = dispatch(
            &context,
            "schematify/write-node",
            Some(json!({ "actor": "human", "node": retitled })),
        )
        .expect("write-node succeeds with no `at` supplied");

        assert_eq!(
            value["staled"].as_array().expect("array"),
            &Vec::<Value>::new()
        );
    }

    #[test]
    fn write_node_refuses_a_contract_change_with_no_at_and_writes_nothing() {
        use schematify_core::ContractMethodFields;

        let dir = TempDir::new("write-node-missing-at");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let crypto = sample_module("crypto-primitives", Lifecycle::Accepted, None);
        store.write_node(&crypto).expect("seed module");

        let before_fields = ContractMethodFields {
            signature: "sign(bytes: Bytes)".to_owned(),
            params: vec!["bytes: Bytes".to_owned()],
            returns: Some("Signature".to_owned()),
            errors: vec!["SignError".to_owned()],
            semantics: Some("Signs the payload.".to_owned()),
            exported: true,
        };
        let sign = sample_contract_method("sign", crypto.id(), &before_fields);
        store.write_node(&sign).expect("seed sign");

        let mut after_fields = before_fields;
        after_fields.params.push("kid: Kid".to_owned());
        let changed_sign = Node::new(sign.envelope.clone())
            .with_fields(&after_fields)
            .expect("changed fields attach");

        let err = dispatch(
            &context,
            "schematify/write-node",
            Some(json!({ "actor": "human", "node": changed_sign })),
        )
        .expect_err("a contract change with no `at` is refused");
        assert_eq!(err.code, INVALID_PARAMS);

        // Refused before the write, not after: the file on disk still holds
        // the original params, not the changed ones.
        let on_disk: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(sign.id())).expect("the original file exists"),
        )
        .expect("the file parses as a node");
        let on_disk_fields = on_disk
            .contract_method()
            .expect("the file parses as a contract method");
        assert_eq!(on_disk_fields.params, vec!["bytes: Bytes".to_owned()]);
    }

    #[test]
    fn write_edge_reports_a_contains_edge_as_not_stored() {
        let dir = TempDir::new("write-edge-contains");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let edge = Edge::new(
            schematify_core::mint_id(),
            schematify_core::EdgeKind::Contains,
            schematify_core::mint_id(),
            schematify_core::mint_id(),
            "2026-09-03T00:00:00Z",
        );
        let params = json!({ "actor": "agent", "edge": edge });

        let value =
            dispatch(&context, "schematify/write-edge", Some(params)).expect("write-edge succeeds");
        assert_eq!(value["stored"], false);
        assert!(value["path"].is_null());
    }

    #[test]
    fn write_edge_writes_the_content_a_reader_gets_back() {
        let dir = TempDir::new("write-edge-stored");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let edge = Edge::new(
            schematify_core::mint_id(),
            schematify_core::EdgeKind::DependsOn,
            schematify_core::mint_id(),
            schematify_core::mint_id(),
            "2026-09-03T00:00:00Z",
        );
        let params = json!({ "actor": "human", "edge": edge });

        let value =
            dispatch(&context, "schematify/write-edge", Some(params)).expect("write-edge succeeds");
        assert_eq!(value["stored"], true);

        let path = Store::open(dir.path()).edge_path(edge.id);
        let text = fs::read_to_string(path).expect("the edge file exists");
        let written: Edge = serde_json::from_str(&text).expect("the file parses as an edge");
        assert_eq!(written.id, edge.id);
        assert_eq!(written.kind, schematify_core::EdgeKind::DependsOn);
    }

    /// A screen, shared by the product-layer write tests and the `ui_refs`
    /// sync tests. The slug is a parameter because the sync tests need two
    /// distinct screens to prove the cache is rebuilt from the whole live edge
    /// set rather than appended to. `backed_by` is left empty — the reverse
    /// direction (a screen naming its backing modules) is not part of what
    /// `sync_ui_refs` derives.
    fn sample_screen(slug: &str) -> Screen {
        use schematify_core::{mint_id, ScreenKind, Slug};

        Screen {
            id: mint_id(),
            kind: ScreenKind::default(),
            slug: Slug::new(slug).expect("legal slug"),
            title: "Login form".to_owned(),
            purpose: "Collects credentials and starts a session.".to_owned(),
            states: vec!["empty".to_owned(), "locked".to_owned()],
            acceptance: vec!["A locked account shall show the recovery path.".to_owned()],
            design_ref: None,
            backed_by: Vec::new(),
        }
    }

    /// Decision SCH-ARC-006 / PRD §5.11: writing a `references_ui` edge
    /// re-derives the source module's `ui_refs` cache, not just the edge
    /// file. Two screens, added one write at a time, prove the cache is
    /// rebuilt from the whole live edge set rather than merely appended to.
    #[test]
    fn write_edge_syncs_ui_refs_when_a_references_ui_edge_is_written() {
        let dir = TempDir::new("write-edge-ui-refs-sync");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let module = sample_module("login-form-backend", Lifecycle::Draft, None);
        store.write_node(&module).expect("seed module");
        let screen_a = sample_screen("login-form");
        let screen_b = sample_screen("recovery-form");
        store.write_screen(&screen_a).expect("seed screen a");
        store.write_screen(&screen_b).expect("seed screen b");

        let edge_a = Edge::new(
            schematify_core::mint_id(),
            EdgeKind::ReferencesUi,
            module.id(),
            screen_a.id,
            "2026-09-03T00:00:00Z",
        );
        let value = dispatch(
            &context,
            "schematify/write-edge",
            Some(json!({ "actor": "human", "edge": edge_a })),
        )
        .expect("write-edge succeeds");
        assert_eq!(value["uiRefsSynced"], true);

        let after_first: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(module.id())).expect("module file exists"),
        )
        .expect("parses as a node");
        let fields_after_first = after_first.module().expect("parses as module fields");
        assert_eq!(
            fields_after_first.ui_refs,
            vec![schematify_core::Uri::screen(screen_a.id)],
            "the first reference lands in the cache"
        );

        let edge_b = Edge::new(
            schematify_core::mint_id(),
            EdgeKind::ReferencesUi,
            module.id(),
            screen_b.id,
            "2026-09-03T00:05:00Z",
        );
        dispatch(
            &context,
            "schematify/write-edge",
            Some(json!({ "actor": "agent", "edge": edge_b })),
        )
        .expect("second write-edge succeeds");

        let after_second: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(module.id())).expect("module file exists"),
        )
        .expect("parses as a node");
        let mut refs = after_second
            .module()
            .expect("parses as module fields")
            .ui_refs;
        refs.sort_unstable();
        let mut expected = vec![
            schematify_core::Uri::screen(screen_a.id),
            schematify_core::Uri::screen(screen_b.id),
        ];
        expected.sort_unstable();
        assert_eq!(
            refs, expected,
            "the cache holds both live references, not just the one just written"
        );
    }

    /// The other half of "every edge change": superseding a `references_ui`
    /// edge drops its screen out of the cache, because `sync_ui_refs` reads
    /// only *live* edges (`Edge::is_live`).
    ///
    /// The mid-test assertion that the reference is *present* before it is
    /// superseded is load-bearing, not decoration. Without it the closing
    /// `is_empty` holds trivially in a build where the sync never runs at all,
    /// and the test passes while proving nothing — which is exactly what it did
    /// before this assertion was added.
    #[test]
    fn write_edge_drops_a_superseded_reference_from_ui_refs() {
        let dir = TempDir::new("write-edge-ui-refs-supersede");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let module = sample_module("login-form-backend", Lifecycle::Draft, None);
        store.write_node(&module).expect("seed module");
        let screen = sample_screen("login-form");
        store.write_screen(&screen).expect("seed screen");

        let mut edge = Edge::new(
            schematify_core::mint_id(),
            EdgeKind::ReferencesUi,
            module.id(),
            screen.id,
            "2026-09-03T00:00:00Z",
        );
        dispatch(
            &context,
            "schematify/write-edge",
            Some(json!({ "actor": "human", "edge": edge })),
        )
        .expect("first write-edge succeeds");

        let while_live: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(module.id())).expect("module file exists"),
        )
        .expect("parses as a node");
        assert_eq!(
            while_live
                .module()
                .expect("parses as module fields")
                .ui_refs,
            vec![schematify_core::Uri::screen(screen.id)],
            "the reference is in the cache while its edge is live"
        );

        edge.superseded_by = Some(schematify_core::mint_id());
        dispatch(
            &context,
            "schematify/write-edge",
            Some(json!({ "actor": "human", "edge": edge })),
        )
        .expect("superseding write-edge succeeds");

        let after: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(module.id())).expect("module file exists"),
        )
        .expect("parses as a node");
        assert!(
            after
                .module()
                .expect("parses as module fields")
                .ui_refs
                .is_empty(),
            "a superseded reference is not live, so it drops out of the cache"
        );
    }

    /// The sync fires on `references_ui` and on nothing else. `a` is seeded
    /// with a cache already in it and then made the *source* of a `depends_on`
    /// edge, so a sync that ignored `kind` would derive an empty reference set
    /// for `a` and wipe that cache. Asserting the surviving cache, not only the
    /// `uiRefsSynced` flag: the flag is computed from `edge.kind` in
    /// [`write_edge`] itself and would still read `false` with the call to
    /// [`sync_ui_refs`] deleted outright.
    #[test]
    fn write_edge_does_not_touch_ui_refs_for_a_non_references_ui_edge() {
        let dir = TempDir::new("write-edge-ui-refs-unrelated");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let screen = sample_screen("login-form");
        store.write_screen(&screen).expect("seed screen");
        let mut a = sample_module("a", Lifecycle::Draft, None);
        a = a
            .with_fields(&schematify_core::ModuleFields {
                allowed_libraries: Vec::new(),
                ui_refs: vec![schematify_core::Uri::screen(screen.id)],
            })
            .expect("module fields shape");
        let b = sample_module("b", Lifecycle::Draft, None);
        store.write_node(&a).expect("seed a");
        store.write_node(&b).expect("seed b");

        let edge = Edge::new(
            schematify_core::mint_id(),
            EdgeKind::DependsOn,
            a.id(),
            b.id(),
            "2026-09-03T00:00:00Z",
        );
        let value = dispatch(
            &context,
            "schematify/write-edge",
            Some(json!({ "actor": "human", "edge": edge })),
        )
        .expect("write-edge succeeds");
        assert_eq!(value["uiRefsSynced"], false);

        let after: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(a.id())).expect("module file exists"),
        )
        .expect("parses as a node");
        assert_eq!(
            after.module().expect("parses as module fields").ui_refs,
            vec![schematify_core::Uri::screen(screen.id)],
            "an unrelated edge write leaves the cache exactly as it found it"
        );
    }

    /// A module node may carry keys `ModuleFields` does not model — PRD §11.2
    /// registers kinds this build has never seen, and `Node::fields` is an open
    /// map so that a round trip cannot drop them. The sync rewrites the node
    /// file, so it is the round trip most able to lose them: it must overwrite
    /// `ui_refs` on the map that was on disk, not rebuild the map from the two
    /// fields it happens to know about.
    #[test]
    fn write_edge_keeps_module_fields_the_sync_does_not_model() {
        let dir = TempDir::new("write-edge-ui-refs-unmodelled");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let mut module = sample_module("login-form-backend", Lifecycle::Draft, None);
        module.fields.insert(
            "runbook".to_string(),
            json!("https://example.invalid/runbook"),
        );
        store.write_node(&module).expect("seed module");
        let screen = sample_screen("login-form");
        store.write_screen(&screen).expect("seed screen");

        let edge = Edge::new(
            schematify_core::mint_id(),
            EdgeKind::ReferencesUi,
            module.id(),
            screen.id,
            "2026-09-03T00:00:00Z",
        );
        dispatch(
            &context,
            "schematify/write-edge",
            Some(json!({ "actor": "human", "edge": edge })),
        )
        .expect("write-edge succeeds");

        let after: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(module.id())).expect("module file exists"),
        )
        .expect("parses as a node");
        assert_eq!(
            after.module().expect("parses as module fields").ui_refs,
            vec![schematify_core::Uri::screen(screen.id)],
            "the cache is still written"
        );
        assert_eq!(
            after.fields.get("runbook"),
            Some(&json!("https://example.invalid/runbook")),
            "caching a screen reference does not delete a field this build does not model"
        );
    }

    #[test]
    fn write_layout_then_read_layout_round_trips_the_exact_content_sent() {
        let dir = TempDir::new("write-layout-roundtrip");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        // Shaped like `apps/schematify/ui/src/graph/layout.ts`'s `LayoutFile`
        // — a `version`, a combined `viewport`, and an annotation carrying a
        // `body` string, none of which `schematify_core::Layout` can hold.
        let layout = json!({
            "version": 1,
            "schematic": "auth-service",
            "nodes": { "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8": { "x": 10.0, "y": 20.0, "width": 240.0, "height": 120.0 } },
            "annotations": [{
                "id": "g1", "kind": "group", "slug": "core", "title": "Core",
                "parentId": null, "author": "human", "body": "why this group exists",
                "x": 0.0, "y": 0.0, "width": 600.0, "height": 400.0,
            }],
            "viewport": { "x": 0.0, "y": 0.0, "zoom": 0.68 },
        });

        dispatch(
            &context,
            "schematify/write-layout",
            Some(json!({ "actor": "human", "slug": "auth-service", "layout": layout })),
        )
        .expect("write-layout succeeds");

        let read = dispatch(
            &context,
            "schematify/read-layout",
            Some(json!({ "actor": "agent", "slug": "auth-service" })),
        )
        .expect("read-layout succeeds");

        assert_eq!(
            read, layout,
            "the annotation's body and the combined viewport both survive"
        );
    }

    #[test]
    fn read_layout_reports_null_for_a_schematic_never_written() {
        let dir = TempDir::new("read-layout-null");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let value = dispatch(
            &context,
            "schematify/read-layout",
            Some(json!({ "actor": "human", "slug": "never-opened" })),
        )
        .expect("read-layout does not fail on a missing file");
        assert!(value.is_null());
    }

    #[test]
    fn lint_reports_a_dependency_cycle_it_was_given() {
        use schematify_core::{Authorship, EdgeKind, Lifecycle, NodeEnvelope, NodeKind, Slug};

        let dir = TempDir::new("lint-cycle");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let module = |slug: &str| {
            Node::new(NodeEnvelope {
                id: schematify_core::mint_id(),
                slug: Slug::new(slug).expect("legal slug"),
                kind: NodeKind::Module,
                title: slug.to_string(),
                description: None,
                lifecycle: Lifecycle::Draft,
                layer: None,
                parent: None,
                decisions: Vec::new(),
                authored_by: Authorship::Human,
                created: "2026-09-03T00:00:00Z".to_string(),
                superseded_by: None,
                stale: None,
            })
        };
        let a = module("a");
        let b = module("b");
        store.write_node(&a).expect("write a");
        store.write_node(&b).expect("write b");
        store
            .write_edge(&Edge::new(
                schematify_core::mint_id(),
                EdgeKind::DependsOn,
                a.id(),
                b.id(),
                "2026-09-03T00:00:00Z",
            ))
            .expect("write a->b");
        store
            .write_edge(&Edge::new(
                schematify_core::mint_id(),
                EdgeKind::DependsOn,
                b.id(),
                a.id(),
                "2026-09-03T00:00:00Z",
            ))
            .expect("write b->a");

        let value = dispatch(
            &context,
            "schematify/lint",
            Some(json!({ "actor": "human" })),
        )
        .expect("lint succeeds");

        assert_eq!(value["nodes"], 2);
        assert_eq!(value["edges"], 2);
        assert_eq!(value["rules"], schematify_core::RULE_COUNT);
        let findings = value["findings"].as_array().expect("findings is an array");
        assert!(
            findings.iter().any(|f| f["rule"] == "L02"),
            "the a<->b cycle should draw an L02 row: {findings:?}"
        );
    }

    #[test]
    fn lint_reports_no_findings_over_an_empty_project() {
        let dir = TempDir::new("lint-clean");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let value = dispatch(
            &context,
            "schematify/lint",
            Some(json!({ "actor": "agent" })),
        )
        .expect("lint succeeds over an empty project");
        assert_eq!(
            value["findings"].as_array().expect("array"),
            &Vec::<Value>::new()
        );
        assert_eq!(value["nodes"], 0);
    }

    #[test]
    fn reconcile_status_reports_null_for_a_node_never_reconciled() {
        let dir = TempDir::new("reconcile-null");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());
        let node = schematify_core::mint_id();

        let value = dispatch(
            &context,
            "schematify/reconcile-status",
            Some(json!({ "actor": "human", "node": node.to_string() })),
        )
        .expect("reconcile-status does not fail on a missing file");
        assert!(value.is_null());
    }

    #[test]
    fn reconcile_status_reads_the_reconcile_json_a_reconcile_run_wrote() {
        let dir = TempDir::new("reconcile-read");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());
        let node = schematify_core::mint_id();

        // A stand-in shape, not `schematify-reconcile`'s real
        // `NodeReconcileFile` (`crates/schematify-reconcile/src/report.rs`)
        // — this test is about the raw-JSON round trip `reconcile_status`
        // promises, which does not depend on the payload's real fields any
        // more than `write_layout_then_read_layout_round_trips` did.
        let dir_path = dir
            .path()
            .join(".veistra")
            .join("runs")
            .join(node.to_string());
        fs::create_dir_all(&dir_path).expect("runs dir");
        let payload = json!({
            "schema": "veistra-reconcile-v1",
            "at": "2026-09-03T00:00:00Z",
            "outcome": "matched",
        });
        fs::write(dir_path.join("reconcile.json"), payload.to_string())
            .expect("seed reconcile.json");

        let value = dispatch(
            &context,
            "schematify/reconcile-status",
            Some(json!({ "actor": "human", "node": node.to_string() })),
        )
        .expect("reconcile-status succeeds");
        assert_eq!(value, payload);
    }

    #[test]
    fn reconcile_status_refuses_a_node_that_is_not_a_uuid() {
        let dir = TempDir::new("reconcile-bad-uuid");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let err = dispatch(
            &context,
            "schematify/reconcile-status",
            Some(json!({ "actor": "human", "node": "not-a-uuid" })),
        )
        .expect_err("a malformed node id is refused");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn transition_moves_a_node_and_appends_the_audit_row_a_reader_gets_back() {
        let dir = TempDir::new("transition-legal");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let node = sample_module("crypto-primitives", Lifecycle::Draft, None);
        store.write_node(&node).expect("seed the node");

        let value = dispatch(
            &context,
            "schematify/transition",
            Some(json!({
                "actor": "human",
                "node": node,
                "to": "specified",
                "actorName": "m.ross",
                "at": "2026-09-03T12:00:00Z",
                "reason": "The author completed the node.",
            })),
        )
        .expect("a legal human transition succeeds");

        assert_eq!(value["node"]["lifecycle"], "specified");
        assert_eq!(value["audit"]["from"], "draft");
        assert_eq!(value["audit"]["to"], "specified");
        assert_eq!(value["audit"]["actor"], "human");
        assert_eq!(value["audit"]["actor_name"], "m.ross");

        let written: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(node.id())).expect("the node file exists"),
        )
        .expect("the file parses as a node");
        assert_eq!(written.envelope.lifecycle, Lifecycle::Specified);

        let history = store.read_audit(node.id()).expect("audit reads back");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].reason, "The author completed the node.");
    }

    /// PRD §7.3's human-only gate, proved at the RPC boundary — through
    /// `dispatch`, exactly as a real `invoke` call would reach it — not by
    /// calling `schematify_core::check_transition` directly. The core's
    /// table being correct proves nothing about whether this file's own
    /// dispatch arm actually calls it before writing anything; this test and
    /// the file-untouched assertion at its end are what pin that.
    #[test]
    fn transition_rejects_an_agent_reaching_accepted_at_the_command_boundary() {
        let dir = TempDir::new("transition-human-only");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let node = sample_module("crypto-primitives", Lifecycle::Reviewed, None);
        store.write_node(&node).expect("seed the node");

        let err = dispatch(
            &context,
            "schematify/transition",
            Some(json!({
                "actor": "agent",
                "node": node,
                "to": "accepted",
                "actorName": "claude-sdd",
                "at": "2026-09-03T12:00:00Z",
                "reason": "The agent believes the review is complete.",
            })),
        )
        .expect_err("an agent may never reach accepted");
        assert_eq!(err.code, INVALID_PARAMS);
        assert!(
            err.message.contains("human-only"),
            "the refusal should name itself: {}",
            err.message
        );

        // Nothing was written — the node file on disk still says `reviewed`,
        // and the audit history is still empty.
        let on_disk: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(node.id())).expect("the node file exists"),
        )
        .expect("the file parses as a node");
        assert_eq!(on_disk.envelope.lifecycle, Lifecycle::Reviewed);
        assert!(store
            .read_audit(node.id())
            .expect("audit reads back")
            .is_empty());
    }

    /// The same gate from `stale`, PRD §7.2's other agent-refused row into
    /// `accepted`.
    #[test]
    fn transition_rejects_an_agent_reaching_accepted_from_stale_too() {
        let dir = TempDir::new("transition-human-only-from-stale");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let node = sample_module("crypto-primitives", Lifecycle::Stale, None);
        store.write_node(&node).expect("seed the node");

        let err = dispatch(
            &context,
            "schematify/transition",
            Some(json!({
                "actor": "agent",
                "node": node,
                "to": "accepted",
                "actorName": "claude-sdd",
                "at": "2026-09-03T12:00:00Z",
                "reason": "The agent believes the review is complete.",
            })),
        )
        .expect_err("an agent may never reach accepted, from stale either");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn transition_refuses_an_illegal_move_and_writes_nothing() {
        let dir = TempDir::new("transition-illegal");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let node = sample_module("crypto-primitives", Lifecycle::Draft, None);
        store.write_node(&node).expect("seed the node");

        let err = dispatch(
            &context,
            "schematify/transition",
            Some(json!({
                "actor": "human",
                "node": node,
                "to": "accepted",
                "actorName": "m.ross",
                "at": "2026-09-03T12:00:00Z",
                "reason": "Skipping ahead.",
            })),
        )
        .expect_err("draft to accepted is not a row in the table");
        assert_eq!(err.code, INVALID_PARAMS);

        let on_disk: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(node.id())).expect("the node file exists"),
        )
        .expect("the file parses as a node");
        assert_eq!(on_disk.envelope.lifecycle, Lifecycle::Draft);
    }

    /// Reproduces the bug report at the RPC boundary: `rate-limiter`,
    /// genuinely `draft` on disk, called through `schematify/transition`
    /// with its own node JSON edited to claim `lifecycle: "reviewed"`,
    /// `to: "accepted"`, `actor: "human"` — the exact request that used to
    /// land a draft node on `accepted` in one call, skipping `specified`,
    /// `assigned`, `implemented`, and `reviewed`, and the human-review gate
    /// along with them. This is the RPC-level twin of
    /// `schematify_core::store::tests::write_transition_refuses_a_claim_that_disagrees_with_disk`;
    /// this one proves the dispatch arm passes the caller's claim through
    /// unmassaged, the same way `transition_rejects_an_agent_reaching_accepted_at_the_command_boundary`
    /// proves the actor gate at this boundary rather than trusting the
    /// core crate's own tests to speak for it.
    #[test]
    fn transition_refuses_a_lifecycle_claim_that_disagrees_with_disk() {
        let dir = TempDir::new("transition-forged-claim");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let mut node = sample_module("rate-limiter", Lifecycle::Draft, None);
        store
            .write_node(&node)
            .expect("seed the node, genuinely draft");

        // The caller's copy lies about where the node starts, and also
        // carries an edit to a field a lifecycle move has no business
        // touching.
        node.envelope.lifecycle = Lifecycle::Reviewed;
        node.envelope.title = "CANARY-TITLE-OVERWRITE".to_string();

        let err = dispatch(
            &context,
            "schematify/transition",
            Some(json!({
                "actor": "human",
                "node": node,
                "to": "accepted",
                "actorName": "human",
                "at": "2026-09-03T12:00:00Z",
                "reason": "Accepted.",
            })),
        )
        .expect_err("a claimed lifecycle that disagrees with disk is refused");
        assert_eq!(err.code, INVALID_PARAMS);

        let on_disk: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(node.id())).expect("the node file exists"),
        )
        .expect("the file parses as a node");
        assert_eq!(
            on_disk.envelope.lifecycle,
            Lifecycle::Draft,
            "the node on disk never left draft"
        );
        assert_eq!(
            on_disk.envelope.title, "rate-limiter",
            "the forged title was never written"
        );
        assert!(store
            .read_audit(node.id())
            .expect("audit reads back")
            .is_empty());
    }

    /// The other half of the same report: a legal transition — the claimed
    /// lifecycle agrees with disk — whose payload also carries an edited
    /// `title`. This is what let a lifecycle-only endpoint double as a
    /// silent whole-node overwrite: `write_transition` used to persist the
    /// caller's entire node, forged fields included, once the (unchecked)
    /// `from` happened to be legal.
    #[test]
    fn transition_never_writes_a_field_other_than_lifecycle() {
        let dir = TempDir::new("transition-field-smuggle");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let mut node = sample_module("rate-limiter", Lifecycle::Reviewed, None);
        store.write_node(&node).expect("seed the node");

        // The claim agrees with disk this time - an otherwise legal move -
        // but the same payload smuggles a title edit alongside it.
        node.envelope.title = "CANARY-TITLE-OVERWRITE".to_string();

        let value = dispatch(
            &context,
            "schematify/transition",
            Some(json!({
                "actor": "human",
                "node": node,
                "to": "accepted",
                "actorName": "human",
                "at": "2026-09-03T12:00:00Z",
                "reason": "Accepted.",
            })),
        )
        .expect("a legal human transition still succeeds");

        assert_eq!(value["node"]["lifecycle"], "accepted");
        assert_eq!(
            value["node"]["title"], "rate-limiter",
            "the response reflects the real, disk-sourced node, not the caller's forged copy"
        );

        let on_disk: Node = serde_json::from_str(
            &fs::read_to_string(store.node_path(node.id())).expect("the node file exists"),
        )
        .expect("the file parses as a node");
        assert_eq!(on_disk.envelope.lifecycle, Lifecycle::Accepted);
        assert_eq!(
            on_disk.envelope.title, "rate-limiter",
            "the forged title in the caller's payload was never written"
        );
    }

    /// Not a fabricated `Node` literal: `load-graph` against the real
    /// committed fixture (`crates/schematify-core/fixtures/saas-backend/`).
    /// This is what caught the wiring bug worth recording — a first version
    /// of `apps/schematify/ui/src/graph/project.ts` collapsed every
    /// non-`group` kind to `"module"`, so `auth-service`'s 12 real modules
    /// plus 58 of its own facets (contract methods, test cases, budgets)
    /// all drew as one flat 70-node service. This test pins the raw
    /// material — 12 modules, 1 group — not `project.ts`'s output;
    /// `project.test.ts`'s own real-shaped test pins that the group is
    /// still drawn (a real containment box) but not counted (annotation
    /// tier, per the owner's ruling recorded in
    /// `docs/overnight-jobs/overnight-2/handoffs/wiring.md`, which also
    /// carries the full comparison against the wave 2 stand-in fixture).
    #[test]
    fn load_graph_against_the_real_fixture_reports_a_clean_project_and_auth_service() {
        let root = manifest_dir()
            .join("..")
            .join("crates")
            .join("schematify-core")
            .join("fixtures")
            .join("saas-backend");
        let context = context_at(&root);
        let value = dispatch(
            &context,
            "schematify/load-graph",
            Some(json!({ "actor": "human" })),
        )
        .expect("load-graph succeeds against the real fixture");

        assert_eq!(value["report"]["clean"], true);

        let nodes = value["graph"]["nodes"]
            .as_array()
            .expect("nodes is an array");
        let auth_service = nodes
            .iter()
            .find(|n| n["kind"] == "service" && n["slug"] == "auth-service")
            .expect("fixtures/saas-backend/ names an auth-service, per PRD §16.1");
        assert_eq!(auth_service["title"], "Auth Service");

        // The Service Schematic's own subtree: 12 modules, 1 group, and a
        // pile of tier-3 facets a Module Schematic draws instead — the
        // count `project.ts`'s `SERVICE_SCHEMATIC_KINDS` filter exists to
        // separate out. This assertion pins the raw material, not the
        // filter; `project.test.ts` pins the filter itself.
        let auth_id = auth_service["id"].as_str().unwrap();
        let by_id: std::collections::HashMap<&str, &Value> = nodes
            .iter()
            .map(|n| (n["id"].as_str().unwrap(), n))
            .collect();
        fn is_descendant<'a>(
            mut node: &'a Value,
            auth_id: &str,
            by_id: &std::collections::HashMap<&str, &'a Value>,
        ) -> bool {
            loop {
                match node["parent"].as_str() {
                    Some(p) if p == auth_id => return true,
                    Some(p) => match by_id.get(p) {
                        Some(parent) => node = parent,
                        None => return false,
                    },
                    None => return false,
                }
            }
        }
        let descendants: Vec<&Value> = nodes
            .iter()
            .filter(|n| n["id"] != auth_service["id"] && is_descendant(n, auth_id, &by_id))
            .collect();
        let modules = descendants.iter().filter(|n| n["kind"] == "module").count();
        let groups = descendants.iter().filter(|n| n["kind"] == "group").count();
        assert_eq!((modules, groups), (12, 1));
    }

    #[test]
    fn write_screen_writes_the_content_a_reader_gets_back() {
        let dir = TempDir::new("write-screen");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let screen = sample_screen("login-form");
        let params = json!({ "actor": "human", "screen": screen });

        dispatch(&context, "schematify/write-screen", Some(params)).expect("write-screen succeeds");

        let path = Store::open(dir.path()).screen_path(screen.id);
        let text = fs::read_to_string(path).expect("the screen file exists");
        let written: Screen = serde_json::from_str(&text).expect("the file parses as a screen");
        assert_eq!(written, screen);
    }

    #[test]
    fn write_screen_upserts_an_existing_screen() {
        // Unlike a decision row, a screen carries no append-only rule (PRD
        // §12.17 draws a per-screen editor, and nothing in §5.7 restricts a
        // second write) — a screen is exactly what `write_decision` below is
        // deliberately not.
        let dir = TempDir::new("write-screen-upsert");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let mut screen = sample_screen("login-form");
        dispatch(
            &context,
            "schematify/write-screen",
            Some(json!({ "actor": "human", "screen": screen })),
        )
        .expect("first write succeeds");

        screen.purpose = "A revised purpose.".to_owned();
        dispatch(
            &context,
            "schematify/write-screen",
            Some(json!({ "actor": "human", "screen": screen })),
        )
        .expect("second write to the same id succeeds");

        let path = Store::open(dir.path()).screen_path(screen.id);
        let written: Screen =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).expect("parses");
        assert_eq!(written.purpose, "A revised purpose.");
    }

    #[test]
    fn write_flow_writes_the_content_a_reader_gets_back() {
        let dir = TempDir::new("write-flow");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let flow = sample_flow();
        let params = json!({ "actor": "agent", "flow": flow });

        dispatch(&context, "schematify/write-flow", Some(params)).expect("write-flow succeeds");

        let path = Store::open(dir.path()).flow_path(flow.id);
        let text = fs::read_to_string(path).expect("the flow file exists");
        let written: Flow = serde_json::from_str(&text).expect("the file parses as a flow");
        assert_eq!(written, flow);
    }

    #[test]
    fn write_brief_writes_the_content_a_reader_gets_back() {
        let dir = TempDir::new("write-brief");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let brief = ProjectBrief {
            product_name: "saas-backend".to_owned(),
            problem: "Teams rebuild the same account layer each time.".to_owned(),
            users: vec!["Platform engineers".to_owned()],
            goals: Vec::new(),
            non_goals: Vec::new(),
            constraints: Vec::new(),
            success_metrics: Vec::new(),
        };
        let params = json!({ "actor": "human", "brief": brief });

        dispatch(&context, "schematify/write-brief", Some(params)).expect("write-brief succeeds");

        let path = Store::open(dir.path()).brief_path();
        let text = fs::read_to_string(path).expect("the brief file exists");
        let written: ProjectBrief =
            serde_json::from_str(&text).expect("the file parses as a brief");
        assert_eq!(written, brief);
    }

    #[test]
    fn write_decision_creates_a_new_standing_row() {
        let dir = TempDir::new("write-decision-new");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let decision = sample_decision(1, DecisionStatus::Active);
        let params = json!({ "actor": "human", "decision": decision });

        dispatch(&context, "schematify/write-decision", Some(params))
            .expect("write-decision succeeds for a fresh id");

        let path = Store::open(dir.path()).decision_path(decision.id);
        let written: Decision =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).expect("parses");
        assert_eq!(written, decision);
    }

    /// The boundary proof PRD §5.9 and wave 10c's own acceptance condition
    /// ask for: a decision row cannot be edited in place, checked against
    /// the RPC dispatcher rather than only a disabled UI button. Sending the
    /// same id back with a changed title is a plain edit attempt, and it is
    /// refused before anything on disk changes.
    #[test]
    fn write_decision_refuses_to_edit_an_existing_row_in_place() {
        let dir = TempDir::new("write-decision-edit-blocked");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let original = sample_decision(1, DecisionStatus::Active);
        dispatch(
            &context,
            "schematify/write-decision",
            Some(json!({ "actor": "human", "decision": original })),
        )
        .expect("first write succeeds");

        let mut tampered = original.clone();
        tampered.title = "A quietly rewritten title".to_owned();
        let err = dispatch(
            &context,
            "schematify/write-decision",
            Some(json!({ "actor": "human", "decision": tampered })),
        )
        .expect_err("a second write to the same id is refused");
        assert_eq!(err.code, INVALID_PARAMS);

        let path = Store::open(dir.path()).decision_path(original.id);
        let written: Decision =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).expect("parses");
        assert_eq!(
            written, original,
            "the file on disk must be untouched by the refused write"
        );
    }

    #[test]
    fn write_decision_refuses_a_payload_that_already_claims_a_supersession() {
        let dir = TempDir::new("write-decision-preclaimed");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let mut superseded = sample_decision(1, DecisionStatus::Superseded);
        superseded.superseded_by = Some(Uuid::from_u128(2));
        let err = dispatch(
            &context,
            "schematify/write-decision",
            Some(json!({ "actor": "human", "decision": superseded })),
        )
        .expect_err("a fresh decision cannot arrive already superseded");
        assert_eq!(err.code, INVALID_PARAMS);

        let mut pre_linked = sample_decision(1, DecisionStatus::Active);
        pre_linked.supersedes = Some(Uuid::from_u128(3));
        let err = dispatch(
            &context,
            "schematify/write-decision",
            Some(json!({ "actor": "human", "decision": pre_linked })),
        )
        .expect_err("a fresh decision cannot arrive already claiming a prior row");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    /// The other half of "cannot be edited or removed": no method on this
    /// dispatcher deletes a decision file at all, proven the same way an
    /// unknown method is proven — by dispatching it and reading the error.
    #[test]
    fn no_method_removes_a_decision_row() {
        let context = CallContext::default();
        for method in [
            "schematify/delete-decision",
            "schematify/remove-decision",
            "schematify/edit-decision",
        ] {
            let err = dispatch(&context, method, None).expect_err("no such method exists");
            assert_eq!(err.code, METHOD_NOT_FOUND, "method: {method}");
        }
    }

    #[test]
    fn supersede_decision_adds_a_row_and_marks_the_prior_superseded() {
        let dir = TempDir::new("supersede-decision");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let prior = sample_decision(1, DecisionStatus::Active);
        dispatch(
            &context,
            "schematify/write-decision",
            Some(json!({ "actor": "human", "decision": prior })),
        )
        .expect("seed write succeeds");

        let mut successor = sample_decision(2, DecisionStatus::Active);
        successor.title = "Verify against a wider key set".to_owned();
        let value = dispatch(
            &context,
            "schematify/supersede-decision",
            Some(json!({
                "actor": "human",
                "priorId": prior.id,
                "decision": successor,
            })),
        )
        .expect("supersede-decision succeeds");
        assert_eq!(value["id"], successor.id.to_string());

        let store = Store::open(dir.path());
        let written_successor: Decision =
            serde_json::from_str(&fs::read_to_string(store.decision_path(successor.id)).unwrap())
                .unwrap();
        assert_eq!(written_successor.status, DecisionStatus::Active);
        assert_eq!(written_successor.supersedes, Some(prior.id));
        assert_eq!(written_successor.title, "Verify against a wider key set");

        let written_prior: Decision =
            serde_json::from_str(&fs::read_to_string(store.decision_path(prior.id)).unwrap())
                .unwrap();
        assert_eq!(written_prior.status, DecisionStatus::Superseded);
        assert_eq!(written_prior.superseded_by, Some(successor.id));
        // Every other field on the prior row is untouched — the point of
        // routing this through the file already on disk rather than any
        // payload the caller sent.
        assert_eq!(written_prior.title, prior.title);
        assert_eq!(written_prior.context, prior.context);
        assert_eq!(written_prior.decision, prior.decision);
        assert_eq!(written_prior.consequences, prior.consequences);
        assert_eq!(written_prior.date, prior.date);
    }

    /// The successor's own `supersedes`/`superseded_by` are server-decided,
    /// not caller-decided — a payload naming the wrong prior id, or one
    /// already claiming a superseded_by, is overwritten rather than trusted.
    #[test]
    fn supersede_decision_ignores_a_forged_supersession_on_the_successor_payload() {
        let dir = TempDir::new("supersede-decision-forged");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let prior = sample_decision(1, DecisionStatus::Active);
        dispatch(
            &context,
            "schematify/write-decision",
            Some(json!({ "actor": "human", "decision": prior })),
        )
        .expect("seed write succeeds");

        let mut forged = sample_decision(2, DecisionStatus::Superseded);
        forged.supersedes = Some(Uuid::from_u128(999));
        forged.superseded_by = Some(Uuid::from_u128(998));
        dispatch(
            &context,
            "schematify/supersede-decision",
            Some(json!({ "actor": "human", "priorId": prior.id, "decision": forged })),
        )
        .expect("supersede-decision succeeds despite the forged fields");

        let store = Store::open(dir.path());
        let written: Decision =
            serde_json::from_str(&fs::read_to_string(store.decision_path(forged.id)).unwrap())
                .unwrap();
        assert_eq!(written.status, DecisionStatus::Active);
        assert_eq!(written.supersedes, Some(prior.id));
        assert_eq!(written.superseded_by, None);
    }

    #[test]
    fn supersede_decision_refuses_a_prior_id_with_no_file() {
        let dir = TempDir::new("supersede-decision-no-prior");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let successor = sample_decision(2, DecisionStatus::Active);
        let err = dispatch(
            &context,
            "schematify/supersede-decision",
            Some(json!({
                "actor": "human",
                "priorId": Uuid::from_u128(999),
                "decision": successor,
            })),
        )
        .expect_err("no row exists to supersede");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn supersede_decision_refuses_a_prior_row_that_is_already_superseded() {
        let dir = TempDir::new("supersede-decision-double");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let mut prior = sample_decision(1, DecisionStatus::Superseded);
        prior.superseded_by = Some(Uuid::from_u128(2));
        // Written directly, bypassing `write_decision`'s own refusal of a
        // pre-superseded payload — this test is about `supersede_decision`'s
        // own guard, not `write_decision`'s.
        Store::open(dir.path())
            .write_decision(&prior)
            .expect("seed write succeeds");

        let successor = sample_decision(3, DecisionStatus::Active);
        let err = dispatch(
            &context,
            "schematify/supersede-decision",
            Some(json!({
                "actor": "human",
                "priorId": prior.id,
                "decision": successor,
            })),
        )
        .expect_err("a row already superseded cannot be superseded again");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn supersede_decision_refuses_a_successor_id_that_already_exists() {
        let dir = TempDir::new("supersede-decision-collision");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let prior = sample_decision(1, DecisionStatus::Active);
        let already_there = sample_decision(2, DecisionStatus::Active);
        dispatch(
            &context,
            "schematify/write-decision",
            Some(json!({ "actor": "human", "decision": prior })),
        )
        .expect("seed prior succeeds");
        dispatch(
            &context,
            "schematify/write-decision",
            Some(json!({ "actor": "human", "decision": already_there })),
        )
        .expect("seed already_there succeeds");

        let colliding = sample_decision(2, DecisionStatus::Active);
        let err = dispatch(
            &context,
            "schematify/supersede-decision",
            Some(json!({
                "actor": "human",
                "priorId": prior.id,
                "decision": colliding,
            })),
        )
        .expect_err("a successor id that already exists is refused, same as write-decision");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    fn sample_flow() -> Flow {
        use schematify_core::mint_id;

        Flow {
            id: mint_id(),
            kind: schematify_core::FlowKind::default(),
            slug: schematify_core::Slug::new("first-run-signup").expect("legal slug"),
            title: "First-run signup".to_owned(),
            trigger: "A visitor opens the product with no account.".to_owned(),
            steps: Vec::new(),
            outcome: "The visitor holds an active session.".to_owned(),
        }
    }

    fn sample_decision(id: u128, status: DecisionStatus) -> Decision {
        Decision {
            id: Uuid::from_u128(id),
            kind: schematify_core::DecisionKind::default(),
            slug: schematify_core::Slug::new("DEC-TEC-AUTH-004").expect("legal decision slug"),
            title: "Verify signatures against a rotating key set".to_owned(),
            context: "The prior design pinned one signing key.".to_owned(),
            decision: "Schematify shall verify against the published key set.".to_owned(),
            consequences: "Key rotation adds a network fetch to the cold path.".to_owned(),
            status,
            supersedes: None,
            superseded_by: None,
            date: "2026-08-19".to_owned(),
        }
    }

    fn sample_service_node() -> Node {
        use schematify_core::{Authorship, Lifecycle, NodeEnvelope, NodeKind, Slug};

        Node::new(NodeEnvelope {
            id: schematify_core::mint_id(),
            slug: Slug::new("auth-service").expect("legal slug"),
            kind: NodeKind::Service,
            title: "Auth Service".to_string(),
            description: None,
            lifecycle: Lifecycle::Accepted,
            layer: None,
            parent: None,
            decisions: Vec::new(),
            authored_by: Authorship::Human,
            created: "2026-09-03T00:00:00Z".to_string(),
            superseded_by: None,
            stale: None,
        })
    }

    /// A bare `Module` node, for tests that need a legal `module_dashboard`
    /// scope without a service's shape — `sample_service_node` above is
    /// wrong for that: its whole point is being a *service*, and
    /// `module_dashboard` now refuses anything that is not a module.
    fn sample_module_node() -> Node {
        use schematify_core::{Authorship, Lifecycle, NodeEnvelope, NodeKind, Slug};

        Node::new(NodeEnvelope {
            id: schematify_core::mint_id(),
            slug: Slug::new("sample-module").expect("legal slug"),
            kind: NodeKind::Module,
            title: "Sample Module".to_string(),
            description: None,
            lifecycle: Lifecycle::Accepted,
            layer: None,
            parent: None,
            decisions: Vec::new(),
            authored_by: Authorship::Human,
            created: "2026-09-03T00:00:00Z".to_string(),
            superseded_by: None,
            stale: None,
        })
    }

    fn budget_module_node(id: Uuid, slug: &str, metric: &str) -> Node {
        use schematify_core::{
            Authorship, BudgetFields, BudgetTier, Lifecycle, NodeEnvelope, NodeKind, Probe, Slug,
        };

        Node::new(NodeEnvelope {
            id,
            slug: Slug::new(slug).expect("legal slug"),
            kind: NodeKind::Budget,
            title: metric.to_string(),
            description: None,
            lifecycle: Lifecycle::Specified,
            layer: None,
            parent: None,
            decisions: Vec::new(),
            authored_by: Authorship::Human,
            created: "2026-09-03T00:00:00Z".to_string(),
            superseded_by: None,
            stale: None,
        })
        .with_fields(&BudgetFields {
            metric: metric.to_string(),
            op: "<".to_string(),
            value: 3.0,
            unit: "ms".to_string(),
            tier: BudgetTier::Hard,
            probe: Some(Probe {
                command: "pnpm bench:x".to_string(),
                parser: "veistra-bench-v1".to_string(),
            }),
            sign_off: None,
        })
        .expect("budget fields serialize")
    }

    #[test]
    fn ingest_run_writes_the_file_a_reader_gets_back() {
        use schematify_core::{RunArtifact, RUN_SCHEMA_VERSION};

        let dir = TempDir::new("ingest-run");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let scope_id = schematify_core::mint_id();
        let scope = Node::new(schematify_core::NodeEnvelope {
            id: scope_id,
            slug: schematify_core::Slug::new("token-verifier").expect("legal slug"),
            kind: schematify_core::NodeKind::Module,
            title: "Token Verifier".to_string(),
            description: None,
            lifecycle: schematify_core::Lifecycle::Accepted,
            layer: None,
            parent: None,
            decisions: Vec::new(),
            authored_by: schematify_core::Authorship::Human,
            created: "2026-09-03T00:00:00Z".to_string(),
            superseded_by: None,
            stale: None,
        });
        store.write_node(&scope).expect("seed module write");
        let budget = budget_module_node(schematify_core::mint_id(), "verify-p95", "verify_p95");
        let mut budget = budget;
        budget.envelope.parent = Some(scope_id);
        store.write_node(&budget).expect("seed budget write");

        let artifact = RunArtifact {
            schema: RUN_SCHEMA_VERSION.to_string(),
            run: 1,
            at: "2026-09-03T00:00:00Z".to_string(),
            commit: "abc1234".to_string(),
            workflow: "ci/verify.yml".to_string(),
            budgets: vec![schematify_core::BudgetResult {
                metric: "verify_p95".to_string(),
                value: 1.0,
                unit: "ms".to_string(),
                pass: true,
            }],
            tests: Vec::new(),
            linter: None,
            reconcile: None,
        };
        let artifact_path = dir.path().join("ci-artifact.json");
        fs::write(
            &artifact_path,
            serde_json::to_vec(&artifact).expect("artifact serializes"),
        )
        .expect("write the artifact CI would have dropped");

        let value = dispatch(
            &context,
            "schematify/ingest-run",
            Some(json!({
                "actor": "human",
                "module": scope_id.to_string(),
                "path": artifact_path.display().to_string(),
            })),
        )
        .expect("ingest-run succeeds");
        assert_eq!(value["ingested"], true);

        let written = store.run_path(scope_id, 1);
        assert!(
            written.is_file(),
            "the run landed at runs/<module>/run-1.json"
        );
    }

    #[test]
    fn ingest_run_refuses_a_second_ingestion_at_the_same_run_number() {
        // Broken on purpose to confirm this test can fail: temporarily
        // asserted `is_ok()` on the second call instead of `is_err()`, watched
        // it fail with "second ingestion should be refused: Ok(...)", then
        // restored the assertion below. Recorded per the task's own rule
        // rather than left to a comment nobody checked.
        use schematify_core::{RunArtifact, RUN_SCHEMA_VERSION};

        let dir = TempDir::new("ingest-run-dup");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let scope_id = schematify_core::mint_id();
        let scope = Node::new(schematify_core::NodeEnvelope {
            id: scope_id,
            slug: schematify_core::Slug::new("token-verifier").expect("legal slug"),
            kind: schematify_core::NodeKind::Module,
            title: "Token Verifier".to_string(),
            description: None,
            lifecycle: schematify_core::Lifecycle::Accepted,
            layer: None,
            parent: None,
            decisions: Vec::new(),
            authored_by: schematify_core::Authorship::Human,
            created: "2026-09-03T00:00:00Z".to_string(),
            superseded_by: None,
            stale: None,
        });
        store.write_node(&scope).expect("seed module write");

        let artifact = RunArtifact {
            schema: RUN_SCHEMA_VERSION.to_string(),
            run: 1,
            at: "2026-09-03T00:00:00Z".to_string(),
            commit: "abc1234".to_string(),
            workflow: "ci/verify.yml".to_string(),
            budgets: Vec::new(),
            tests: Vec::new(),
            linter: None,
            reconcile: None,
        };
        let artifact_path = dir.path().join("ci-artifact.json");
        fs::write(
            &artifact_path,
            serde_json::to_vec(&artifact).expect("artifact serializes"),
        )
        .expect("write the artifact CI would have dropped");

        let params = json!({
            "actor": "human",
            "module": scope_id.to_string(),
            "path": artifact_path.display().to_string(),
        });
        dispatch(&context, "schematify/ingest-run", Some(params.clone()))
            .expect("first ingestion succeeds");
        let second = dispatch(&context, "schematify/ingest-run", Some(params));
        assert!(
            second.is_err(),
            "second ingestion should be refused: {second:?}"
        );
    }

    /// Against the real committed fixture, per §16.1: `verify-signature.json`,
    /// `refresh-keys.json` and the module's own file carry `probe`; only
    /// `cold-start-p95` does not, so `2 / 3` and `1 hard budget has no probe`.
    /// `5 / 7` tests, `1` failing, `1` unlinked, per the 7 `test-case`
    /// children this crate's own fixture holds.
    #[test]
    fn module_dashboard_against_the_real_fixture_draws_the_16_1_values() {
        let root = manifest_dir()
            .join("..")
            .join("crates")
            .join("schematify-core")
            .join("fixtures")
            .join("saas-backend");
        let context = context_at(&root);

        // token-verifier's real id, per the committed fixture (also read by
        // `load_graph_against_the_real_fixture_reports_a_clean_project_and_auth_service`
        // above via slug lookup; this test pins the id literally since it is
        // this fixture's own stable identifier).
        let module = "01a03637-7800-7024-8962-cc11fce89708";

        let value = dispatch(
            &context,
            "schematify/module-dashboard",
            Some(json!({ "actor": "human", "module": module })),
        )
        .expect("module-dashboard succeeds against the real fixture");

        assert_eq!(value["module"]["slug"], "token-verifier");
        assert_eq!(value["latestRun"]["run"], 1184);

        assert_eq!(value["budgets"]["withProbe"], 2);
        assert_eq!(value["budgets"]["total"], 3);
        assert_eq!(value["budgets"]["hardMissingProbe"], 1);

        assert_eq!(value["tests"]["passing"], 5);
        assert_eq!(value["tests"]["total"], 7);
        assert_eq!(value["tests"]["failing"], 1);
        assert_eq!(value["tests"]["unlinked"], 1);

        assert_eq!(value["linter"]["rules"], 14);
        assert_eq!(value["linter"]["violations"], 0);

        assert_eq!(value["reconciliation"]["matched"], 7);
        assert_eq!(value["reconciliation"]["declaredAbsent"], 1);
        assert_eq!(value["reconciliation"]["presentUnknown"], 0);
        assert_eq!(value["reconciliation"]["duplicate"], 0);

        let rows = value["reconciliationRows"]
            .as_array()
            .expect("reconciliationRows is an array");
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0]["outcome"], "matched");
        assert_eq!(rows[0]["count"], 7);
        assert_eq!(rows[0]["site"], "src/auth/verifier.ts +3 more");
        assert_eq!(rows[1]["outcome"], "declared, absent");
        assert_eq!(rows[1]["count"], 1);
        assert_eq!(rows[1]["site"], "skew_window — no marker");
        assert_eq!(rows[2]["site"], "—");
        assert_eq!(rows[3]["site"], "—");
        // The 8 hand-authored `reconcile.json` files (§3 of the wave 9d
        // handoff) were written to agree with the run artifact's own
        // counts; this asserts that agreement actually holds at runtime,
        // not just "by construction" — the safeguard
        // `reconciliation_count_and_site_are_computed_independently_and_can_visibly_disagree`
        // proves would fire on all 4 rows here if it did not.
        for row in rows {
            assert_eq!(
                row["countMismatch"], false,
                "the authored fixture evidence should agree with run-1184.json: {row:?}"
            );
        }

        let audit = value["auditLog"].as_array().expect("auditLog is an array");
        assert_eq!(audit.len(), 5);
        assert_eq!(audit[0]["to"], "accepted");
        assert_eq!(audit[0]["actorName"], "m.ross");
    }

    #[test]
    fn module_dashboard_reports_no_run_and_dashes_for_a_module_that_never_ran() {
        let dir = TempDir::new("module-dashboard-no-run");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let scope = sample_module_node();
        store.write_node(&scope).expect("seed write succeeds");

        let value = dispatch(
            &context,
            "schematify/module-dashboard",
            Some(json!({ "actor": "human", "module": scope.id().to_string() })),
        )
        .expect("module-dashboard succeeds against a node with no run");

        assert!(value["latestRun"].is_null());
        assert!(value["linter"].is_null());
        assert!(value["reconciliation"].is_null());
        assert_eq!(value["budgets"]["total"], 0);
        assert_eq!(value["tests"]["total"], 0);
        let rows = value["reconciliationRows"].as_array().unwrap();
        for row in rows {
            assert_eq!(row["site"], "—");
            assert_eq!(row["count"], 0);
            assert_eq!(
                row["countMismatch"], false,
                "0 evidence against 0 declared agrees"
            );
        }
    }

    /// `COUNT` and `SITE` are read from 2 independent sources — the run
    /// artifact's own `ReconcileResult`, and the `reconcile.json` files this
    /// module's own children carry (§3 of the wave 9d handoff). Nothing
    /// reconciles the two against each other, on purpose: a run can declare
    /// a count no evidence file backs yet (CI ran before `veistra reconcile`
    /// did), and a caller should see that gap rather than have one number
    /// silently overwritten by the other. This test proves the 2 numbers
    /// really are independent by making them disagree: a run declaring 5
    /// matched outcomes, but only 1 `reconcile.json` file on disk actually
    /// saying `matched`. If a future change made `COUNT` derive from the
    /// evidence files, `reconciliation.matched` below would read `1`, not
    /// `5`; if it made `SITE` fabricate itself from `COUNT`, the site text
    /// would read `+4 more` rather than naming only the 1 file this test
    /// wrote. Either failure mode is exactly what this test exists to catch.
    #[test]
    fn reconciliation_count_and_site_are_computed_independently_and_can_visibly_disagree() {
        use schematify_core::{RunArtifact, RUN_SCHEMA_VERSION};

        let dir = TempDir::new("reconciliation-independence");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let scope = sample_module_node();
        store.write_node(&scope).expect("seed write succeeds");
        let scope_id = scope.id();

        let run = RunArtifact {
            schema: RUN_SCHEMA_VERSION.to_string(),
            run: 1,
            at: "2026-09-03T00:00:00Z".to_string(),
            commit: "abc1234".to_string(),
            workflow: "ci/verify.yml".to_string(),
            budgets: Vec::new(),
            tests: Vec::new(),
            linter: None,
            reconcile: Some(schematify_core::ReconcileResult {
                matched: 5,
                declared_absent: 0,
                present_unknown: 0,
                duplicate: 0,
            }),
        };
        store.write_run(scope_id, &run).expect("seed run write");

        // 1 real reconcile.json — deliberately fewer than the run's own
        // `matched: 5` — written directly under the module's own runs
        // directory, on the module node itself (not a child), so this test
        // needs no facet nodes to make its point.
        let runs_dir = dir
            .path()
            .join(".veistra")
            .join("runs")
            .join(scope_id.to_string());
        fs::write(
            runs_dir.join("reconcile.json"),
            json!({
                "schema": "veistra-reconcile-v1",
                "at": "2026-09-03T00:00:00Z",
                "outcome": "matched",
                "node_id": scope_id.to_string(),
                "slug": "sample-module",
                "site": { "file": "src/only_evidence_this_test_wrote.rs", "line": 1 },
            })
            .to_string(),
        )
        .expect("seed the one reconcile.json this test writes");

        let value = dispatch(
            &context,
            "schematify/module-dashboard",
            Some(json!({ "actor": "human", "module": scope_id.to_string() })),
        )
        .expect("module-dashboard succeeds");

        // COUNT: read straight from the run artifact, untouched by there
        // being only 1 piece of real evidence on disk.
        assert_eq!(value["reconciliation"]["matched"], 5);
        assert_eq!(value["reconciliationRows"][0]["count"], 5);
        // SITE: read straight from the 1 real reconcile.json file, untouched
        // by the run artifact claiming 5. Not "+4 more" — that would mean
        // this function started fabricating evidence from the count.
        assert_eq!(
            value["reconciliationRows"][0]["site"],
            "src/only_evidence_this_test_wrote.rs"
        );
        // The 2 sources disagreeing must not pass silently: this is the
        // safeguard itself, not just proof the 2 numbers are independent.
        assert_eq!(
            value["reconciliationRows"][0]["countMismatch"], true,
            "1 real matched entry against a declared count of 5 must be flagged"
        );
    }

    /// The reviewer's own reproduction, verbatim: a run artifact declares
    /// `duplicate: 0`, but a `reconcile.json` on disk carries `outcome:
    /// duplicate` anyway (a corrupted or stale file). Before
    /// `count_mismatch` existed, `module_dashboard` drew `OUTCOME:
    /// duplicate, SITE: "…", COUNT: 0` — a self-contradictory row with
    /// nothing marking it as one. This test pins that the row is now
    /// flagged rather than drawn as if nothing were wrong.
    #[test]
    fn a_reconcile_json_that_contradicts_a_zero_declared_count_is_flagged() {
        use schematify_core::{RunArtifact, RUN_SCHEMA_VERSION};

        let dir = TempDir::new("reconciliation-corrupted-duplicate");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let scope = sample_module_node();
        store.write_node(&scope).expect("seed write succeeds");
        let scope_id = scope.id();

        let run = RunArtifact {
            schema: RUN_SCHEMA_VERSION.to_string(),
            run: 1,
            at: "2026-09-03T00:00:00Z".to_string(),
            commit: "abc1234".to_string(),
            workflow: "ci/verify.yml".to_string(),
            budgets: Vec::new(),
            tests: Vec::new(),
            linter: None,
            reconcile: Some(schematify_core::ReconcileResult {
                matched: 0,
                declared_absent: 0,
                present_unknown: 0,
                duplicate: 0,
            }),
        };
        store.write_run(scope_id, &run).expect("seed run write");

        let runs_dir = dir
            .path()
            .join(".veistra")
            .join("runs")
            .join(scope_id.to_string());
        fs::write(
            runs_dir.join("reconcile.json"),
            json!({
                "schema": "veistra-reconcile-v1",
                "at": "2026-09-03T00:00:00Z",
                "outcome": "duplicate",
                "node_id": scope_id.to_string(),
                "sites": [
                    { "file": "src/a.rs", "line": 1 },
                    { "file": "src/b.rs", "line": 4 },
                ],
            })
            .to_string(),
        )
        .expect("seed the contradicting reconcile.json");

        let value = dispatch(
            &context,
            "schematify/module-dashboard",
            Some(json!({ "actor": "human", "module": scope_id.to_string() })),
        )
        .expect("module-dashboard succeeds even over contradictory evidence");

        let duplicate_row = &value["reconciliationRows"][3];
        assert_eq!(duplicate_row["outcome"], "duplicate");
        assert_eq!(
            duplicate_row["count"], 0,
            "count still reads the run artifact's own declared 0"
        );
        assert_eq!(
            duplicate_row["countMismatch"], true,
            "1 real duplicate entry against a declared count of 0 must be flagged, not silently drawn as agreement"
        );
    }

    /// The 4 `ReconcileRow`s share one `count_mismatch` expression, mirrored
    /// per outcome kind — but 3 of those 4 mirrors had a test forcing a real,
    /// non-zero disagreement before this test existed (`matched` via
    /// `reconciliation_count_and_site_are_computed_independently_and_can_visibly_disagree`,
    /// `duplicate` via `a_reconcile_json_that_contradicts_a_zero_declared_count_is_flagged`,
    /// `declared, absent` via the real fixture's own 1-vs-1 evidence) and
    /// `present, unknown` did not — the real fixture carries 0 declared and 0
    /// evidence for that outcome, so its own row only ever proves `0 != 0`
    /// stays `false`, never that a real mismatch on this specific line would
    /// be caught. This closes that gap the same way the `duplicate` test
    /// does: a `present_unknown` `reconcile.json` on disk against a run
    /// artifact that declares none.
    #[test]
    fn a_present_unknown_reconcile_json_against_a_zero_declared_count_is_flagged() {
        use schematify_core::{RunArtifact, RUN_SCHEMA_VERSION};

        let dir = TempDir::new("reconciliation-present-unknown-mismatch");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        // A **module**, because that is what `schematify/module-dashboard`
        // takes. The version recovered from the overnight worktree seeded
        // `sample_service_node()` here and passed — not because a service is a
        // legal scope, but because nothing checked the kind at all. That gap is
        // a defect of its own, being closed separately; a test that only passes
        // while it stays open would go red the moment it was fixed, which is
        // the wrong reason for a test to fail.
        let scope = sample_module("present-unknown-scope", Lifecycle::Accepted, None);
        store.write_node(&scope).expect("seed write succeeds");
        let scope_id = scope.id();

        let run = RunArtifact {
            schema: RUN_SCHEMA_VERSION.to_string(),
            run: 1,
            at: "2026-09-03T00:00:00Z".to_string(),
            commit: "abc1234".to_string(),
            workflow: "ci/verify.yml".to_string(),
            budgets: Vec::new(),
            tests: Vec::new(),
            linter: None,
            reconcile: Some(schematify_core::ReconcileResult {
                matched: 0,
                declared_absent: 0,
                present_unknown: 0,
                duplicate: 0,
            }),
        };
        store.write_run(scope_id, &run).expect("seed run write");

        let runs_dir = dir
            .path()
            .join(".veistra")
            .join("runs")
            .join(scope_id.to_string());
        fs::write(
            runs_dir.join("reconcile.json"),
            json!({
                "schema": "veistra-reconcile-v1",
                "at": "2026-09-03T00:00:00Z",
                "outcome": "present_unknown",
                "node_id": scope_id.to_string(),
                "site": { "file": "src/unclaimed_marker.rs", "line": 7 },
            })
            .to_string(),
        )
        .expect("seed the contradicting reconcile.json");

        let value = dispatch(
            &context,
            "schematify/module-dashboard",
            Some(json!({ "actor": "human", "module": scope_id.to_string() })),
        )
        .expect("module-dashboard succeeds even over contradictory evidence");

        let present_unknown_row = &value["reconciliationRows"][2];
        assert_eq!(present_unknown_row["outcome"], "present, unknown");
        assert_eq!(
            present_unknown_row["count"], 0,
            "count still reads the run artifact's own declared 0"
        );
        assert_eq!(
            present_unknown_row["site"], "src/unclaimed_marker.rs",
            "SITE still reads the 1 real reconcile.json file on disk"
        );
        assert_eq!(
            present_unknown_row["countMismatch"], true,
            "1 real present-unknown entry against a declared count of 0 must be flagged, not silently drawn as agreement"
        );
    }

    #[test]
    fn list_runs_against_the_real_fixture_finds_the_one_ingested_run() {
        let root = manifest_dir()
            .join("..")
            .join("crates")
            .join("schematify-core")
            .join("fixtures")
            .join("saas-backend");
        let context = context_at(&root);

        let value = dispatch(
            &context,
            "schematify/runs",
            Some(json!({ "actor": "human" })),
        )
        .expect("runs succeeds against the real fixture");

        let runs = value["runs"].as_array().expect("runs is an array");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["run"], 1184);
        assert_eq!(runs[0]["module"]["slug"], "token-verifier");
        assert_eq!(runs[0]["workflow"], "ci/verify.yml");
    }

    #[test]
    fn list_runs_reports_none_for_a_project_that_has_never_run() {
        let dir = TempDir::new("list-runs-empty");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let value = dispatch(
            &context,
            "schematify/runs",
            Some(json!({ "actor": "agent" })),
        )
        .expect("runs succeeds over an empty project");
        assert_eq!(value["runs"].as_array().expect("array").len(), 0);
    }

    #[test]
    fn module_dashboard_refuses_an_id_that_names_no_node() {
        let dir = TempDir::new("module-dashboard-missing");
        Store::open(dir.path()).init().expect("init succeeds");
        let context = context_at(dir.path());

        let err = dispatch(
            &context,
            "schematify/module-dashboard",
            Some(json!({ "actor": "human", "module": schematify_core::mint_id().to_string() })),
        )
        .expect_err("an id with no node is refused");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    /// The regression this wave exists to close: an id that resolves to a
    /// real node, just not a module one, must be refused rather than drawn
    /// as if it were the module it names. `sample_service_node` names a
    /// `Service`, and the slug lookup path already refuses this shape (it
    /// filters on `kind == Module` before ever matching a slug) — this pins
    /// the id path to the same rule.
    #[test]
    fn module_dashboard_refuses_a_service_id() {
        let dir = TempDir::new("module-dashboard-wrong-kind");
        let store = Store::open(dir.path());
        store.init().expect("init succeeds");
        let context = context_at(dir.path());

        let service = sample_service_node();
        store.write_node(&service).expect("seed write succeeds");

        let err = dispatch(
            &context,
            "schematify/module-dashboard",
            Some(json!({ "actor": "human", "module": service.id().to_string() })),
        )
        .expect_err("a service id is refused, not drawn as a module");
        assert_eq!(err.code, INVALID_PARAMS);
        // Names which failure this is — a real node of the wrong kind, not
        // an id that resolves to nothing — so a caller can tell the two
        // apart, per the slug path's existing "no module node with slug"
        // wording for its own refusal.
        assert!(
            err.message.contains("service") && err.message.contains("not a module"),
            "expected the error to name the found kind, got: {}",
            err.message
        );
    }
}
