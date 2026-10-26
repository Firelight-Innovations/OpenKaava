//! Compares markers found in code against nodes in the design graph and
//! produces one [`ReconcileOutcome`] per marker identifier the run touches,
//! on either side (PRD `SCHEMATIFY-PRD.md` section 9.2).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use uuid::Uuid;

use crate::graph::GraphLookup;
use crate::outcome::{EvidenceSite, ReconcileOutcome};
use crate::scan::{scan_tree, Occurrence, SkippedFile};

/// Lifecycle states at or after `implemented` on the lifecycle path (PRD
/// section 7.1: `draft → specified → assigned → implemented → reviewed →
/// accepted`, plus `stale` off the path). PRD section 9.2 marks
/// `declared_absent` an error "after `lifecycle` reaches `implemented`" —
/// `stale` is included because a node only reaches `stale` by having already
/// been `accepted`, so it has necessarily passed `implemented`. `deprecated`
/// is deliberately excluded: a superseded node is not expected to still be
/// backed by live code.
const LIFECYCLE_REQUIRES_MARKER: [&str; 4] = ["implemented", "reviewed", "accepted", "stale"];

/// The result of reconciling one tree against one graph.
#[derive(Debug, Clone, Default)]
pub struct ReconcileRun {
    /// One outcome per marker identifier touched by either the scan or the
    /// graph's markable set.
    pub outcomes: Vec<ReconcileOutcome>,
    /// Files the scan could not read as text.
    pub skipped: Vec<SkippedFile>,
}

/// Scan `root` for marker tokens and reconcile them against `graph` (PRD
/// section 9.2). Every marker id found in code, and every markable node id
/// in the graph, is covered by exactly one outcome.
pub fn reconcile(root: &Path, graph: &dyn GraphLookup) -> ReconcileRun {
    let scan = scan_tree(root);

    let mut by_id: HashMap<Uuid, Vec<Occurrence>> = HashMap::new();
    for occurrence in scan.occurrences {
        by_id.entry(occurrence.id).or_default().push(occurrence);
    }

    let mut outcomes = Vec::with_capacity(by_id.len());
    let mut seen: HashSet<Uuid> = HashSet::with_capacity(by_id.len());

    // `by_id`'s hash-map order is nondeterministic; keep the run itself
    // reproducible for a caller comparing two runs of the same tree.
    let mut ids: Vec<Uuid> = by_id.keys().copied().collect();
    ids.sort();

    for id in ids {
        seen.insert(id);
        let occurrences = &by_id[&id];

        if occurrences.len() > 1 {
            outcomes.push(ReconcileOutcome::Duplicate {
                node_id: id,
                sites: occurrences.iter().map(EvidenceSite::from).collect(),
            });
            continue;
        }

        let occurrence = &occurrences[0];
        match graph.lookup(id) {
            Some(facts) => outcomes.push(ReconcileOutcome::Matched {
                node_id: id,
                slug: facts.slug,
                site: EvidenceSite::from(occurrence),
            }),
            None => outcomes.push(ReconcileOutcome::PresentUnknown {
                node_id: id,
                site: EvidenceSite::from(occurrence),
            }),
        }
    }

    let mut markable_ids = graph.markable_node_ids();
    markable_ids.sort();
    for id in markable_ids {
        if seen.contains(&id) {
            continue;
        }
        let Some(facts) = graph.lookup(id) else {
            // A `GraphLookup` implementation that returns an id from
            // `markable_node_ids` but not from `lookup` is inconsistent with
            // its own contract; skip rather than fabricate an outcome for a
            // node that, by this same call, does not exist.
            continue;
        };
        let error = LIFECYCLE_REQUIRES_MARKER.contains(&facts.lifecycle.as_str());
        outcomes.push(ReconcileOutcome::DeclaredAbsent {
            node_id: id,
            slug: facts.slug,
            lifecycle: facts.lifecycle,
            error,
        });
    }

    ReconcileRun {
        outcomes,
        skipped: scan.skipped,
    }
}

/// Whether any outcome in `run` counts as an error (PRD section 9.3).
#[must_use]
pub fn has_error(run: &ReconcileRun) -> bool {
    run.outcomes.iter().any(ReconcileOutcome::is_error)
}

/// `veistra reconcile`'s exit code for `run`, per PRD section 9.3: 0 with no
/// error outcome, 1 with one or more. (Exit code 2 — "the command read no
/// project at that path" — is decided earlier, before a `ReconcileRun`
/// exists at all; see `src/bin/veistra.rs`.)
#[must_use]
pub fn exit_code(run: &ReconcileRun) -> u8 {
    u8::from(has_error(run))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{InMemoryGraph, NodeFacts};
    use std::fs;

    fn id(last: &str) -> Uuid {
        Uuid::parse_str(&format!("0192f4a1-4c3d-7890-a1b2-{last}")).unwrap()
    }

    fn write_marker(root: &Path, rel: &str, marker_id: Uuid, slug: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, format!("// @veistra:{marker_id} {slug}\n")).unwrap();
    }

    #[test]
    fn matched_when_graph_and_code_agree() {
        let dir = tempfile::tempdir().unwrap();
        let target = id("000000000001");
        write_marker(dir.path(), "src/lib.rs", target, "thing.run");

        let graph = InMemoryGraph::new().with_node(
            NodeFacts {
                id: target,
                slug: "thing.run".into(),
                kind: "contract-method".into(),
                lifecycle: "implemented".into(),
            },
            true,
        );

        let run = reconcile(dir.path(), &graph);
        assert_eq!(run.outcomes.len(), 1);
        assert!(
            matches!(&run.outcomes[0], ReconcileOutcome::Matched { node_id, .. } if *node_id == target)
        );
        assert!(!has_error(&run));
        assert_eq!(exit_code(&run), 0);
    }

    #[test]
    fn declared_absent_is_only_an_error_once_lifecycle_reaches_implemented() {
        let dir = tempfile::tempdir().unwrap();
        let target = id("000000000002");

        let draft_graph = InMemoryGraph::new().with_node(
            NodeFacts {
                id: target,
                slug: "thing.run".into(),
                kind: "contract-method".into(),
                lifecycle: "specified".into(),
            },
            true,
        );
        let run = reconcile(dir.path(), &draft_graph);
        assert_eq!(run.outcomes.len(), 1);
        assert!(matches!(
            &run.outcomes[0],
            ReconcileOutcome::DeclaredAbsent { error: false, .. }
        ));
        assert!(!has_error(&run));

        let implemented_graph = InMemoryGraph::new().with_node(
            NodeFacts {
                id: target,
                slug: "thing.run".into(),
                kind: "contract-method".into(),
                lifecycle: "implemented".into(),
            },
            true,
        );
        let run = reconcile(dir.path(), &implemented_graph);
        assert!(matches!(
            &run.outcomes[0],
            ReconcileOutcome::DeclaredAbsent { error: true, .. }
        ));
        assert!(has_error(&run));
        assert_eq!(exit_code(&run), 1);
    }

    #[test]
    fn present_unknown_when_no_node_carries_the_id() {
        let dir = tempfile::tempdir().unwrap();
        let target = id("000000000003");
        write_marker(dir.path(), "src/lib.rs", target, "ghost.run");

        let graph = InMemoryGraph::new();
        let run = reconcile(dir.path(), &graph);
        assert_eq!(run.outcomes.len(), 1);
        assert!(
            matches!(&run.outcomes[0], ReconcileOutcome::PresentUnknown { node_id, .. } if *node_id == target)
        );
        assert!(has_error(&run));
        assert_eq!(exit_code(&run), 1);
    }

    #[test]
    fn duplicate_when_one_id_sits_at_two_sites() {
        let dir = tempfile::tempdir().unwrap();
        let target = id("000000000004");
        write_marker(dir.path(), "src/a.rs", target, "thing.run");
        write_marker(dir.path(), "src/b.rs", target, "thing.run");

        let graph = InMemoryGraph::new().with_node(
            NodeFacts {
                id: target,
                slug: "thing.run".into(),
                kind: "contract-method".into(),
                lifecycle: "implemented".into(),
            },
            true,
        );

        let run = reconcile(dir.path(), &graph);
        assert_eq!(run.outcomes.len(), 1);
        match &run.outcomes[0] {
            ReconcileOutcome::Duplicate { node_id, sites } => {
                assert_eq!(*node_id, target);
                assert_eq!(sites.len(), 2);
            }
            other => panic!("expected Duplicate, got {other:?}"),
        }
        assert!(has_error(&run));
        assert_eq!(exit_code(&run), 1);
    }

    #[test]
    fn a_matched_or_duplicate_id_does_not_also_report_declared_absent() {
        let dir = tempfile::tempdir().unwrap();
        let target = id("000000000005");
        write_marker(dir.path(), "src/a.rs", target, "thing.run");
        write_marker(dir.path(), "src/b.rs", target, "thing.run");

        let graph = InMemoryGraph::new().with_node(
            NodeFacts {
                id: target,
                slug: "thing.run".into(),
                kind: "contract-method".into(),
                lifecycle: "implemented".into(),
            },
            true,
        );

        let run = reconcile(dir.path(), &graph);
        // Only the Duplicate outcome — not also DeclaredAbsent for the same id.
        assert_eq!(run.outcomes.len(), 1);
    }

    #[test]
    fn a_run_with_no_markers_and_no_markable_nodes_has_no_outcomes() {
        let dir = tempfile::tempdir().unwrap();
        let graph = InMemoryGraph::new();
        let run = reconcile(dir.path(), &graph);
        assert!(run.outcomes.is_empty());
        assert!(!has_error(&run));
        assert_eq!(exit_code(&run), 0);
    }
}
