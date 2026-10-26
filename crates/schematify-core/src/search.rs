//! Global search of PRD section 12.16, behind an index boundary.
//!
//! **[`SearchIndex`] is the boundary.** A shell adapter depends on that trait
//! and on [`SearchHit`], never on [`GraphIndex`] or on anything inside it.
//! That is deliberate: PRD section 12.16 says the index rebuilds on load and
//! updates on every semantic write, and neither the storage nor the matching
//! is settled. A caller holding `&dyn SearchIndex` survives all of it.
//!
//! **A hit carries what the result row draws.** Section 12.16 asks for results
//! grouped by kind with the breadcrumb path to each hit, so a hit carries its
//! kind, its breadcrumb and the `schematify://` reference to open. The
//! breadcrumb comes from the same function the Problems panel uses, because
//! two answers to "where is this drawn" would drift apart.
//!
//! Matching is a linear scan over a flat vector of entries, each carrying its
//! searchable text lowercased once at build time. That is not clever, and it
//! does not need to be: the whole stress fixture is 2000 entries and PRD
//! section 14.7 allows 100 ms for a first result.

use serde::{Deserialize, Serialize};

use crate::graph::Graph;
use crate::lint::location_of;
use crate::node::{Node, NodeKind};
use crate::registry::Rule;
use crate::uri::Uri;

/// How many results a caller gets when it does not say.
pub const DEFAULT_LIMIT: usize = 20;

/// What a search index answers, and the whole of what a shell adapter needs.
///
/// The trait is the boundary of PRD wave 8. An adapter takes a
/// `&dyn SearchIndex`, so replacing the linear scan below with a real
/// inverted index changes nothing above it.
pub trait SearchIndex {
    /// The best hits for a query, already ranked and truncated.
    ///
    /// An empty or whitespace-only query returns nothing rather than
    /// everything, because `Ctrl+K` opens on an empty field.
    fn search(&self, query: &str, limit: usize) -> Vec<SearchHit>;

    /// How many things are indexed. A surface draws it; a test asserts it.
    fn entry_count(&self) -> usize;

    /// Whether the index holds nothing.
    fn is_empty(&self) -> bool {
        self.entry_count() == 0
    }
}

/// Which collection a hit came from, and the group it is drawn under.
///
/// PRD section 12.16 lists nodes, contract methods and test cases separately,
/// and all three are nodes, so the node kind travels with the variant rather
/// than being flattened away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "collection", rename_all = "snake_case")]
pub enum HitKind {
    /// A design node. The kind is what the group heading reads.
    Node {
        /// Which kind of node.
        kind: NodeKind,
    },
    /// One entry of the rule registry.
    Rule,
    /// One entry of the library registry.
    Library,
    /// A product screen.
    Screen,
    /// A product flow.
    Flow,
    /// A decision log entry.
    Decision,
}

impl HitKind {
    /// The heading the result group draws.
    #[must_use]
    pub fn heading(&self) -> String {
        match self {
            Self::Node { kind } => kind.as_str().to_owned(),
            Self::Rule => "rule".to_owned(),
            Self::Library => "library".to_owned(),
            Self::Screen => "screen".to_owned(),
            Self::Flow => "flow".to_owned(),
            Self::Decision => "decision".to_owned(),
        }
    }
}

/// Why a hit matched, which is also how it ranks.
///
/// The first five are the ranking of PRD section 12.16, in its order. The
/// sixth is an addition: section 12.16 says search matches the slug, and its
/// ranking names only an exact slug, so a partial slug would be found by
/// nothing. It sits last so the five stated tiers keep their stated order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchRank {
    /// The query is the slug.
    ExactSlug,
    /// The query is the marker token.
    ExactMarker,
    /// The title starts with the query.
    TitlePrefix,
    /// The title holds the query.
    TitleSubstring,
    /// The description holds the query.
    DescriptionSubstring,
    /// The slug holds the query, and nothing better matched.
    SlugSubstring,
}

/// One search result, carrying what the row draws and where it navigates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    /// Which collection this came from, and the group it draws under.
    pub kind: HitKind,
    /// What to open. A `schematify://` reference, so a screen and a node are
    /// addressable in one field.
    pub subject: Uri,
    /// The slug, drawn as the identifier of the row.
    pub slug: String,
    /// The title, drawn as the label of the row.
    pub title: String,
    /// The breadcrumb path to this hit, per PRD section 12.16.
    pub breadcrumb: String,
    /// Why it matched, which is also why it ranks where it does.
    pub rank: MatchRank,
}

/// One indexed thing, with its searchable text lowercased once.
struct Entry {
    kind: HitKind,
    subject: Uri,
    slug: String,
    title: String,
    breadcrumb: String,
    slug_lower: String,
    title_lower: String,
    marker_lower: Option<String>,
    description_lower: Option<String>,
}

impl Entry {
    fn rank(&self, needle: &str) -> Option<MatchRank> {
        if self.slug_lower == needle {
            return Some(MatchRank::ExactSlug);
        }
        if self.marker_lower.as_deref() == Some(needle) {
            return Some(MatchRank::ExactMarker);
        }
        if self.title_lower.starts_with(needle) {
            return Some(MatchRank::TitlePrefix);
        }
        if self.title_lower.contains(needle) {
            return Some(MatchRank::TitleSubstring);
        }
        if self
            .description_lower
            .as_ref()
            .is_some_and(|d| d.contains(needle))
        {
            return Some(MatchRank::DescriptionSubstring);
        }
        if self.slug_lower.contains(needle) {
            return Some(MatchRank::SlugSubstring);
        }
        None
    }

    fn hit(&self, rank: MatchRank) -> SearchHit {
        SearchHit {
            kind: self.kind.clone(),
            subject: self.subject,
            slug: self.slug.clone(),
            title: self.title.clone(),
            breadcrumb: self.breadcrumb.clone(),
            rank,
        }
    }
}

/// The index PRD section 12.16 builds on project load.
///
/// A flat vector rather than a map from term to entry. An inverted index is
/// the obvious next step and the trait above is what makes it a private
/// change; it is not built yet because 2000 entries scan in well under the
/// budget and an index nobody has measured against is a guess.
pub struct GraphIndex {
    entries: Vec<Entry>,
}

impl GraphIndex {
    /// Index everything PRD section 12.16 says search spans.
    #[must_use]
    pub fn build(graph: &Graph) -> Self {
        let mut entries = Vec::with_capacity(graph.node_count());

        for node in graph.nodes() {
            entries.push(node_entry(graph, node));
        }
        for rule in graph.rules() {
            entries.push(rule_entry(rule));
        }
        for library in &graph.libraries().libraries {
            entries.push(Entry::new(
                HitKind::Library,
                Uri::node(library.id),
                library.name.clone(),
                format!("{} {}", library.name, library.version),
                "Libraries".to_owned(),
                None,
                library.rationale.clone(),
            ));
        }
        for screen in graph.screens() {
            entries.push(Entry::new(
                HitKind::Screen,
                Uri::screen(screen.id),
                screen.slug.as_str().to_owned(),
                screen.title.clone(),
                "Product".to_owned(),
                None,
                Some(screen.purpose.clone()),
            ));
        }
        for flow in graph.flows() {
            entries.push(Entry::new(
                HitKind::Flow,
                Uri::flow(flow.id),
                flow.slug.as_str().to_owned(),
                flow.title.clone(),
                "Product".to_owned(),
                None,
                Some(flow.trigger.clone()),
            ));
        }
        for decision in graph.decisions() {
            entries.push(Entry::new(
                HitKind::Decision,
                Uri::decision(decision.id),
                decision.slug.as_str().to_owned(),
                decision.title.clone(),
                "Decision Log".to_owned(),
                None,
                Some(decision.decision.clone()),
            ));
        }

        Self { entries }
    }
}

impl Entry {
    fn new(
        kind: HitKind,
        subject: Uri,
        slug: String,
        title: String,
        breadcrumb: String,
        marker: Option<String>,
        description: Option<String>,
    ) -> Self {
        Self {
            slug_lower: slug.to_lowercase(),
            title_lower: title.to_lowercase(),
            marker_lower: marker.map(|m| m.to_lowercase()),
            description_lower: description.map(|d| d.to_lowercase()),
            kind,
            subject,
            slug,
            title,
            breadcrumb,
        }
    }
}

/// A node, with the marker token its kind carries.
///
/// Only a test case has one: PRD section 5.5 puts `impl_ref` on it and
/// nowhere else in the node schemas. A rule carries the other kind of marker,
/// and `rule_entry` handles that one.
fn node_entry(graph: &Graph, node: &Node) -> Entry {
    let marker = if *node.kind() == NodeKind::TestCase {
        node.test_case().ok().and_then(|t| t.impl_ref)
    } else {
        None
    };
    Entry::new(
        HitKind::Node {
            kind: node.kind().clone(),
        },
        Uri::node(node.id()),
        node.envelope.slug.as_str().to_owned(),
        node.envelope.title.clone(),
        location_of(graph, node.id()).cell(),
        marker,
        node.envelope.description.clone(),
    )
}

fn rule_entry(rule: &Rule) -> Entry {
    Entry::new(
        HitKind::Rule,
        Uri::node(rule.id),
        rule.slug.as_str().to_owned(),
        rule.slug.as_str().to_owned(),
        "Rules".to_owned(),
        rule.marker.clone(),
        Some(rule.statement.clone()),
    )
}

impl SearchIndex for GraphIndex {
    fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() || limit == 0 {
            return Vec::new();
        }
        let mut hits: Vec<SearchHit> = self
            .entries
            .iter()
            .filter_map(|entry| entry.rank(&needle).map(|rank| entry.hit(rank)))
            .collect();
        // Rank first, then slug, so a rerun over an unchanged graph returns
        // the same order and the keyboard selection does not move under it.
        hits.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.slug.cmp(&b.slug)));
        hits.truncate(limit);
        hits
    }

    fn entry_count(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::lifecycle::Lifecycle;
    use crate::node::{Authorship, NodeEnvelope};
    use crate::registry::Severity;
    use crate::slug::Slug;

    fn node(id: u128, slug: &str, title: &str, kind: NodeKind, parent: Option<u128>) -> Node {
        Node::new(NodeEnvelope {
            id: Uuid::from_u128(id),
            slug: Slug::new(slug).unwrap(),
            kind,
            title: title.to_owned(),
            description: Some(format!("The {title} of the fixture.")),
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

    fn graph() -> Graph {
        let mut graph = Graph::new();
        graph.insert_node(node(
            1,
            "auth-service",
            "Auth Service",
            NodeKind::Service,
            None,
        ));
        graph.insert_node(node(
            2,
            "token-verifier",
            "Token Verifier",
            NodeKind::Module,
            Some(1),
        ));
        graph.insert_node(node(
            3,
            "verify-signature",
            "verify_signature",
            NodeKind::ContractMethod,
            Some(2),
        ));
        graph.insert_rule(Rule {
            id: Uuid::from_u128(4),
            slug: Slug::new("no-unwrap").unwrap(),
            statement: "No unwrap on a value that came from the filesystem.".to_owned(),
            command: Some("cargo clippy".to_owned()),
            marker: Some("@veistra:0192f4a1".to_owned()),
            severity: Severity::Error,
            audit: Vec::new(),
        });
        graph.reindex();
        graph
    }

    #[test]
    fn the_index_spans_every_collection_section_twelve_sixteen_names() {
        let index = GraphIndex::build(&graph());
        assert_eq!(index.entry_count(), 4, "three nodes and one rule");
        assert!(!index.is_empty());
    }

    #[test]
    fn an_exact_slug_outranks_a_title_match_on_the_same_query() {
        let index = GraphIndex::build(&graph());
        let hits = index.search("token-verifier", DEFAULT_LIMIT);
        assert_eq!(hits.first().map(|h| h.rank), Some(MatchRank::ExactSlug));
        assert_eq!(hits[0].slug, "token-verifier");
        assert_eq!(hits[0].breadcrumb, "Stack › Auth Service");
    }

    #[test]
    fn the_five_ranks_of_section_twelve_sixteen_come_back_in_its_order() {
        assert!(MatchRank::ExactSlug < MatchRank::ExactMarker);
        assert!(MatchRank::ExactMarker < MatchRank::TitlePrefix);
        assert!(MatchRank::TitlePrefix < MatchRank::TitleSubstring);
        assert!(MatchRank::TitleSubstring < MatchRank::DescriptionSubstring);
        assert!(MatchRank::DescriptionSubstring < MatchRank::SlugSubstring);
    }

    #[test]
    fn a_marker_token_is_searchable_and_ranks_second() {
        let index = GraphIndex::build(&graph());
        let hits = index.search("@veistra:0192f4a1", DEFAULT_LIMIT);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rank, MatchRank::ExactMarker);
        assert_eq!(hits[0].kind, HitKind::Rule);
        assert_eq!(hits[0].breadcrumb, "Rules");
    }

    #[test]
    fn a_facet_draws_the_breadcrumb_to_its_module() {
        let index = GraphIndex::build(&graph());
        let hits = index.search("verify_signature", DEFAULT_LIMIT);
        assert_eq!(hits[0].breadcrumb, "› Token Verifier");
        assert_eq!(
            hits[0].kind,
            HitKind::Node {
                kind: NodeKind::ContractMethod
            }
        );
        assert_eq!(hits[0].kind.heading(), "contract-method");
    }

    #[test]
    fn an_empty_query_returns_nothing_rather_than_everything() {
        let index = GraphIndex::build(&graph());
        assert!(index.search("", DEFAULT_LIMIT).is_empty());
        assert!(index.search("   ", DEFAULT_LIMIT).is_empty());
        assert!(index.search("token-verifier", 0).is_empty());
    }

    #[test]
    fn a_query_matching_nothing_returns_nothing() {
        let index = GraphIndex::build(&graph());
        assert!(index.search("zzzznotathing", DEFAULT_LIMIT).is_empty());
    }

    #[test]
    fn matching_ignores_case_on_both_sides() {
        let index = GraphIndex::build(&graph());
        let hits = index.search("TOKEN-VERIFIER", DEFAULT_LIMIT);
        assert_eq!(hits.first().map(|h| h.rank), Some(MatchRank::ExactSlug));
    }

    #[test]
    fn the_limit_is_honoured_and_the_best_hit_survives_it() {
        let index = GraphIndex::build(&graph());
        let all = index.search("the", DEFAULT_LIMIT);
        assert!(all.len() > 1, "the description text matches several");
        let one = index.search("the", 1);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].slug, all[0].slug);
    }

    #[test]
    fn a_shell_adapter_reaches_the_index_through_the_trait_alone() {
        let index = GraphIndex::build(&graph());
        let behind: &dyn SearchIndex = &index;
        assert_eq!(behind.entry_count(), 4);
        assert_eq!(behind.search("no-unwrap", DEFAULT_LIMIT).len(), 1);
    }
}
