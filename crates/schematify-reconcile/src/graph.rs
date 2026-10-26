//! The seam between this crate and a real Schematify design graph.
//!
//! `crates/schematify-core` — the graph loader — is built in parallel by
//! another wave and this crate must not depend on it. Reconciliation depends
//! only on [`GraphLookup`], small enough that implementing it later is one
//! `impl` block and no change to [`crate::reconcile`].
//!
//! Two implementations ship today: [`InMemoryGraph`], for tests, and
//! [`JsonFileGraph`], which reads `.veistra/nodes/*.json` off disk (PRD section
//! 6.1) so `veistra reconcile` runs against a real project without linking
//! `schematify-core`.
//
// For the wiring wave: implement `GraphLookup` for whatever `schematify-core`
// exposes as its loaded graph, and pass that (or `&dyn GraphLookup`) in place
// of `JsonFileGraph`. Nothing else in this crate needs to change.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use uuid::Uuid;

/// The facts about one graph node that reconciliation needs: its slug, its
/// kind, and its lifecycle state. `kind` and `lifecycle` are carried as the
/// wire strings from the common node envelope (PRD section 5.1) rather than
/// as enums copied from `schematify-core` — this crate does not get to
/// depend on that crate's types any more than its code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeFacts {
    /// The node's id.
    pub id: Uuid,
    /// The node's `slug` field.
    pub slug: String,
    /// The node's `kind` field, e.g. `"contract-method"`.
    pub kind: String,
    /// The node's `lifecycle` field, e.g. `"implemented"`.
    pub lifecycle: String,
}

/// The entire dependency [`crate::reconcile::reconcile`] has on a design
/// graph.
pub trait GraphLookup {
    /// Look up a node by id. `None` if no node with that id exists anywhere
    /// in the graph.
    fn lookup(&self, id: Uuid) -> Option<NodeFacts>;

    /// Every node id the design expects to carry a marker in code — the set
    /// checked for the `declared_absent` outcome (PRD section 9.2).
    fn markable_node_ids(&self) -> Vec<Uuid>;
}

/// An in-memory [`GraphLookup`], for tests and for a caller that already has
/// a parsed graph in some other shape.
#[derive(Debug, Default, Clone)]
pub struct InMemoryGraph {
    nodes: HashMap<Uuid, NodeFacts>,
    markable: Vec<Uuid>,
}

impl InMemoryGraph {
    /// An empty graph.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a node. `markable` sets whether its id is returned from
    /// [`GraphLookup::markable_node_ids`].
    #[must_use]
    pub fn with_node(mut self, facts: NodeFacts, markable: bool) -> Self {
        let id = facts.id;
        self.nodes.insert(id, facts);
        if markable {
            self.markable.push(id);
        }
        self
    }
}

impl GraphLookup for InMemoryGraph {
    fn lookup(&self, id: Uuid) -> Option<NodeFacts> {
        self.nodes.get(&id).cloned()
    }

    fn markable_node_ids(&self) -> Vec<Uuid> {
        self.markable.clone()
    }
}

/// An error loading a [`JsonFileGraph`] from disk.
#[derive(Debug, thiserror::Error)]
pub enum GraphLoadError {
    /// `<root>/.veistra/nodes` does not exist — PRD section 9.3's "the command
    /// read no project at that path," mapped to `veistra reconcile`'s exit
    /// code 2 by the binary.
    #[error("no project found at {0}: `.veistra/nodes` does not exist")]
    NoProject(PathBuf),

    /// A node file could not be read.
    #[error("failed to read {path}: {source}")]
    Io {
        /// The file that failed to read.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },

    /// A node file's content was not the expected JSON shape.
    #[error("failed to parse {path}: {source}")]
    Parse {
        /// The file that failed to parse.
        path: PathBuf,
        /// The underlying JSON error.
        source: serde_json::Error,
    },
}

/// The fields of the common node envelope (PRD section 5.1) this crate reads,
/// plus `impl_ref` — present on the `test-case` facet (PRD section 5.5) and
/// potentially on a future facet kind. Every other field — `title`,
/// `description`, `parent`, `decisions`, `authored_by`, `created`,
/// `superseded_by`, and any other facet-specific field — is present in a real
/// node file and ignored here; `serde` drops unknown fields by default, so no
/// `deny_unknown_fields` is set.
#[derive(Debug, Deserialize)]
struct NodeEnvelope {
    id: Uuid,
    slug: String,
    kind: String,
    lifecycle: String,
    /// A code implementation this node declares, if any. `serde`'s
    /// `Option<T>` deserializer already treats a JSON `null` the same as a
    /// missing key, so this is `None` whether the field is absent or
    /// explicitly `null`.
    #[serde(default)]
    impl_ref: Option<serde_json::Value>,
}

/// A [`GraphLookup`] backed by `.veistra/nodes/*.json` on disk (PRD section
/// 6.1), where every node kind — service, module, and every facet — is one
/// file. This is the stand-in for `schematify-core`'s in-process graph: it
/// answers the same questions from the same files, just re-read from disk
/// per `veistra reconcile` invocation rather than kept live in memory.
#[derive(Debug)]
pub struct JsonFileGraph {
    nodes: HashMap<Uuid, NodeFacts>,
    /// Ids of nodes whose file declared a non-null `impl_ref` — see
    /// [`GraphLookup::markable_node_ids`]'s doc comment on this impl.
    markable: Vec<Uuid>,
}

impl JsonFileGraph {
    /// Load every node under `<root>/.veistra/nodes/*.json`. Fails with
    /// [`GraphLoadError::NoProject`] if that directory does not exist; a node
    /// file that fails to read or parse is a hard error rather than a silent
    /// skip, since a corrupt node file is itself something reconciliation
    /// should surface, not paper over.
    pub fn load(root: &Path) -> Result<Self, GraphLoadError> {
        let nodes_dir = root.join(".veistra").join("nodes");
        if !nodes_dir.is_dir() {
            return Err(GraphLoadError::NoProject(root.to_path_buf()));
        }

        let mut nodes = HashMap::new();
        let mut markable = Vec::new();
        let entries = fs::read_dir(&nodes_dir).map_err(|source| GraphLoadError::Io {
            path: nodes_dir.clone(),
            source,
        })?;

        for entry in entries {
            let entry = entry.map_err(|source| GraphLoadError::Io {
                path: nodes_dir.clone(),
                source,
            })?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }

            let content = fs::read_to_string(&path).map_err(|source| GraphLoadError::Io {
                path: path.clone(),
                source,
            })?;
            let envelope: NodeEnvelope =
                serde_json::from_str(&content).map_err(|source| GraphLoadError::Parse {
                    path: path.clone(),
                    source,
                })?;

            if envelope.impl_ref.is_some() {
                markable.push(envelope.id);
            }

            nodes.insert(
                envelope.id,
                NodeFacts {
                    id: envelope.id,
                    slug: envelope.slug,
                    kind: envelope.kind,
                    lifecycle: envelope.lifecycle,
                },
            );
        }

        Ok(Self { nodes, markable })
    }
}

impl GraphLookup for JsonFileGraph {
    fn lookup(&self, id: Uuid) -> Option<NodeFacts> {
        self.nodes.get(&id).cloned()
    }

    /// A node is markable — expected to carry a `@veistra:` marker in code —
    /// when its file declares a non-null `impl_ref`, not by matching its
    /// `kind` against a fixed list. PRD section 9.1 says every design
    /// element *with a counterpart in code* carries a marker, and `impl_ref`
    /// (PRD section 5.5) is the schema's own way of a node declaring that it
    /// has one; driving this off the data means a future facet kind that
    /// adds an `impl_ref`-shaped field is covered automatically, with no
    /// list here to fall out of step with the schema. If Braden narrows this
    /// back to specific kinds, this is the one place to change it — see
    /// `docs/overnight-jobs/overnight-2/handoffs/w9a-reconcile.md`.
    fn markable_node_ids(&self) -> Vec<Uuid> {
        self.markable.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn node_json(
        id: &str,
        slug: &str,
        kind: &str,
        lifecycle: &str,
        impl_ref: Option<&str>,
    ) -> String {
        let impl_ref_field = match impl_ref {
            Some(value) => format!("\"{value}\""),
            None => "null".to_string(),
        };
        format!(
            r#"{{
                "id": "{id}",
                "slug": "{slug}",
                "kind": "{kind}",
                "title": "Title",
                "description": "Description",
                "lifecycle": "{lifecycle}",
                "authored_by": "human",
                "created": "2026-08-25T00:00:00Z",
                "superseded_by": null,
                "impl_ref": {impl_ref_field}
            }}"#
        )
    }

    #[test]
    fn in_memory_graph_round_trips() {
        let id = Uuid::parse_str("0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8").unwrap();
        let graph = InMemoryGraph::new().with_node(
            NodeFacts {
                id,
                slug: "thing".into(),
                kind: "contract-method".into(),
                lifecycle: "implemented".into(),
            },
            true,
        );
        assert_eq!(graph.lookup(id).unwrap().slug, "thing");
        assert_eq!(graph.markable_node_ids(), vec![id]);
    }

    #[test]
    fn missing_veistra_dir_is_no_project() {
        let dir = tempfile::tempdir().unwrap();
        let err = JsonFileGraph::load(dir.path()).unwrap_err();
        assert!(matches!(err, GraphLoadError::NoProject(_)));
    }

    #[test]
    fn loads_nodes_and_filters_markable_by_impl_ref_not_kind() {
        let dir = tempfile::tempdir().unwrap();
        let nodes_dir = dir.path().join(".veistra").join("nodes");
        fs::create_dir_all(&nodes_dir).unwrap();

        // A `test-case` facet (PRD 5.5) declaring an `impl_ref` is markable...
        fs::write(
            nodes_dir.join("0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8.json"),
            node_json(
                "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8",
                "verify-signature-test",
                "test-case",
                "implemented",
                Some("@veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 verify_signature_test"),
            ),
        )
        .unwrap();
        // ...but a `module` node with no `impl_ref` is not, regardless of kind.
        fs::write(
            nodes_dir.join("0192f4a2-4c3d-7890-a1b2-c3d4e5f6a7b8.json"),
            node_json(
                "0192f4a2-4c3d-7890-a1b2-c3d4e5f6a7b8",
                "token-verifier",
                "module",
                "accepted",
                None,
            ),
        )
        .unwrap();
        // A `contract-method` with no `impl_ref` is likewise not markable —
        // the decision follows the data, not a kind whitelist.
        fs::write(
            nodes_dir.join("0192f4a3-4c3d-7890-a1b2-c3d4e5f6a7b8.json"),
            node_json(
                "0192f4a3-4c3d-7890-a1b2-c3d4e5f6a7b8",
                "verify-signature",
                "contract-method",
                "implemented",
                None,
            ),
        )
        .unwrap();

        let graph = JsonFileGraph::load(dir.path()).unwrap();
        let markable = graph.markable_node_ids();
        assert_eq!(markable.len(), 1);
        assert_eq!(
            markable[0].to_string(),
            "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8"
        );

        let module_id = Uuid::parse_str("0192f4a2-4c3d-7890-a1b2-c3d4e5f6a7b8").unwrap();
        assert_eq!(graph.lookup(module_id).unwrap().kind, "module");
    }
}
