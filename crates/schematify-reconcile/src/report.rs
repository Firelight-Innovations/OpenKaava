//! Writing reconciliation results: `.veistra/runs/<node-uuid>/reconcile.json`
//! per marker identifier touched (PRD `SCHEMATIFY-PRD.md` section 9.3), and
//! the consolidated report `veistra reconcile --out` writes or prints, in
//! `text` or `json` form.
//!
//! Section 9.3 names the path `runs/<node-uuid>/reconcile.json` but not its
//! schema; section 6.1's storage layout is what puts the `runs/` tree inside
//! `.veistra/`, alongside `nodes/` — the same root [`crate::graph::JsonFileGraph`]
//! reads from. This crate settles the schema itself on the outcome plus a
//! `schema` tag and a timestamp, mirroring how the `run-<n>.json` bench
//! artifact carries a `schema` field (section 5.10) so a future reader can
//! version it. The file is overwritten on every run — its name carries no run
//! number, unlike `run-<n>.json`, so "the latest reconciliation of this node"
//! is read without picking a number.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::outcome::ReconcileOutcome;
use crate::reconcile::ReconcileRun;
use crate::scan::SkippedFile;

/// The `schema` tag written into every `reconcile.json`.
pub const RECONCILE_SCHEMA: &str = "veistra-reconcile-v1";

/// An error writing reconciliation output to disk.
#[derive(Debug, thiserror::Error)]
pub enum ReportError {
    /// Writing a file failed.
    #[error("failed to write {path}: {source}")]
    Io {
        /// The file that failed to write.
        path: PathBuf,
        /// The underlying I/O error.
        source: io::Error,
    },
    /// Encoding a value as JSON failed.
    #[error("failed to encode {path} as JSON: {source}")]
    Json {
        /// The file the encoding was for.
        path: PathBuf,
        /// The underlying JSON error.
        source: serde_json::Error,
    },
}

#[derive(Debug, Serialize)]
struct NodeReconcileFile<'a> {
    schema: &'static str,
    at: String,
    #[serde(flatten)]
    outcome: &'a ReconcileOutcome,
}

/// Write one `<root>/.veistra/runs/<node-uuid>/reconcile.json` per outcome in
/// `run` (PRD section 6.1 puts `runs/` inside `.veistra/`, beside `nodes/`).
pub fn write_run_files(root: &Path, run: &ReconcileRun) -> Result<(), ReportError> {
    let runs_dir = root.join(".veistra").join("runs");
    let now = now_rfc3339();

    for outcome in &run.outcomes {
        let dir = runs_dir.join(outcome.node_id().to_string());
        fs::create_dir_all(&dir).map_err(|source| ReportError::Io {
            path: dir.clone(),
            source,
        })?;

        let file_path = dir.join("reconcile.json");
        let payload = NodeReconcileFile {
            schema: RECONCILE_SCHEMA,
            at: now.clone(),
            outcome,
        };
        let json = serde_json::to_string_pretty(&payload).map_err(|source| ReportError::Json {
            path: file_path.clone(),
            source,
        })?;
        fs::write(&file_path, json).map_err(|source| ReportError::Io {
            path: file_path,
            source,
        })?;
    }

    Ok(())
}

/// Per-[`crate::outcome::OutcomeKind`] counts, for the consolidated report's
/// summary line and for a caller that wants section 5.10's
/// `{matched, declared_absent, present_unknown, duplicate}` shape directly.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Summary {
    /// Count of `matched` outcomes.
    pub matched: usize,
    /// Count of `declared_absent` outcomes.
    pub declared_absent: usize,
    /// Count of `present_unknown` outcomes.
    pub present_unknown: usize,
    /// Count of `duplicate` outcomes.
    pub duplicate: usize,
}

/// Count `run`'s outcomes by kind.
#[must_use]
pub fn summarize(run: &ReconcileRun) -> Summary {
    let mut summary = Summary::default();
    for outcome in &run.outcomes {
        match outcome {
            ReconcileOutcome::Matched { .. } => summary.matched += 1,
            ReconcileOutcome::DeclaredAbsent { .. } => summary.declared_absent += 1,
            ReconcileOutcome::PresentUnknown { .. } => summary.present_unknown += 1,
            ReconcileOutcome::Duplicate { .. } => summary.duplicate += 1,
        }
    }
    summary
}

#[derive(Debug, Serialize)]
struct JsonReport<'a> {
    summary: Summary,
    outcomes: &'a [ReconcileOutcome],
    skipped: &'a [SkippedFile],
}

/// Render `run` as the `--format json` consolidated report.
///
/// # Errors
///
/// Returns an error if the report cannot be encoded as JSON — not expected in
/// practice, since every field is a plain string, number, or nested struct,
/// but `serde_json::to_string_pretty` returns a `Result` and this crate does
/// not silently discard it.
pub fn render_json(run: &ReconcileRun) -> Result<String, serde_json::Error> {
    let report = JsonReport {
        summary: summarize(run),
        outcomes: &run.outcomes,
        skipped: &run.skipped,
    };
    serde_json::to_string_pretty(&report)
}

/// Render `run` as the `--format text` consolidated report, using PRD section
/// 9.2's drawn strings.
#[must_use]
pub fn render_text(run: &ReconcileRun) -> String {
    let mut out = String::new();
    for outcome in &run.outcomes {
        let line = match outcome {
            ReconcileOutcome::Matched {
                node_id,
                slug,
                site,
            } => {
                format!(
                    "matched  {node_id} {slug}  {}:{}",
                    site.file.display(),
                    site.line
                )
            }
            ReconcileOutcome::DeclaredAbsent {
                node_id,
                slug,
                lifecycle,
                error,
            } => {
                let flag = if *error { "error" } else { "ok" };
                format!("declared, absent  {node_id} {slug}  lifecycle={lifecycle}  [{flag}]")
            }
            ReconcileOutcome::PresentUnknown { node_id, site } => {
                format!(
                    "present, unknown  {node_id}  {}:{}",
                    site.file.display(),
                    site.line
                )
            }
            ReconcileOutcome::Duplicate { node_id, sites } => {
                let locations: Vec<String> = sites
                    .iter()
                    .map(|site| format!("{}:{}", site.file.display(), site.line))
                    .collect();
                format!("duplicate  {node_id}  {}", locations.join(", "))
            }
        };
        out.push_str(&line);
        out.push('\n');
    }

    let summary = summarize(run);
    out.push_str(&format!(
        "\n{} matched, {} declared absent, {} present unknown, {} duplicate\n",
        summary.matched, summary.declared_absent, summary.present_unknown, summary.duplicate
    ));

    if !run.skipped.is_empty() {
        out.push_str(&format!(
            "{} file(s) skipped (unreadable or binary)\n",
            run.skipped.len()
        ));
    }

    out
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{GraphLookup, InMemoryGraph, NodeFacts};
    use crate::outcome::EvidenceSite;
    use crate::reconcile::reconcile;
    use std::fs;
    use uuid::Uuid;

    fn id() -> Uuid {
        Uuid::parse_str("0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8").unwrap()
    }

    fn site() -> EvidenceSite {
        EvidenceSite {
            file: PathBuf::from("src/lib.rs"),
            line: 1,
        }
    }

    #[test]
    fn writes_one_reconcile_json_per_outcome_keyed_by_node_id() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/lib.rs"),
            format!("// @veistra:{} thing.run\n", id()),
        )
        .unwrap();

        let graph: Box<dyn GraphLookup> = Box::new(InMemoryGraph::new().with_node(
            NodeFacts {
                id: id(),
                slug: "thing.run".into(),
                kind: "contract-method".into(),
                lifecycle: "implemented".into(),
            },
            true,
        ));

        let run = reconcile(root, graph.as_ref());
        write_run_files(root, &run).unwrap();

        let written = root
            .join(".veistra")
            .join("runs")
            .join(id().to_string())
            .join("reconcile.json");
        assert!(written.is_file());

        let content = fs::read_to_string(&written).unwrap();
        let value: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(value["schema"], RECONCILE_SCHEMA);
        assert_eq!(value["outcome"], "matched");
        assert_eq!(value["node_id"], id().to_string());
        assert!(value["at"].is_string());
    }

    #[test]
    fn summary_counts_match_outcome_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let graph = InMemoryGraph::new();
        let run = reconcile(root, &graph);
        let summary = summarize(&run);
        assert_eq!(summary.matched, 0);
        assert_eq!(summary.declared_absent, 0);
        assert_eq!(summary.present_unknown, 0);
        assert_eq!(summary.duplicate, 0);
    }

    #[test]
    fn summary_counts_a_mixed_run_into_its_own_buckets() {
        // The empty-run case above passes even if `summarize` puts every
        // outcome into the wrong bucket, as long as it puts zero of them
        // there. This is the case that would catch that: a known number of
        // each of the four kinds, each landing in its own count.
        let run = ReconcileRun {
            outcomes: vec![
                ReconcileOutcome::Matched {
                    node_id: id(),
                    slug: "a".into(),
                    site: site(),
                },
                ReconcileOutcome::Matched {
                    node_id: id(),
                    slug: "b".into(),
                    site: site(),
                },
                ReconcileOutcome::DeclaredAbsent {
                    node_id: id(),
                    slug: "c".into(),
                    lifecycle: "implemented".into(),
                    error: true,
                },
                ReconcileOutcome::PresentUnknown {
                    node_id: id(),
                    site: site(),
                },
                ReconcileOutcome::PresentUnknown {
                    node_id: id(),
                    site: site(),
                },
                ReconcileOutcome::PresentUnknown {
                    node_id: id(),
                    site: site(),
                },
                ReconcileOutcome::Duplicate {
                    node_id: id(),
                    sites: vec![site(), site()],
                },
            ],
            skipped: Vec::new(),
        };
        let summary = summarize(&run);
        assert_eq!(summary.matched, 2);
        assert_eq!(summary.declared_absent, 1);
        assert_eq!(summary.present_unknown, 3);
        assert_eq!(summary.duplicate, 1);
    }

    #[test]
    fn render_text_uses_the_drawn_strings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("lib.rs"), format!("// @veistra:{} thing\n", id())).unwrap();
        let graph = InMemoryGraph::new();
        let run = reconcile(root, &graph);
        let text = render_text(&run);
        assert!(text.contains("present, unknown"));
    }

    #[test]
    fn render_json_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let graph = InMemoryGraph::new();
        let run = reconcile(root, &graph);
        let json = render_json(&run).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value["summary"].is_object());
        assert!(value["outcomes"].is_array());
    }
}
