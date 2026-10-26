//! The run artifact of PRD section 5.10, schema `veistra-bench-v1`.
//!
//! Schematify never invokes a probe. CI runs it, emits one of these, and
//! Schematify ingests the file into `runs/` and draws it. That one-way flow is
//! what lets a `git clone` plus the project owner's own CI produce every
//! number Schematify displays, with Schematify uninstalled.
//!
//! The `schema` field carries the version and a reader that meets an unknown
//! value rejects the file and reports the version. It is not skipped and not
//! guessed at: a run file is audit data, and a reader that quietly interprets
//! a future format under an old one writes a wrong number into a sign-off
//! record.
//!
//! The four reconciliation keys and the four strings drawn for them differ,
//! per PRD section 9.2. The JSON key is what this module holds;
//! [`ReconcileResult::drawn`] is the mapping to the drawn form.
//!
//! [`read_run_artifact`] is the probe reader itself, shared by the loader and
//! by ingestion so both read a file's version the same way.

use serde::{Deserialize, Serialize};

/// The one artifact schema this build reads.
pub const RUN_SCHEMA_VERSION: &str = "veistra-bench-v1";

/// One budget measured by one run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetResult {
    /// What was measured, matching the `metric` on a budget facet.
    pub metric: String,
    /// What the probe reported.
    pub value: f64,
    /// The unit.
    pub unit: String,
    /// Whether the value met the threshold.
    pub pass: bool,
}

/// One test measured by one run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestResult {
    /// The marker token that binds this result to a test-case facet.
    pub impl_ref: String,
    /// What the run reported, as a `test-case` status word.
    pub status: String,
    /// How long it took.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<f64>,
}

/// What the code linter found on one run.
///
/// This counts the rule registry of PRD section 10.2, not the Schematify graph
/// linter of section 10.4. The two produce different numbers on the same
/// project and neither is a Schematify constant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinterResult {
    /// How many rules ran.
    pub rules: u32,
    /// How many violations they found.
    pub violations: u32,
}

/// What reconciliation found on one run, per PRD section 9.2.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReconcileResult {
    /// The design element and the code site agree.
    #[serde(default)]
    pub matched: u32,
    /// The design declares the element and no marker exists.
    #[serde(default)]
    pub declared_absent: u32,
    /// A marker exists and no node carries that identifier.
    #[serde(default)]
    pub present_unknown: u32,
    /// One identifier sits at two or more code sites.
    #[serde(default)]
    pub duplicate: u32,
}

impl ReconcileResult {
    /// The four counts against the strings every surface and every log line
    /// draws for them.
    ///
    /// The drawn form is not the JSON key: `declared_absent` is drawn
    /// `declared, absent`. Both spellings are fixed, and this is the one place
    /// the mapping lives so a surface cannot invent a third.
    #[must_use]
    pub fn drawn(&self) -> [(&'static str, u32); 4] {
        [
            ("matched", self.matched),
            ("declared, absent", self.declared_absent),
            ("present, unknown", self.present_unknown),
            ("duplicate", self.duplicate),
        ]
    }

    /// How many outcomes are errors.
    ///
    /// `declared_absent` counts only after the node reaches `implemented`, so
    /// a caller passes that in rather than having this type guess at a
    /// lifecycle it cannot see.
    #[must_use]
    pub fn error_count(&self, count_declared_absent: bool) -> u32 {
        self.present_unknown
            + self.duplicate
            + if count_declared_absent {
                self.declared_absent
            } else {
                0
            }
    }
}

/// One ingested CI result set, stored at `runs/<node-uuid>/run-<n>.json`.
///
/// Closed to unknown fields, and the `schema` field is what makes that safe:
/// a later format declares a new version, and a reader that meets one rejects
/// the file by version rather than by field. [`crate::Screen`] states the
/// general rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunArtifact {
    /// The artifact schema version.
    pub schema: String,
    /// The run number.
    pub run: u64,
    /// When the run happened, as an RFC 3339 timestamp.
    pub at: String,
    /// The commit it ran against.
    pub commit: String,
    /// The workflow that produced it.
    pub workflow: String,
    /// What the budget probes reported.
    #[serde(default)]
    pub budgets: Vec<BudgetResult>,
    /// What the tests reported.
    #[serde(default)]
    pub tests: Vec<TestResult>,
    /// What the code linter reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linter: Option<LinterResult>,
    /// What reconciliation reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconcile: Option<ReconcileResult>,
}

/// Just enough of a run artifact to read its version.
///
/// [`load_project`](crate::load_project) and [`ingest_run_file`](crate::ingest_run_file)
/// both read a version through this before touching [`RunArtifact`] itself,
/// so the two paths cannot drift into reading the version two different ways.
#[derive(Deserialize)]
struct SchemaProbe {
    schema: String,
}

/// Read a run artifact from raw bytes, probing the `schema` field before
/// deserializing the rest.
///
/// `RunArtifact` denies unknown fields, and the only reason a future format
/// bumps `schema` is to add one. Deserializing straight into `RunArtifact`
/// would turn that file into a parse error that names no version, which is
/// the one thing PRD section 5.10 requires a reader to report. Reading the
/// version through [`SchemaProbe`] first keeps that report possible.
///
/// # Errors
///
/// Returns [`RunReadError::UnknownSchema`] naming the version this build
/// does not read, without attempting the full parse. Returns
/// [`RunReadError::Malformed`] when even the probe cannot read `schema`, or
/// when a current-version file fails the full parse (an unknown field, most
/// often).
pub fn read_run_artifact(bytes: &[u8]) -> std::result::Result<RunArtifact, RunReadError> {
    let probe: SchemaProbe = serde_json::from_slice(bytes).map_err(RunReadError::Malformed)?;
    if probe.schema != RUN_SCHEMA_VERSION {
        return Err(RunReadError::UnknownSchema(probe.schema));
    }
    serde_json::from_slice(bytes).map_err(RunReadError::Malformed)
}

/// Why [`read_run_artifact`] could not produce a [`RunArtifact`].
#[derive(Debug, thiserror::Error)]
pub enum RunReadError {
    /// The probe read a `schema` this build does not know. Carries the value
    /// so a caller can report it, per PRD section 5.10.
    #[error("run artifact declares unknown schema {0:?}")]
    UnknownSchema(String),
    /// The bytes were not a run artifact at all, or a known-version one
    /// failed its closed-schema parse.
    #[error("run artifact could not be parsed")]
    Malformed(#[source] serde_json::Error),
}

impl RunArtifact {
    /// Whether this build reads the schema this file declares.
    #[must_use]
    pub fn is_known_schema(&self) -> bool {
        self.schema == RUN_SCHEMA_VERSION
    }

    /// How many budgets passed, out of how many ran.
    ///
    /// Computed, never stored. PRD section 0.4 applies to a run counter the
    /// same way it applies to a node count.
    #[must_use]
    pub fn budgets_passing(&self) -> (usize, usize) {
        (
            self.budgets.iter().filter(|b| b.pass).count(),
            self.budgets.len(),
        )
    }

    /// How many tests passed, out of how many ran.
    #[must_use]
    pub fn tests_passing(&self) -> (usize, usize) {
        (
            self.tests.iter().filter(|t| t.status == "passing").count(),
            self.tests.len(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RunArtifact {
        RunArtifact {
            schema: RUN_SCHEMA_VERSION.to_owned(),
            run: 1184,
            at: "2026-08-25T14:02:00Z".to_owned(),
            commit: "4f2c9ab".to_owned(),
            workflow: "ci/verify.yml".to_owned(),
            budgets: vec![
                BudgetResult {
                    metric: "verify_p95".to_owned(),
                    value: 1.8,
                    unit: "ms".to_owned(),
                    pass: true,
                },
                BudgetResult {
                    metric: "cold_start_p95".to_owned(),
                    value: 9.0,
                    unit: "ms".to_owned(),
                    pass: false,
                },
            ],
            tests: vec![
                TestResult {
                    impl_ref: "@veistra:0192f4a1".to_owned(),
                    status: "passing".to_owned(),
                    ms: Some(41.0),
                },
                TestResult {
                    impl_ref: "@veistra:0192f4a2".to_owned(),
                    status: "failing".to_owned(),
                    ms: None,
                },
            ],
            linter: Some(LinterResult {
                rules: 14,
                violations: 0,
            }),
            reconcile: Some(ReconcileResult {
                matched: 7,
                declared_absent: 1,
                present_unknown: 0,
                duplicate: 0,
            }),
        }
    }

    #[test]
    fn a_run_artifact_round_trips() {
        let run = sample();
        let text = serde_json::to_string(&run).unwrap();
        assert_eq!(serde_json::from_str::<RunArtifact>(&text).unwrap(), run);
    }

    #[test]
    fn a_known_schema_is_recognised_and_an_unknown_one_is_not() {
        let mut run = sample();
        assert!(run.is_known_schema());
        run.schema = "veistra-bench-v2".to_owned();
        assert!(!run.is_known_schema());
    }

    #[test]
    fn the_counters_are_computed_rather_than_read_from_a_field() {
        let run = sample();
        assert_eq!(run.budgets_passing(), (1, 2));
        assert_eq!(run.tests_passing(), (1, 2));
        let value = serde_json::to_value(&run).unwrap();
        let keys = value.as_object().unwrap();
        assert!(!keys.contains_key("budgets_passing"));
        assert!(!keys.contains_key("tests_passing"));
    }

    #[test]
    fn read_run_artifact_accepts_a_known_schema() {
        let run = sample();
        let bytes = serde_json::to_vec(&run).unwrap();
        assert_eq!(read_run_artifact(&bytes).unwrap(), run);
    }

    #[test]
    fn read_run_artifact_names_the_version_of_a_future_schema_rather_than_parsing() {
        // Shaped like a later format that added a field current `RunArtifact`
        // would refuse. Reaching `UnknownSchema` rather than `Malformed`
        // proves the probe ran before the full deserialize.
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schema": "veistra-bench-v9",
            "run": 9,
            "at": "2026-08-25T00:00:00Z",
            "commit": "abc",
            "workflow": "ci/verify.yml",
            "carbon_grams": 4.2
        }))
        .unwrap();
        match read_run_artifact(&bytes) {
            Err(RunReadError::UnknownSchema(version)) => {
                assert_eq!(version, "veistra-bench-v9");
            }
            other => panic!("expected UnknownSchema, got {other:?}"),
        }
    }

    #[test]
    fn read_run_artifact_reports_a_current_version_with_an_unknown_field_as_malformed() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schema": RUN_SCHEMA_VERSION,
            "run": 10,
            "at": "2026-08-25T00:00:00Z",
            "commit": "abc",
            "workflow": "ci/verify.yml",
            "carbon_grams": 4.2
        }))
        .unwrap();
        assert!(matches!(
            read_run_artifact(&bytes),
            Err(RunReadError::Malformed(_))
        ));
    }

    #[test]
    fn read_run_artifact_reports_bytes_with_no_schema_field_as_malformed() {
        let bytes = serde_json::to_vec(&serde_json::json!({ "run": 11 })).unwrap();
        assert!(matches!(
            read_run_artifact(&bytes),
            Err(RunReadError::Malformed(_))
        ));
    }

    #[test]
    fn the_four_reconciliation_keys_map_to_the_four_drawn_strings() {
        let reconcile = ReconcileResult {
            matched: 7,
            declared_absent: 1,
            present_unknown: 0,
            duplicate: 0,
        };
        assert_eq!(
            reconcile.drawn(),
            [
                ("matched", 7),
                ("declared, absent", 1),
                ("present, unknown", 0),
                ("duplicate", 0),
            ]
        );
        let value = serde_json::to_value(reconcile).unwrap();
        assert_eq!(value["declared_absent"], 1);
    }

    #[test]
    fn declared_absent_counts_as_an_error_only_once_implemented() {
        let reconcile = ReconcileResult {
            matched: 7,
            declared_absent: 1,
            present_unknown: 2,
            duplicate: 1,
        };
        assert_eq!(reconcile.error_count(false), 3);
        assert_eq!(reconcile.error_count(true), 4);
    }
}
