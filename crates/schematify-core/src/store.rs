//! The `.veistra/` storage layout of PRD section 6, and the writes it allows.
//!
//! The three layers are not organisational tidiness. They are the enforcement
//! mechanism for the rule that an agent shall not change the design: the
//! permission boundary is a path glob, so CODEOWNERS and a CI path check
//! enforce it mechanically rather than by instruction. A benchmark job
//! appending latency numbers writes to `runs/`; a person editing a contract
//! writes to `nodes/`; the two writes never conflict. Layout splits for the
//! same reason, so dragging a node does not dirty a semantic file.
//!
//! [`Store::write_transition`] is the one exception, PRD section 6.3: a
//! lifecycle change writes a node and appends an audit row in one action, and
//! the CI gate passes that pair and blocks every other write touching both
//! trees. [`allowed_together`] is that gate as a function.
//!
//! Nothing is deleted. [`Store::deprecate`] is what a caller reaches for
//! instead, and [`Store::delete_node`] exists to refuse.

use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::atomic::write_json_atomic;
use crate::brief::ProjectBrief;
use crate::decision::Decision;
use crate::edge::Edge;
use crate::error::{CoreError, Result};
use crate::graph::Graph;
use crate::layout::Layout;
use crate::lifecycle::{check_transition, Actor, AuditRow, Lifecycle};
use crate::node::Node;
use crate::product::{Flow, Screen};
use crate::registry::{LibraryRegistry, Rule};
use crate::run::RunArtifact;

/// The directory name Schematify keeps design data in.
const VEISTRA: &str = ".veistra";

/// Which of the three layers of PRD section 6.2 a path belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WriteLayer {
    /// Human-authored design. Nodes, edges, screens, flows, decisions, rules,
    /// the library registry, and the brief.
    Semantic,
    /// Machine-written history, append-only. Runs and lifecycle audits.
    Audit,
    /// Positions. A lost cosmetic file costs positions and nothing else.
    Cosmetic,
}

impl WriteLayer {
    /// Whether this layer's content is expected to vary by branch.
    ///
    /// Semantic and cosmetic data do, and PRD section 6.5 says that is correct
    /// rather than a defect: a branch that changes the design and the code
    /// together, reviewed as one pull request, is the traceability property in
    /// operation. Audit data does not - a sign-off outlives the branch it was
    /// made on, and this is the seam the future hosted store cuts along.
    #[must_use]
    pub fn varies_by_branch(self) -> bool {
        self != Self::Audit
    }
}

/// Which layer a path under `.veistra/` belongs to.
///
/// Returns `None` for a path outside `.veistra/`, or one this build does not
/// recognise. An unknown path is not assumed semantic: a gate that guesses
/// would either block a legitimate write or pass one it should have caught.
#[must_use]
pub fn layer_of(path: &Path) -> Option<WriteLayer> {
    let mut after_veistra = false;
    for part in path.components() {
        let part = part.as_os_str().to_string_lossy();
        if part == VEISTRA {
            after_veistra = true;
            continue;
        }
        if !after_veistra {
            continue;
        }
        return match part.as_ref() {
            "nodes" | "edges" | "screens" | "flows" | "decisions" | "rules" | "registry" => {
                Some(WriteLayer::Semantic)
            }
            "brief.json" => Some(WriteLayer::Semantic),
            "runs" => Some(WriteLayer::Audit),
            "layout" => Some(WriteLayer::Cosmetic),
            _ => None,
        };
    }
    None
}

/// Whether a set of paths may be written in one action.
///
/// The rule of PRD section 6.3: a write touching both `nodes/` and `runs/` is
/// allowed when it is exactly one node file and exactly one `audit.json`, and
/// is blocked otherwise. Anything that touches neither pair is allowed, since
/// this gate is about the semantic and audit trees meeting and nothing else.
#[must_use]
pub fn allowed_together(paths: &[PathBuf]) -> bool {
    let semantic: Vec<&PathBuf> = paths
        .iter()
        .filter(|p| layer_of(p) == Some(WriteLayer::Semantic))
        .collect();
    let audit: Vec<&PathBuf> = paths
        .iter()
        .filter(|p| layer_of(p) == Some(WriteLayer::Audit))
        .collect();

    if semantic.is_empty() || audit.is_empty() {
        return true;
    }

    let one_node = semantic.len() == 1
        && semantic[0]
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == "nodes");
    let one_audit = audit.len() == 1 && audit[0].file_name().is_some_and(|n| n == "audit.json");
    one_node && one_audit
}

/// One project's `.veistra/` tree, and the writes into it.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// A store over a project directory. `.veistra/` sits inside it.
    #[must_use]
    pub fn open(project_root: impl Into<PathBuf>) -> Self {
        Self {
            root: project_root.into(),
        }
    }

    /// The project directory.
    #[must_use]
    pub fn project_root(&self) -> &Path {
        &self.root
    }

    /// The `.veistra/` directory itself.
    #[must_use]
    pub fn veistra_dir(&self) -> PathBuf {
        self.root.join(VEISTRA)
    }

    /// Where a node file lives.
    #[must_use]
    pub fn node_path(&self, id: Uuid) -> PathBuf {
        self.veistra_dir().join("nodes").join(format!("{id}.json"))
    }

    /// Where an edge file lives.
    #[must_use]
    pub fn edge_path(&self, id: Uuid) -> PathBuf {
        self.veistra_dir().join("edges").join(format!("{id}.json"))
    }

    /// Where a screen file lives.
    #[must_use]
    pub fn screen_path(&self, id: Uuid) -> PathBuf {
        self.veistra_dir()
            .join("screens")
            .join(format!("{id}.json"))
    }

    /// Where a flow file lives.
    #[must_use]
    pub fn flow_path(&self, id: Uuid) -> PathBuf {
        self.veistra_dir().join("flows").join(format!("{id}.json"))
    }

    /// Where a decision file lives.
    #[must_use]
    pub fn decision_path(&self, id: Uuid) -> PathBuf {
        self.veistra_dir()
            .join("decisions")
            .join(format!("{id}.json"))
    }

    /// Where a rule file lives.
    #[must_use]
    pub fn rule_path(&self, id: Uuid) -> PathBuf {
        self.veistra_dir().join("rules").join(format!("{id}.json"))
    }

    /// Where the one library registry file lives.
    #[must_use]
    pub fn libraries_path(&self) -> PathBuf {
        self.veistra_dir().join("registry").join("libraries.json")
    }

    /// Where the project brief lives.
    #[must_use]
    pub fn brief_path(&self) -> PathBuf {
        self.veistra_dir().join("brief.json")
    }

    /// Where a Schematic's layout lives, named by slug rather than by UUID.
    #[must_use]
    pub fn layout_path(&self, schematic: &str) -> PathBuf {
        self.veistra_dir()
            .join("layout")
            .join(format!("{schematic}.json"))
    }

    /// Where one ingested run lives.
    #[must_use]
    pub fn run_path(&self, node: Uuid, run: u64) -> PathBuf {
        self.veistra_dir()
            .join("runs")
            .join(node.to_string())
            .join(format!("run-{run}.json"))
    }

    /// Where a node's lifecycle audit lives.
    #[must_use]
    pub fn audit_path(&self, node: Uuid) -> PathBuf {
        self.veistra_dir()
            .join("runs")
            .join(node.to_string())
            .join("audit.json")
    }

    /// Create the directory tree of PRD section 6.1.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::Io`] when a directory cannot be created.
    pub fn init(&self) -> Result<()> {
        for directory in [
            "nodes",
            "edges",
            "screens",
            "flows",
            "decisions",
            "rules",
            "registry",
            "runs",
            "layout",
        ] {
            let path = self.veistra_dir().join(directory);
            fs::create_dir_all(&path).map_err(|source| CoreError::Io { path, source })?;
        }
        Ok(())
    }

    /// Write one node.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::AtomicWrite`] when the write fails.
    pub fn write_node(&self, node: &Node) -> Result<()> {
        write_json_atomic(&self.node_path(node.id()), node)?;
        Ok(())
    }

    /// Read one node from disk by id alone.
    ///
    /// [`Store::write_transition`] uses this to establish a node's real
    /// lifecycle. A caller's own copy of a node is never the source of truth
    /// for what state it is in - only its id says which file to read.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::Io`] when the file cannot be read, including
    /// when no node exists at this id, and [`CoreError::Parse`] when it does
    /// not hold a node.
    pub fn read_node(&self, id: Uuid) -> Result<Node> {
        let path = self.node_path(id);
        let text = fs::read_to_string(&path).map_err(|source| CoreError::Io {
            path: path.clone(),
            source,
        })?;
        serde_json::from_str(&text).map_err(|source| CoreError::Parse {
            path,
            schema: "node",
            source,
        })
    }

    /// Write one edge. A `contains` edge is refused, because containment lives
    /// on the child node and a second copy would be a second truth.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::AtomicWrite`] when the write fails.
    pub fn write_edge(&self, edge: &Edge) -> Result<bool> {
        if !edge.is_stored() {
            return Ok(false);
        }
        write_json_atomic(&self.edge_path(edge.id), edge)?;
        Ok(true)
    }

    /// Write one screen.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::AtomicWrite`] when the write fails.
    pub fn write_screen(&self, screen: &Screen) -> Result<()> {
        write_json_atomic(&self.screen_path(screen.id), screen)?;
        Ok(())
    }

    /// Write one flow.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::AtomicWrite`] when the write fails.
    pub fn write_flow(&self, flow: &Flow) -> Result<()> {
        write_json_atomic(&self.flow_path(flow.id), flow)?;
        Ok(())
    }

    /// Write one decision.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::AtomicWrite`] when the write fails.
    pub fn write_decision(&self, decision: &Decision) -> Result<()> {
        write_json_atomic(&self.decision_path(decision.id), decision)?;
        Ok(())
    }

    /// Write one rule.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::AtomicWrite`] when the write fails.
    pub fn write_rule(&self, rule: &Rule) -> Result<()> {
        write_json_atomic(&self.rule_path(rule.id), rule)?;
        Ok(())
    }

    /// Write the library registry.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::AtomicWrite`] when the write fails.
    pub fn write_libraries(&self, registry: &LibraryRegistry) -> Result<()> {
        write_json_atomic(&self.libraries_path(), registry)?;
        Ok(())
    }

    /// Write the project brief. PRD section 5.12: one file, no UUID of its
    /// own, freely rewritable — unlike a decision row, a brief carries no
    /// append-only rule.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::AtomicWrite`] when the write fails.
    pub fn write_brief(&self, brief: &ProjectBrief) -> Result<()> {
        write_json_atomic(&self.brief_path(), brief)?;
        Ok(())
    }

    /// Write one layout.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::AtomicWrite`] when the write fails.
    pub fn write_layout(&self, layout: &Layout) -> Result<()> {
        write_json_atomic(&self.layout_path(&layout.schematic), layout)?;
        Ok(())
    }

    /// Ingest one run artifact.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::UnknownRunSchema`] when the artifact declares a
    /// schema this build does not read, and [`CoreError::AtomicWrite`] when
    /// the write fails.
    pub fn write_run(&self, node: Uuid, run: &RunArtifact) -> Result<()> {
        if !run.is_known_schema() {
            return Err(CoreError::UnknownRunSchema {
                found: run.schema.clone(),
                expected: crate::run::RUN_SCHEMA_VERSION,
            });
        }
        write_json_atomic(&self.run_path(node, run.run), run)?;
        Ok(())
    }

    /// Move a node's lifecycle on, writing the node and appending the audit
    /// row as the one action PRD section 6.3 allows.
    ///
    /// `node` supplies an id and nothing else trusted: the real lifecycle comes
    /// from disk ([`Store::read_node`]), checked against the table
    /// ([`check_transition`]). `node.lifecycle` is compared against that read
    /// only as the caller's claimed starting state, refused on disagreement
    /// ([`CoreError::StaleTransitionClaim`]). Only the disk copy, the lifecycle
    /// move, and the two side-fields a transition may carry (`stale`,
    /// `superseded_by`) are persisted, never the rest of the caller's copy, and
    /// `stale` is cleared by any move out of it. `node` becomes the real result.
    ///
    /// # Errors
    ///
    /// [`CoreError::Io`]/[`CoreError::Parse`] when the node cannot be read;
    /// [`CoreError::StaleTransitionClaim`] on a disagreeing claim;
    /// [`CoreError::Lifecycle`] when the move or actor is illegal - none of
    /// these write anything. A write failure once checks pass returns
    /// [`CoreError::Io`] or [`CoreError::AtomicWrite`].
    pub fn write_transition(
        &self,
        node: &mut Node,
        to: Lifecycle,
        actor: Actor,
        actor_name: &str,
        at: &str,
        reason: &str,
    ) -> Result<AuditRow> {
        let id = node.id();
        let claimed_from = node.envelope.lifecycle;

        let before = self.read_node(id)?;
        let from = before.envelope.lifecycle;

        if claimed_from != from {
            return Err(CoreError::StaleTransitionClaim {
                id,
                claimed: claimed_from,
                actual: from,
            });
        }

        check_transition(from, to, actor)?;

        let row = AuditRow {
            node: id,
            at: at.to_owned(),
            from,
            to,
            actor,
            actor_name: actor_name.to_owned(),
            reason: reason.to_owned(),
        };

        // The audit is read before anything is written, so an unreadable
        // history fails while the node file on disk is still untouched.
        // PRD section 6.3 calls this pair one action, and a node advanced on
        // disk with no audit row is exactly the half-applied state the
        // append-only rule exists to prevent.
        let mut history = self.read_audit(id)?;
        history.push(row.clone());

        // Built from `before`, the disk copy, not from the caller's `node` -
        // see the doc comment above for why. `stale` and `superseded_by` are
        // the only two fields a transition may carry alongside the lifecycle
        // move, and each is handled on its own terms below.
        let mut after = before.clone();
        after.envelope.lifecycle = to;

        // Carried in on the move into `stale`, and cleared by every move out
        // of it. PRD section 7.4 says a human re-review resolves staleness and
        // that nothing else does, and `stale -> accepted` and `stale ->
        // specified` are that re-review, so leaving the state is what resolves
        // the mark. Gating the copy alone left no path through this function
        // that could clear it. Clearing consults the caller for nothing, so
        // the trust boundary is untouched: a caller still cannot write a value
        // here, only lose one it was never entitled to keep.
        after.envelope.stale = if to == Lifecycle::Stale {
            node.envelope.stale.clone()
        } else {
            None
        };

        // `superseded_by` needs no mirror-image clear. `deprecated` is
        // terminal - no row of the table leaves it - so a successor written on
        // the way in can never be carried into some later state.
        if to == Lifecycle::Deprecated {
            after.envelope.superseded_by = node.envelope.superseded_by;
        }

        self.write_node(&after)?;

        // The node landed and the audit did not. The node file is rewritten
        // with the old state rather than left ahead of its history: a failed
        // rewrite is reported through `TransitionTornWrite`, which names both
        // halves so a person knows the file needs looking at.
        if let Err(error) = write_json_atomic(&self.audit_path(id), &history) {
            return match self.write_node(&before) {
                Ok(()) => Err(error.into()),
                Err(rollback) => Err(CoreError::TransitionTornWrite {
                    id,
                    audit: error.to_string(),
                    rollback: rollback.to_string(),
                }),
            };
        }

        *node = after;
        Ok(row)
    }

    /// A node's audit history, or an empty history when it has none.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::Io`] when the file exists and cannot be read, and
    /// [`CoreError::Parse`] when it holds something other than a row array.
    pub fn read_audit(&self, node: Uuid) -> Result<Vec<AuditRow>> {
        let path = self.audit_path(node);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let text = fs::read_to_string(&path).map_err(|source| CoreError::Io {
            path: path.clone(),
            source,
        })?;
        serde_json::from_str(&text).map_err(|source| CoreError::Parse {
            path,
            schema: "audit",
            source,
        })
    }

    /// Rename a layout file when its Schematic slug changes.
    ///
    /// A missing source file is not an error. Layout is cosmetic, and a rename
    /// of a Schematic nobody has opened yet has nothing to move.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::Io`] when the rename fails.
    pub fn rename_layout(&self, from: &str, to: &str) -> Result<bool> {
        let source = self.layout_path(from);
        if !source.exists() {
            return Ok(false);
        }
        let target = self.layout_path(to);
        fs::rename(&source, &target).map_err(|error| CoreError::Io {
            path: target,
            source: error,
        })?;
        Ok(true)
    }

    /// Refuse to delete a node, per PRD section 6.6.
    ///
    /// Nothing is ever deleted. This method exists so a caller gets the reason
    /// and the reference count rather than a missing method, and so the rule
    /// has somewhere to be tested.
    ///
    /// # Errors
    ///
    /// Always returns [`CoreError::DeleteRefused`].
    pub fn delete_node(&self, graph: &Graph, id: Uuid) -> Result<()> {
        let inbound = graph.dependents(id).len() + graph.children(id).len();
        Err(CoreError::DeleteRefused { id, inbound })
    }

    /// Retire a node by marking it deprecated and naming its replacement.
    ///
    /// This is what PRD section 6.6 offers instead of deletion, and it takes
    /// the same path as any other transition so the audit row is written too.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::Lifecycle`] when the actor may not deprecate, and
    /// an IO error when either write fails.
    pub fn deprecate(
        &self,
        node: &mut Node,
        superseded_by: Option<Uuid>,
        actor: Actor,
        actor_name: &str,
        at: &str,
        reason: &str,
    ) -> Result<AuditRow> {
        node.envelope.superseded_by = superseded_by;
        self.write_transition(node, Lifecycle::Deprecated, actor, actor_name, at, reason)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::Staleness;
    use crate::node::{Authorship, NodeEnvelope, NodeKind};
    use crate::slug::Slug;

    /// The mark a staleness cascade hands in with the move into `stale`,
    /// shaped as PRD section 7.4 draws it: the module whose contract moved,
    /// the member that moved, and when.
    fn mark() -> Staleness {
        Staleness {
            source: Uuid::from_u128(2),
            member: Some("verify-signature".to_owned()),
            at: "2026-08-25T11:40:00Z".to_owned(),
        }
    }

    fn node(id: u128, lifecycle: Lifecycle) -> Node {
        Node::new(NodeEnvelope {
            id: Uuid::from_u128(id),
            slug: Slug::new("token-verifier").unwrap(),
            kind: NodeKind::Module,
            title: "Token Verifier".to_owned(),
            description: None,
            lifecycle,
            layer: None,
            parent: None,
            decisions: Vec::new(),
            authored_by: Authorship::Human,
            created: "2026-08-25T00:00:00Z".to_owned(),
            superseded_by: None,
            stale: None,
        })
    }

    #[test]
    fn every_path_sits_where_the_prd_puts_it() {
        let store = Store::open("C:/work/saas-backend");
        let id = Uuid::from_u128(1);
        let ends = |p: PathBuf| p.to_string_lossy().replace('\\', "/");
        assert!(ends(store.node_path(id))
            .ends_with(".veistra/nodes/00000000-0000-0000-0000-000000000001.json"));
        assert!(ends(store.edge_path(id)).contains(".veistra/edges/"));
        assert!(ends(store.libraries_path()).ends_with(".veistra/registry/libraries.json"));
        assert!(ends(store.brief_path()).ends_with(".veistra/brief.json"));
        assert!(
            ends(store.layout_path("auth-service")).ends_with(".veistra/layout/auth-service.json")
        );
        assert!(ends(store.run_path(id, 1184)).ends_with("/run-1184.json"));
        assert!(ends(store.audit_path(id)).ends_with("/audit.json"));
    }

    #[test]
    fn each_directory_reports_its_layer() {
        let store = Store::open("/p");
        let id = Uuid::from_u128(1);
        assert_eq!(layer_of(&store.node_path(id)), Some(WriteLayer::Semantic));
        assert_eq!(layer_of(&store.edge_path(id)), Some(WriteLayer::Semantic));
        assert_eq!(layer_of(&store.brief_path()), Some(WriteLayer::Semantic));
        assert_eq!(
            layer_of(&store.libraries_path()),
            Some(WriteLayer::Semantic)
        );
        assert_eq!(layer_of(&store.run_path(id, 1)), Some(WriteLayer::Audit));
        assert_eq!(layer_of(&store.audit_path(id)), Some(WriteLayer::Audit));
        assert_eq!(
            layer_of(&store.layout_path("s")),
            Some(WriteLayer::Cosmetic)
        );
        assert_eq!(layer_of(Path::new("/p/src/main.rs")), None);
    }

    #[test]
    fn the_audit_layer_is_the_one_that_outlives_a_branch() {
        assert!(WriteLayer::Semantic.varies_by_branch());
        assert!(WriteLayer::Cosmetic.varies_by_branch());
        assert!(!WriteLayer::Audit.varies_by_branch());
    }

    #[test]
    fn the_gate_passes_one_node_with_one_audit_and_blocks_the_rest() {
        let store = Store::open("/p");
        let id = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);

        assert!(allowed_together(&[
            store.node_path(id),
            store.audit_path(id)
        ]));
        assert!(allowed_together(&[store.node_path(id)]));
        assert!(allowed_together(&[
            store.run_path(id, 1),
            store.run_path(id, 2)
        ]));
        assert!(!allowed_together(&[
            store.node_path(id),
            store.node_path(other),
            store.audit_path(id)
        ]));
        assert!(!allowed_together(&[
            store.node_path(id),
            store.run_path(id, 1184)
        ]));
        assert!(!allowed_together(&[
            store.edge_path(id),
            store.audit_path(id)
        ]));
    }

    #[test]
    fn a_transition_writes_the_node_and_appends_one_audit_row() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Reviewed);
        store.write_node(&value).unwrap();

        store
            .write_transition(
                &mut value,
                Lifecycle::Accepted,
                Actor::Human,
                "m.ross",
                "2026-08-25T14:02:00Z",
                "Accepted.",
            )
            .unwrap();

        assert_eq!(value.envelope.lifecycle, Lifecycle::Accepted);
        let written: Node =
            serde_json::from_str(&fs::read_to_string(store.node_path(value.id())).unwrap())
                .unwrap();
        assert_eq!(written.envelope.lifecycle, Lifecycle::Accepted);
        let history = store.read_audit(value.id()).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].to, Lifecycle::Accepted);
    }

    #[test]
    fn an_agent_transition_to_accepted_writes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Reviewed);
        store.write_node(&value).unwrap();

        let error = store
            .write_transition(
                &mut value,
                Lifecycle::Accepted,
                Actor::Agent,
                "claude-sdd",
                "2026-08-25T14:02:00Z",
                "Tried.",
            )
            .unwrap_err();

        assert!(matches!(error, CoreError::Lifecycle(_)));
        assert_eq!(value.envelope.lifecycle, Lifecycle::Reviewed);
        let on_disk: Node =
            serde_json::from_str(&fs::read_to_string(store.node_path(value.id())).unwrap())
                .unwrap();
        assert_eq!(
            on_disk.envelope.lifecycle,
            Lifecycle::Reviewed,
            "the node file on disk did not advance"
        );
        assert!(store.read_audit(value.id()).unwrap().is_empty());
    }

    /// The exact reproduction from the bug report: a node genuinely `draft`
    /// on disk, a caller claiming it is already `reviewed`, and a legal
    /// `reviewed -> accepted` human move on top of that lie. Before this
    /// fix, `check_transition` validated the table against the caller's
    /// claim rather than disk, so this sailed through and the node reached
    /// `accepted` in one call, skipping every gate along the way - including
    /// the human-review gate `check_transition` exists to enforce.
    #[test]
    fn write_transition_refuses_a_claim_that_disagrees_with_disk() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Draft);
        store.write_node(&value).unwrap();

        // The caller's copy lies about where the node starts.
        value.envelope.lifecycle = Lifecycle::Reviewed;

        let error = store
            .write_transition(
                &mut value,
                Lifecycle::Accepted,
                Actor::Human,
                "human",
                "2026-08-25T14:02:00Z",
                "Accepted.",
            )
            .unwrap_err();

        assert!(
            matches!(
                error,
                CoreError::StaleTransitionClaim {
                    claimed: Lifecycle::Reviewed,
                    actual: Lifecycle::Draft,
                    ..
                }
            ),
            "expected a stale-claim refusal, got {error:?}"
        );
        assert!(store.read_audit(value.id()).unwrap().is_empty());
        let on_disk: Node =
            serde_json::from_str(&fs::read_to_string(store.node_path(value.id())).unwrap())
                .unwrap();
        assert_eq!(
            on_disk.envelope.lifecycle,
            Lifecycle::Draft,
            "the node on disk never left draft"
        );
    }

    /// The second half of the same report: a legal transition (the claim
    /// agrees with disk) whose caller also snuck an edit to `title` into the
    /// same `node` payload. Before this fix, `write_transition` persisted
    /// the caller's whole node, so the title landed on disk alongside the
    /// lifecycle move even though nothing about a lifecycle-only endpoint
    /// asked for that. This proves only the lifecycle field moves.
    #[test]
    fn write_transition_never_persists_the_callers_other_fields() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Reviewed);
        store.write_node(&value).unwrap();

        // The claim agrees with disk - this is otherwise a wholly legal
        // transition - but the payload also carries a forged title.
        value.envelope.title = "CANARY-TITLE-OVERWRITE".to_owned();

        store
            .write_transition(
                &mut value,
                Lifecycle::Accepted,
                Actor::Human,
                "human",
                "2026-08-25T14:02:00Z",
                "Accepted.",
            )
            .unwrap();

        let on_disk: Node =
            serde_json::from_str(&fs::read_to_string(store.node_path(value.id())).unwrap())
                .unwrap();
        assert_eq!(on_disk.envelope.lifecycle, Lifecycle::Accepted);
        assert_eq!(
            on_disk.envelope.title, "Token Verifier",
            "the forged title in the caller's payload was never written"
        );
        // `node` is overwritten with the real, disk-sourced result, so a
        // caller cannot even read its own forged copy back as if it had won.
        assert_eq!(value.envelope.title, "Token Verifier");
    }

    /// One half of the `stale` rule: the mark is the one thing a caller may
    /// hand in alongside the move into `stale`, because the cascade that
    /// fires the move knows the contract that changed and a graph reloaded
    /// afterwards does not.
    #[test]
    fn write_transition_carries_the_staleness_mark_in_on_the_move_to_stale() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Accepted);
        store.write_node(&value).unwrap();

        value.envelope.stale = Some(mark());
        store
            .write_transition(
                &mut value,
                Lifecycle::Stale,
                Actor::System,
                "schematify",
                "2026-08-25T11:40:00Z",
                "An upstream contract changed.",
            )
            .unwrap();

        let on_disk: Node =
            serde_json::from_str(&fs::read_to_string(store.node_path(value.id())).unwrap())
                .unwrap();
        assert_eq!(on_disk.envelope.stale, Some(mark()));
        assert_eq!(value.envelope.stale, Some(mark()));
    }

    /// The other half, and issue #110's regression: the table lets a reviewer
    /// take a node back out of `stale`, and the copy above was gated on
    /// `to == Stale`, so the mark read off disk survived every such move and
    /// nothing reaching this function could clear it. PRD section 7.4 makes a
    /// human re-review the one thing that resolves staleness, and these two
    /// rows are that re-review.
    #[test]
    fn write_transition_clears_the_staleness_mark_when_a_reviewer_resolves_it() {
        for to in [Lifecycle::Accepted, Lifecycle::Specified] {
            let directory = tempfile::tempdir().unwrap();
            let store = Store::open(directory.path());
            store.init().unwrap();
            let mut value = node(1, Lifecycle::Stale);
            value.envelope.stale = Some(mark());
            store.write_node(&value).unwrap();

            store
                .write_transition(
                    &mut value,
                    to,
                    Actor::Human,
                    "m.ross",
                    "2026-08-25T14:02:00Z",
                    "Re-reviewed against the new signature.",
                )
                .unwrap();

            assert_eq!(value.envelope.lifecycle, to);
            assert_eq!(
                value.envelope.stale, None,
                "stale -> {to} resolves the mark"
            );

            let text = fs::read_to_string(store.node_path(value.id())).unwrap();
            let on_disk: Node = serde_json::from_str(&text).unwrap();
            assert_eq!(on_disk.envelope.stale, None);
            assert!(
                !text.contains("\"stale\""),
                "a resolved mark is absent from the file rather than null: {text}"
            );
        }
    }

    #[test]
    fn an_unreadable_audit_leaves_the_node_where_it_was() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Reviewed);
        store.write_node(&value).unwrap();

        // A corrupt audit is the case the ordering exists for: it used to be
        // read after the node file had already been advanced on disk.
        let audit = store.audit_path(value.id());
        fs::create_dir_all(audit.parent().unwrap()).unwrap();
        fs::write(&audit, "{ not an array").unwrap();

        let error = store
            .write_transition(
                &mut value,
                Lifecycle::Accepted,
                Actor::Human,
                "m.ross",
                "2026-08-25T14:02:00Z",
                "Accepted.",
            )
            .unwrap_err();

        assert!(matches!(error, CoreError::Parse { .. }));
        assert_eq!(
            value.envelope.lifecycle,
            Lifecycle::Reviewed,
            "the in-memory node did not advance"
        );
        let on_disk: Node =
            serde_json::from_str(&fs::read_to_string(store.node_path(value.id())).unwrap())
                .unwrap();
        assert_eq!(
            on_disk.envelope.lifecycle,
            Lifecycle::Reviewed,
            "the node file did not advance"
        );
    }

    #[test]
    fn an_illegal_transition_leaves_the_audit_alone() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Draft);
        store.write_node(&value).unwrap();

        let error = store
            .write_transition(
                &mut value,
                Lifecycle::Accepted,
                Actor::Human,
                "m.ross",
                "2026-08-25T14:02:00Z",
                "Skipping the queue.",
            )
            .unwrap_err();

        assert!(matches!(error, CoreError::Lifecycle(_)));
        assert!(store.read_audit(value.id()).unwrap().is_empty());
        let on_disk: Node =
            serde_json::from_str(&fs::read_to_string(store.node_path(value.id())).unwrap())
                .unwrap();
        assert_eq!(
            on_disk.envelope.lifecycle,
            Lifecycle::Draft,
            "the node file on disk did not advance"
        );
    }

    #[test]
    fn a_node_never_transitions_to_the_state_it_is_in() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Deprecated);
        store.write_node(&value).unwrap();

        let error = store
            .write_transition(
                &mut value,
                Lifecycle::Deprecated,
                Actor::Human,
                "m.ross",
                "2026-08-25T14:02:00Z",
                "Again.",
            )
            .unwrap_err();

        assert!(matches!(error, CoreError::Lifecycle(_)));
        assert!(store.read_audit(value.id()).unwrap().is_empty());
    }

    #[test]
    fn audit_rows_accumulate_rather_than_replace() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Draft);
        store.write_node(&value).unwrap();
        for (to, actor) in [
            (Lifecycle::Specified, Actor::Human),
            (Lifecycle::Assigned, Actor::Human),
            (Lifecycle::Implemented, Actor::Agent),
        ] {
            store
                .write_transition(&mut value, to, actor, "who", "2026-08-25T00:00:00Z", "why")
                .unwrap();
        }
        assert_eq!(store.read_audit(value.id()).unwrap().len(), 3);
    }

    #[test]
    fn a_containment_edge_is_never_written() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let edge = Edge::new(
            Uuid::from_u128(9),
            crate::edge::EdgeKind::Contains,
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            "2026-08-25T00:00:00Z",
        );
        assert!(!store.write_edge(&edge).unwrap());
        assert!(!store.edge_path(edge.id).exists());
    }

    #[test]
    fn a_run_with_an_unknown_schema_is_refused_before_it_is_written() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let run = RunArtifact {
            schema: "veistra-bench-v9".to_owned(),
            run: 1,
            at: "2026-08-25T00:00:00Z".to_owned(),
            commit: "abc".to_owned(),
            workflow: "ci/verify.yml".to_owned(),
            budgets: Vec::new(),
            tests: Vec::new(),
            linter: None,
            reconcile: None,
        };
        let error = store.write_run(Uuid::from_u128(1), &run).unwrap_err();
        assert!(matches!(error, CoreError::UnknownRunSchema { .. }));
        assert!(!store.run_path(Uuid::from_u128(1), 1).exists());
    }

    #[test]
    fn a_layout_rename_moves_the_file_and_a_missing_one_is_not_an_error() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        store.write_layout(&Layout::new("auth-service")).unwrap();
        assert!(store
            .rename_layout("auth-service", "identity-service")
            .unwrap());
        assert!(!store.layout_path("auth-service").exists());
        assert!(store.layout_path("identity-service").exists());
        assert!(!store.rename_layout("never-drawn", "elsewhere").unwrap());
    }

    #[test]
    fn deletion_is_refused_and_names_the_reference_count() {
        let store = Store::open("/p");
        let mut graph = Graph::new();
        graph.insert_node(node(1, Lifecycle::Accepted));
        graph.reindex();
        let error = store.delete_node(&graph, Uuid::from_u128(1)).unwrap_err();
        assert!(matches!(error, CoreError::DeleteRefused { inbound: 0, .. }));
    }

    #[test]
    fn deprecation_records_the_replacement_and_the_row() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let mut value = node(1, Lifecycle::Accepted);
        store.write_node(&value).unwrap();
        let row = store
            .deprecate(
                &mut value,
                Some(Uuid::from_u128(2)),
                Actor::Human,
                "m.ross",
                "2026-08-25T00:00:00Z",
                "Replaced.",
            )
            .unwrap();
        assert_eq!(row.to, Lifecycle::Deprecated);
        assert_eq!(value.envelope.superseded_by, Some(Uuid::from_u128(2)));
    }

    #[test]
    fn init_creates_every_directory_the_prd_lists() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        for name in [
            "nodes",
            "edges",
            "screens",
            "flows",
            "decisions",
            "rules",
            "registry",
            "runs",
            "layout",
        ] {
            assert!(store.veistra_dir().join(name).is_dir(), "{name}");
        }
    }

    #[test]
    fn write_brief_writes_the_content_a_reader_gets_back() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let brief = ProjectBrief {
            product_name: "saas-backend".to_owned(),
            problem: "Teams rebuild the same account layer each time.".to_owned(),
            users: vec!["Platform engineers".to_owned()],
            goals: vec!["One auth path".to_owned()],
            non_goals: Vec::new(),
            constraints: Vec::new(),
            success_metrics: Vec::new(),
        };

        store.write_brief(&brief).unwrap();

        let written: ProjectBrief =
            serde_json::from_str(&fs::read_to_string(store.brief_path()).unwrap()).unwrap();
        assert_eq!(written, brief);
    }

    #[test]
    fn write_brief_overwrites_a_prior_brief_in_place() {
        // Unlike a decision row, the brief carries no append-only rule (PRD
        // §5.12 states no such constraint, and §5.9's rule is written on
        // `Decision` alone) — a second write replaces the first rather than
        // being refused.
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        let first = ProjectBrief {
            product_name: "saas-backend".to_owned(),
            problem: "First draft.".to_owned(),
            users: Vec::new(),
            goals: Vec::new(),
            non_goals: Vec::new(),
            constraints: Vec::new(),
            success_metrics: Vec::new(),
        };
        let second = ProjectBrief {
            problem: "Revised.".to_owned(),
            ..first.clone()
        };

        store.write_brief(&first).unwrap();
        store.write_brief(&second).unwrap();

        let written: ProjectBrief =
            serde_json::from_str(&fs::read_to_string(store.brief_path()).unwrap()).unwrap();
        assert_eq!(written, second);
    }
}
