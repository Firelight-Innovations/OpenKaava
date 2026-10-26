//! Ingesting a `veistra-bench-v1` run artifact, per PRD section 8: "Schematify
//! ingests the artifact into `runs/` and draws it."
//!
//! CI runs a probe command and writes the artifact somewhere outside
//! `.veistra/`; nothing in this crate invokes the probe. [`ingest_run_file`] is
//! the entry point a later wave wires to a Tauri command: give it the path
//! CI wrote and the node whose workflow produced the run, and it reads,
//! validates and writes the file. [`ingest_run`] is the pure half for a
//! caller that has already parsed the artifact, such as a test.
//!
//! Two things ingestion checks before it writes anything, because a run file
//! is audit evidence and PRD section 6.6 forbids losing a reference in
//! silence. First, every budget the artifact reports must match a `budget`
//! node under the scope it is filed against - [`crate::Graph::runs_for_budget`]
//! is only as good as this check, since a metric nothing points at is a
//! result nobody can find. Second, a run number already on disk is never
//! overwritten; a stale or malformed re-ingestion must not corrupt a run
//! that already landed.

use std::fs;
use std::path::Path;

use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::graph::Graph;
use crate::run::{read_run_artifact, RunArtifact, RunReadError};
use crate::store::Store;

/// Ingest an already-parsed run artifact under `scope`'s run tree.
///
/// `scope` is the node whose CI workflow produced the run - the module or
/// service the probe command ran under, per the fixture's `token-verifier`
/// run - not a budget node itself, since one workflow answers several
/// budgets in one file.
///
/// # Errors
///
/// Returns [`CoreError::UnknownRunScope`] when `scope` names no node in
/// `graph`. Returns [`CoreError::RunAnswersNoBudget`] when a budget result
/// matches no `budget` node that is a direct child of `scope`. Returns
/// [`CoreError::RunAlreadyIngested`] when a run already sits at that run
/// number, so a repeat or corrupted re-ingestion cannot overwrite it.
/// Returns [`CoreError::UnknownRunSchema`] or [`CoreError::AtomicWrite`] from
/// the underlying [`Store::write_run`].
pub fn ingest_run(graph: &Graph, store: &Store, scope: Uuid, artifact: RunArtifact) -> Result<()> {
    if graph.node(scope).is_none() {
        return Err(CoreError::UnknownRunScope { scope });
    }

    for result in &artifact.budgets {
        let answered = graph
            .children(scope)
            .iter()
            .filter_map(|&child| graph.node(child))
            .filter_map(|node| node.budget().ok())
            .any(|fields| fields.metric == result.metric);
        if !answered {
            return Err(CoreError::RunAnswersNoBudget {
                scope,
                metric: result.metric.clone(),
            });
        }
    }

    let target = store.run_path(scope, artifact.run);
    if target.exists() {
        return Err(CoreError::RunAlreadyIngested {
            scope,
            run: artifact.run,
        });
    }

    store.write_run(scope, &artifact)
}

/// Read a run artifact from disk and ingest it under `scope`.
///
/// The read uses the same version-probe [`read_run_artifact`] that
/// [`crate::load_project`] applies to a file already inside `runs/`, so a
/// future format CI has not been taught to Schematify yet is reported by
/// version rather than by an opaque parse failure.
///
/// # Errors
///
/// Returns [`CoreError::Io`] when `path` cannot be read,
/// [`CoreError::UnknownRunSchema`] when the file names a schema this build
/// does not read, [`CoreError::Parse`] when a current-version file fails its
/// closed-schema parse, and everything [`ingest_run`] can return.
pub fn ingest_run_file(graph: &Graph, store: &Store, scope: Uuid, path: &Path) -> Result<()> {
    let bytes = fs::read(path).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;

    let artifact = read_run_artifact(&bytes).map_err(|error| match error {
        RunReadError::UnknownSchema(found) => CoreError::UnknownRunSchema {
            found,
            expected: crate::run::RUN_SCHEMA_VERSION,
        },
        RunReadError::Malformed(source) => CoreError::Parse {
            path: path.to_path_buf(),
            schema: "run",
            source,
        },
    })?;

    ingest_run(graph, store, scope, artifact)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::Lifecycle;
    use crate::load::load_project;
    use crate::node::{Authorship, BudgetFields, BudgetTier, Node, NodeEnvelope, NodeKind};
    use crate::run::{BudgetResult, RUN_SCHEMA_VERSION};
    use crate::slug::Slug;

    fn project() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path());
        store.init().unwrap();
        (directory, store)
    }

    fn node(id: u128, slug: &str, kind: NodeKind, parent: Option<u128>) -> Node {
        Node::new(NodeEnvelope {
            id: Uuid::from_u128(id),
            slug: Slug::new(slug).unwrap(),
            kind,
            title: slug.to_owned(),
            description: None,
            lifecycle: Lifecycle::Specified,
            layer: None,
            parent: parent.map(Uuid::from_u128),
            decisions: Vec::new(),
            authored_by: Authorship::Human,
            created: "2026-08-25T00:00:00Z".to_owned(),
            superseded_by: None,
            stale: None,
        })
    }

    fn budget_node(id: u128, slug: &str, parent: u128, metric: &str) -> Node {
        let mut n = node(id, slug, NodeKind::Budget, Some(parent));
        n = n
            .with_fields(&BudgetFields {
                metric: metric.to_owned(),
                op: "<".to_owned(),
                value: 3.0,
                unit: "ms".to_owned(),
                tier: BudgetTier::Hard,
                probe: None,
                sign_off: None,
            })
            .unwrap();
        n
    }

    fn sample_artifact(run: u64, metrics: &[&str]) -> RunArtifact {
        RunArtifact {
            schema: RUN_SCHEMA_VERSION.to_owned(),
            run,
            at: "2026-08-25T14:02:00Z".to_owned(),
            commit: "4f2c9ab".to_owned(),
            workflow: "ci/verify.yml".to_owned(),
            budgets: metrics
                .iter()
                .map(|metric| BudgetResult {
                    metric: (*metric).to_owned(),
                    value: 1.8,
                    unit: "ms".to_owned(),
                    pass: true,
                })
                .collect(),
            tests: Vec::new(),
            linter: None,
            reconcile: None,
        }
    }

    #[test]
    fn ingesting_a_run_writes_it_and_the_graph_finds_it_from_its_budget() {
        let (directory, store) = project();
        let scope = node(1, "token-verifier", NodeKind::Module, None);
        store.write_node(&scope).unwrap();
        let budget = budget_node(2, "verify-p95", 1, "verify_p95");
        store.write_node(&budget).unwrap();

        let artifact = sample_artifact(1184, &["verify_p95"]);
        let outcome = load_project(directory.path()).unwrap();
        ingest_run(&outcome.graph, &store, Uuid::from_u128(1), artifact.clone()).unwrap();

        assert!(store.run_path(Uuid::from_u128(1), 1184).exists());

        let reloaded = load_project(directory.path()).unwrap();
        assert!(
            reloaded.report.is_clean(),
            "{:?}",
            reloaded.report.quarantined
        );
        let found = reloaded.graph.runs_for_budget(Uuid::from_u128(2));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0], &artifact);
    }

    #[test]
    fn ingesting_under_a_scope_the_graph_does_not_know_is_refused() {
        let (_directory, store) = project();
        let graph = Graph::new();
        let error =
            ingest_run(&graph, &store, Uuid::from_u128(9), sample_artifact(1, &[])).unwrap_err();
        assert!(
            matches!(error, CoreError::UnknownRunScope { scope } if scope == Uuid::from_u128(9))
        );
        assert!(!store.run_path(Uuid::from_u128(9), 1).exists());
    }

    #[test]
    fn a_budget_result_matching_no_budget_node_is_refused_before_any_write() {
        let (directory, store) = project();
        let scope = node(1, "token-verifier", NodeKind::Module, None);
        store.write_node(&scope).unwrap();
        // No budget child at all, so `cold_start_p95` cannot be found by any
        // reader afterward.
        let outcome = load_project(directory.path()).unwrap();

        let error = ingest_run(
            &outcome.graph,
            &store,
            Uuid::from_u128(1),
            sample_artifact(1184, &["cold_start_p95"]),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            CoreError::RunAnswersNoBudget { scope, ref metric }
                if scope == Uuid::from_u128(1) && metric == "cold_start_p95"
        ));
        assert!(
            !store.run_path(Uuid::from_u128(1), 1184).exists(),
            "an unfindable run is never written"
        );
    }

    #[test]
    fn a_second_ingestion_at_the_same_run_number_never_overwrites_the_first() {
        let (directory, store) = project();
        let scope = node(1, "token-verifier", NodeKind::Module, None);
        store.write_node(&scope).unwrap();
        let budget = budget_node(2, "verify-p95", 1, "verify_p95");
        store.write_node(&budget).unwrap();
        let outcome = load_project(directory.path()).unwrap();

        let first = sample_artifact(1184, &["verify_p95"]);
        ingest_run(&outcome.graph, &store, Uuid::from_u128(1), first.clone()).unwrap();

        let mut corrupt = sample_artifact(1184, &["verify_p95"]);
        corrupt.commit = "different-commit".to_owned();
        let error = ingest_run(&outcome.graph, &store, Uuid::from_u128(1), corrupt).unwrap_err();
        assert!(matches!(
            error,
            CoreError::RunAlreadyIngested { scope, run }
                if scope == Uuid::from_u128(1) && run == 1184
        ));

        let bytes = fs::read(store.run_path(Uuid::from_u128(1), 1184)).unwrap();
        let on_disk = read_run_artifact(&bytes).unwrap();
        assert_eq!(
            on_disk, first,
            "the first run is exactly what is still on disk"
        );
    }

    #[test]
    fn ingest_run_file_reads_from_disk_and_ingests() {
        let (directory, store) = project();
        let scope = node(1, "token-verifier", NodeKind::Module, None);
        store.write_node(&scope).unwrap();
        let budget = budget_node(2, "verify-p95", 1, "verify_p95");
        store.write_node(&budget).unwrap();
        let outcome = load_project(directory.path()).unwrap();

        let dropped = directory.path().join("ci-output.json");
        let artifact = sample_artifact(7, &["verify_p95"]);
        fs::write(&dropped, serde_json::to_vec(&artifact).unwrap()).unwrap();

        ingest_run_file(&outcome.graph, &store, Uuid::from_u128(1), &dropped).unwrap();
        assert!(store.run_path(Uuid::from_u128(1), 7).exists());
    }

    #[test]
    fn ingest_run_file_reports_an_unknown_schema_by_version() {
        let (directory, store) = project();
        let scope = node(1, "token-verifier", NodeKind::Module, None);
        store.write_node(&scope).unwrap();
        let outcome = load_project(directory.path()).unwrap();

        let dropped = directory.path().join("ci-output.json");
        fs::write(
            &dropped,
            serde_json::to_vec(&serde_json::json!({
                "schema": "veistra-bench-v9",
                "run": 1,
                "at": "2026-08-25T00:00:00Z",
                "commit": "abc",
                "workflow": "ci/verify.yml"
            }))
            .unwrap(),
        )
        .unwrap();

        let error =
            ingest_run_file(&outcome.graph, &store, Uuid::from_u128(1), &dropped).unwrap_err();
        assert!(matches!(
            error,
            CoreError::UnknownRunSchema { found, .. } if found == "veistra-bench-v9"
        ));
        assert!(!store.run_path(Uuid::from_u128(1), 1).exists());
    }
}
