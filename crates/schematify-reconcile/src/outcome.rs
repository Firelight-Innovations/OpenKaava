//! Reconciliation outcomes (PRD `SCHEMATIFY-PRD.md` section 9.2): one variant
//! per row of the outcome table, each carrying the evidence that produced it
//! so a caller can render a reason rather than just a verdict.

use std::path::PathBuf;

use serde::Serialize;
use uuid::Uuid;

use crate::scan::Occurrence;

/// The JSON key and drawn string PRD section 9.2 assigns to one outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeKind {
    /// The design element and the code site agree.
    Matched,
    /// The design declares the element and no marker exists.
    DeclaredAbsent,
    /// A marker exists and no node carries that identifier.
    PresentUnknown,
    /// One identifier sits at 2 or more code sites.
    Duplicate,
}

impl OutcomeKind {
    /// The wireframe string every surface and log line draws (PRD section
    /// 9.2's "Drawn string" column). The JSON key is this enum's own
    /// `snake_case` serialization, per the same table.
    #[must_use]
    pub fn drawn(self) -> &'static str {
        match self {
            OutcomeKind::Matched => "matched",
            OutcomeKind::DeclaredAbsent => "declared, absent",
            OutcomeKind::PresentUnknown => "present, unknown",
            OutcomeKind::Duplicate => "duplicate",
        }
    }
}

/// One marker occurrence's location, restated as evidence without pulling
/// [`Occurrence`]'s id and slug into every outcome that already names them
/// at the top level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceSite {
    /// The file the marker was found in.
    pub file: PathBuf,
    /// 1-based line number within `file`.
    pub line: usize,
}

impl From<&Occurrence> for EvidenceSite {
    fn from(occurrence: &Occurrence) -> Self {
        EvidenceSite {
            file: occurrence.file.clone(),
            line: occurrence.line,
        }
    }
}

/// One reconciliation outcome, with the evidence that produced it. The
/// `runs/<node-uuid>/` directory PRD section 9.3 writes into is keyed by
/// [`ReconcileOutcome::node_id`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ReconcileOutcome {
    /// The design element and the code site agree (PRD 9.2 row 1). Pass.
    Matched {
        /// The graph node's id, equal to the marker's id.
        node_id: Uuid,
        /// The graph node's slug.
        slug: String,
        /// Where the marker was found.
        site: EvidenceSite,
    },

    /// The design declares the element and no marker exists in code (PRD 9.2
    /// row 2). `error` is `true` once the node's `lifecycle` has reached
    /// `implemented` or later on the lifecycle path (PRD section 7.1) — the
    /// table's "Error after `lifecycle` reaches `implemented`."
    DeclaredAbsent {
        /// The graph node's id.
        node_id: Uuid,
        /// The graph node's slug.
        slug: String,
        /// The graph node's `lifecycle` field.
        lifecycle: String,
        /// Whether this occurrence counts toward exit code 1.
        error: bool,
    },

    /// A marker exists and no node carries that identifier (PRD 9.2 row 3).
    /// Always an error.
    PresentUnknown {
        /// The marker's own id — there is no graph node to key this by, so
        /// the id found in code stands in.
        node_id: Uuid,
        /// Where the marker was found.
        site: EvidenceSite,
    },

    /// One identifier sits at 2 or more code sites (PRD 9.2 row 4). Always
    /// an error.
    Duplicate {
        /// The shared marker id.
        node_id: Uuid,
        /// Every site the id was found at — 2 or more by construction.
        sites: Vec<EvidenceSite>,
    },
}

impl ReconcileOutcome {
    /// This outcome's [`OutcomeKind`].
    #[must_use]
    pub fn kind(&self) -> OutcomeKind {
        match self {
            ReconcileOutcome::Matched { .. } => OutcomeKind::Matched,
            ReconcileOutcome::DeclaredAbsent { .. } => OutcomeKind::DeclaredAbsent,
            ReconcileOutcome::PresentUnknown { .. } => OutcomeKind::PresentUnknown,
            ReconcileOutcome::Duplicate { .. } => OutcomeKind::Duplicate,
        }
    }

    /// The node id `runs/<node-uuid>/reconcile.json` is written under for
    /// this outcome (PRD section 9.3).
    #[must_use]
    pub fn node_id(&self) -> Uuid {
        match self {
            ReconcileOutcome::Matched { node_id, .. }
            | ReconcileOutcome::DeclaredAbsent { node_id, .. }
            | ReconcileOutcome::PresentUnknown { node_id, .. }
            | ReconcileOutcome::Duplicate { node_id, .. } => *node_id,
        }
    }

    /// Whether this outcome counts toward `veistra reconcile`'s exit code 1
    /// (PRD section 9.3: "Exit code 1 means one or more error outcomes").
    #[must_use]
    pub fn is_error(&self) -> bool {
        match self {
            ReconcileOutcome::Matched { .. } => false,
            ReconcileOutcome::DeclaredAbsent { error, .. } => *error,
            ReconcileOutcome::PresentUnknown { .. } | ReconcileOutcome::Duplicate { .. } => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn matched_is_never_an_error() {
        let outcome = ReconcileOutcome::Matched {
            node_id: id(),
            slug: "x".into(),
            site: site(),
        };
        assert!(!outcome.is_error());
        assert_eq!(outcome.kind(), OutcomeKind::Matched);
        assert_eq!(outcome.kind().drawn(), "matched");
    }

    #[test]
    fn declared_absent_error_follows_its_own_flag() {
        let not_yet = ReconcileOutcome::DeclaredAbsent {
            node_id: id(),
            slug: "x".into(),
            lifecycle: "specified".into(),
            error: false,
        };
        assert!(!not_yet.is_error());

        let overdue = ReconcileOutcome::DeclaredAbsent {
            node_id: id(),
            slug: "x".into(),
            lifecycle: "implemented".into(),
            error: true,
        };
        assert!(overdue.is_error());
        assert_eq!(overdue.kind().drawn(), "declared, absent");
    }

    #[test]
    fn present_unknown_and_duplicate_are_always_errors() {
        let present_unknown = ReconcileOutcome::PresentUnknown {
            node_id: id(),
            site: site(),
        };
        assert!(present_unknown.is_error());
        assert_eq!(present_unknown.kind().drawn(), "present, unknown");

        let duplicate = ReconcileOutcome::Duplicate {
            node_id: id(),
            sites: vec![site(), site()],
        };
        assert!(duplicate.is_error());
        assert_eq!(duplicate.kind().drawn(), "duplicate");
    }

    #[test]
    fn node_id_is_readable_uniformly_across_variants() {
        let outcomes = vec![
            ReconcileOutcome::Matched {
                node_id: id(),
                slug: "x".into(),
                site: site(),
            },
            ReconcileOutcome::DeclaredAbsent {
                node_id: id(),
                slug: "x".into(),
                lifecycle: "draft".into(),
                error: false,
            },
            ReconcileOutcome::PresentUnknown {
                node_id: id(),
                site: site(),
            },
            ReconcileOutcome::Duplicate {
                node_id: id(),
                sites: vec![site()],
            },
        ];
        for outcome in outcomes {
            assert_eq!(outcome.node_id(), id());
        }
    }

    #[test]
    fn json_keys_match_prd_section_9_2() {
        let outcome = ReconcileOutcome::Matched {
            node_id: id(),
            slug: "x".into(),
            site: site(),
        };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["outcome"], "matched");
    }
}
