//! The edge schema of PRD section 5.6 and the typed edge kinds of section 11.1.
//!
//! Two relations run through Schematify and they are never merged. Containment
//! is a strict tree drawn as nesting, and it stores no edge file at all - the
//! `parent` field on the child holds it. Dependency is a directed acyclic
//! graph drawn as a line with an arrowhead, and it is what this module is for.
//!
//! The wireframe footer states the rule in six words: `contains = nesting`,
//! `depends_on = drawn`. A `contains` variant exists in [`EdgeKind`] because
//! PRD section 11.1 lists it in the vocabulary, and [`Edge::is_stored`] is how
//! a caller finds out it is the one kind that never becomes a file.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Which tier an edge kind belongs to, per PRD section 11.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EdgeTier {
    /// Tiers 1 and 2: services and modules.
    Structural,
    /// Tier 3: facets. The vocabulary here is closed.
    Facet,
}

/// The typed edge vocabulary of PRD section 11.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// The containment tree. Drawn as nesting, never as a line, never stored.
    Contains,
    /// What a node calls. Drawn as a line with an arrowhead at the target.
    DependsOn,
    /// A node realising an interface another node declares.
    Implements,
    /// A module backing a product screen. Authoritative over the `ui_refs`
    /// cache on the module, per PRD section 5.11.
    ReferencesUi,
    /// A test case covering a contract method. This is coverage of design, and
    /// line coverage never reports that number.
    Covers,
    /// Something meeting a budget. An external dep satisfying a budget is
    /// legal, and is the case the Module Schematic calls out.
    Satisfies,
    /// A doc block describing a node.
    Documents,
}

impl EdgeKind {
    /// The word this kind writes into JSON.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Contains => "contains",
            Self::DependsOn => "depends_on",
            Self::Implements => "implements",
            Self::ReferencesUi => "references_ui",
            Self::Covers => "covers",
            Self::Satisfies => "satisfies",
            Self::Documents => "documents",
        }
    }

    /// Which tier this kind belongs to.
    #[must_use]
    pub fn tier(self) -> EdgeTier {
        match self {
            Self::Contains | Self::DependsOn | Self::Implements | Self::ReferencesUi => {
                EdgeTier::Structural
            }
            Self::Covers | Self::Satisfies | Self::Documents => EdgeTier::Facet,
        }
    }

    /// Every kind, so a surface can offer the vocabulary without repeating it.
    #[must_use]
    pub fn all() -> [Self; 7] {
        [
            Self::Contains,
            Self::DependsOn,
            Self::Implements,
            Self::ReferencesUi,
            Self::Covers,
            Self::Satisfies,
            Self::Documents,
        ]
    }

    /// Whether this kind is semantic, and so refused on an annotation node.
    ///
    /// Every kind is. PRD section 11.3 has no decorative edge to exempt, and
    /// the method exists so linter rule L05 reads as the rule rather than as a
    /// bare `true`: a later decorative kind would otherwise slip past it
    /// because nobody noticed the check was a constant.
    #[must_use]
    pub fn is_semantic(self) -> bool {
        true
    }
}

impl fmt::Display for EdgeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One edge file under `.veistra/edges/`.
///
/// Closed to unknown fields for the reason [`crate::Screen`] gives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    /// The UUIDv7 of this edge.
    pub id: Uuid,
    /// What kind of relation it is.
    pub kind: EdgeKind,
    /// Where the relation starts. Direction runs source to target.
    pub source: Uuid,
    /// Where it ends. The arrowhead is drawn here.
    pub target: Uuid,
    /// The named port it leaves from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_port: Option<String>,
    /// The named port it arrives at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_port: Option<String>,
    /// When the edge was created, as an RFC 3339 timestamp.
    pub created: String,
    /// The replacement, once this edge is deprecated. Nothing is deleted.
    #[serde(default)]
    pub superseded_by: Option<Uuid>,
}

impl Edge {
    /// An edge with the two ports left unnamed.
    #[must_use]
    pub fn new(id: Uuid, kind: EdgeKind, source: Uuid, target: Uuid, created: &str) -> Self {
        Self {
            id,
            kind,
            source,
            target,
            source_port: None,
            target_port: None,
            created: created.to_owned(),
            superseded_by: None,
        }
    }

    /// Whether this edge becomes a file.
    ///
    /// A `contains` relation does not: the `parent` field on the child node
    /// holds it, and a second copy in `edges/` would be a second source of
    /// truth for the one relation the graph most needs to be a tree.
    #[must_use]
    pub fn is_stored(&self) -> bool {
        self.kind != EdgeKind::Contains
    }

    /// Whether this edge is live, rather than superseded.
    #[must_use]
    pub fn is_live(&self) -> bool {
        self.superseded_by.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(kind: EdgeKind) -> Edge {
        Edge::new(
            Uuid::from_u128(1),
            kind,
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            "2026-08-25T00:00:00Z",
        )
    }

    #[test]
    fn an_edge_round_trips() {
        let value = edge(EdgeKind::DependsOn);
        let text = serde_json::to_string(&value).unwrap();
        assert_eq!(serde_json::from_str::<Edge>(&text).unwrap(), value);
    }

    #[test]
    fn an_edge_writes_the_prd_field_names() {
        let mut value = edge(EdgeKind::ReferencesUi);
        value.source_port = Some("out".to_owned());
        value.target_port = Some("in".to_owned());
        let json = serde_json::to_value(&value).unwrap();
        assert_eq!(json["kind"], "references_ui");
        assert_eq!(json["source_port"], "out");
        assert_eq!(json["target_port"], "in");
        assert_eq!(json["superseded_by"], serde_json::Value::Null);
    }

    #[test]
    fn containment_is_the_one_kind_that_is_never_a_file() {
        assert!(!edge(EdgeKind::Contains).is_stored());
        for kind in EdgeKind::all()
            .into_iter()
            .filter(|k| *k != EdgeKind::Contains)
        {
            assert!(edge(kind).is_stored(), "{kind} should be stored");
        }
    }

    #[test]
    fn the_tiers_split_the_vocabulary_as_the_prd_does() {
        for kind in [
            EdgeKind::Contains,
            EdgeKind::DependsOn,
            EdgeKind::Implements,
            EdgeKind::ReferencesUi,
        ] {
            assert_eq!(kind.tier(), EdgeTier::Structural, "{kind}");
        }
        for kind in [EdgeKind::Covers, EdgeKind::Satisfies, EdgeKind::Documents] {
            assert_eq!(kind.tier(), EdgeTier::Facet, "{kind}");
        }
        assert!(EdgeKind::all().iter().all(|k| k.is_semantic()));
    }

    #[test]
    fn a_superseded_edge_is_not_live() {
        let mut value = edge(EdgeKind::Covers);
        assert!(value.is_live());
        value.superseded_by = Some(Uuid::from_u128(4));
        assert!(!value.is_live());
    }
}
