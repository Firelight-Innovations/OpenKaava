//! The in-memory design graph, with the two relations kept apart.
//!
//! There is no index file on disk. PRD section 6.1 is explicit about it: the
//! loader walks `.veistra/`, parses every file, and rebuilds this. An index
//! would be a second source of truth that goes stale on the first hand edit,
//! and hand edits are expected because the tree is in git.
//!
//! The indexes below are built once at load and never written back. Children
//! come from the `parent` field, because containment stores no edge file;
//! dependents and dependencies come from the edge files, because dependency
//! stores nothing on the node. That asymmetry is the storage model, not an
//! accident of this type.
//!
//! Every count here is a method. PRD section 0.4 forbids storing one, and
//! [`Graph::facet_count`] is the field PRD section 5.4 names and this crate
//! deliberately does not have.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use uuid::Uuid;

use crate::brief::ProjectBrief;
use crate::decision::Decision;
use crate::edge::{Edge, EdgeKind};
use crate::layout::Layout;
use crate::lifecycle::AuditRow;
use crate::node::{Node, NodeKind};
use crate::product::{Flow, Screen};
use crate::registry::{LibraryRegistry, Rule};
use crate::run::RunArtifact;

/// One project's design data, loaded.
#[derive(Debug, Default, Clone)]
pub struct Graph {
    nodes: BTreeMap<Uuid, Node>,
    edges: BTreeMap<Uuid, Edge>,
    screens: BTreeMap<Uuid, Screen>,
    flows: BTreeMap<Uuid, Flow>,
    decisions: BTreeMap<Uuid, Decision>,
    rules: BTreeMap<Uuid, Rule>,
    layouts: BTreeMap<String, Layout>,
    runs: BTreeMap<Uuid, Vec<RunArtifact>>,
    audit: BTreeMap<Uuid, Vec<AuditRow>>,
    libraries: LibraryRegistry,
    brief: Option<ProjectBrief>,
    quarantined: BTreeSet<Uuid>,

    children: HashMap<Uuid, Vec<Uuid>>,
    outgoing: HashMap<Uuid, Vec<Uuid>>,
    incoming: HashMap<Uuid, Vec<Uuid>>,
}

impl Graph {
    /// An empty graph.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a node. Call [`Graph::reindex`] once every node is in.
    pub fn insert_node(&mut self, node: Node) {
        self.nodes.insert(node.id(), node);
    }

    /// Add an edge. Call [`Graph::reindex`] once every edge is in.
    pub fn insert_edge(&mut self, edge: Edge) {
        self.edges.insert(edge.id, edge);
    }

    /// Add a screen.
    pub fn insert_screen(&mut self, screen: Screen) {
        self.screens.insert(screen.id, screen);
    }

    /// Add a flow.
    pub fn insert_flow(&mut self, flow: Flow) {
        self.flows.insert(flow.id, flow);
    }

    /// Add a decision.
    pub fn insert_decision(&mut self, decision: Decision) {
        self.decisions.insert(decision.id, decision);
    }

    /// Add a rule.
    pub fn insert_rule(&mut self, rule: Rule) {
        self.rules.insert(rule.id, rule);
    }

    /// Add a layout, keyed by its Schematic slug.
    pub fn insert_layout(&mut self, layout: Layout) {
        self.layouts.insert(layout.schematic.clone(), layout);
    }

    /// Add one ingested run for a node.
    pub fn insert_run(&mut self, node: Uuid, run: RunArtifact) {
        self.runs.entry(node).or_default().push(run);
    }

    /// Add the audit history for a node.
    pub fn insert_audit(&mut self, node: Uuid, rows: Vec<AuditRow>) {
        self.audit.insert(node, rows);
    }

    /// Replace the library registry.
    pub fn set_libraries(&mut self, libraries: LibraryRegistry) {
        self.libraries = libraries;
    }

    /// Replace the project brief.
    pub fn set_brief(&mut self, brief: ProjectBrief) {
        self.brief = Some(brief);
    }

    /// Mark a node as quarantined, per PRD section 6.6.
    ///
    /// A quarantined node stays in the graph and stays addressable. Dropping
    /// it would take its own children out of reach and turn one dangling
    /// reference into a cascade of them, which is exactly what quarantine
    /// exists to avoid.
    pub fn quarantine(&mut self, id: Uuid) {
        self.quarantined.insert(id);
    }

    /// Rebuild the containment and dependency indexes.
    ///
    /// Safe to call twice. The loader calls it once, after every file is in.
    pub fn reindex(&mut self) {
        self.children.clear();
        self.outgoing.clear();
        self.incoming.clear();

        for node in self.nodes.values() {
            if let Some(parent) = node.envelope.parent {
                self.children.entry(parent).or_default().push(node.id());
            }
        }
        for list in self.children.values_mut() {
            list.sort_unstable();
        }

        for edge in self.edges.values() {
            if edge.kind != EdgeKind::DependsOn || !edge.is_live() {
                continue;
            }
            self.outgoing
                .entry(edge.source)
                .or_default()
                .push(edge.target);
            self.incoming
                .entry(edge.target)
                .or_default()
                .push(edge.source);
        }
        for list in self.outgoing.values_mut().chain(self.incoming.values_mut()) {
            list.sort_unstable();
            list.dedup();
        }
    }

    /// One node, by identifier.
    #[must_use]
    pub fn node(&self, id: Uuid) -> Option<&Node> {
        self.nodes.get(&id)
    }

    /// Every node, in identifier order, which is creation order under UUIDv7.
    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    /// One edge, by identifier.
    #[must_use]
    pub fn edge(&self, id: Uuid) -> Option<&Edge> {
        self.edges.get(&id)
    }

    /// Every edge.
    pub fn edges(&self) -> impl Iterator<Item = &Edge> {
        self.edges.values()
    }

    /// One screen, by identifier.
    #[must_use]
    pub fn screen(&self, id: Uuid) -> Option<&Screen> {
        self.screens.get(&id)
    }

    /// Every screen.
    pub fn screens(&self) -> impl Iterator<Item = &Screen> {
        self.screens.values()
    }

    /// One flow, by identifier.
    #[must_use]
    pub fn flow(&self, id: Uuid) -> Option<&Flow> {
        self.flows.get(&id)
    }

    /// Every flow.
    pub fn flows(&self) -> impl Iterator<Item = &Flow> {
        self.flows.values()
    }

    /// One decision, by identifier.
    #[must_use]
    pub fn decision(&self, id: Uuid) -> Option<&Decision> {
        self.decisions.get(&id)
    }

    /// Every decision.
    pub fn decisions(&self) -> impl Iterator<Item = &Decision> {
        self.decisions.values()
    }

    /// Every rule in the registry.
    pub fn rules(&self) -> impl Iterator<Item = &Rule> {
        self.rules.values()
    }

    /// One layout, by Schematic slug.
    #[must_use]
    pub fn layout(&self, schematic: &str) -> Option<&Layout> {
        self.layouts.get(schematic)
    }

    /// Every run ingested for a node, in the order they were read.
    #[must_use]
    pub fn runs(&self, node: Uuid) -> &[RunArtifact] {
        self.runs.get(&node).map_or(&[], Vec::as_slice)
    }

    /// Every run that reports a result for this budget node.
    ///
    /// PRD section 6.1 keys `runs/` by one node per directory, and one CI
    /// workflow answers several budgets at once (PRD section 8), so a run is
    /// stored under the budget's containing module or service, never under
    /// the budget itself. Finding a budget's runs by walking that
    /// containment and matching `metric` strings by hand is the "path
    /// convention" the wave 9b handoff calls out; this method is the
    /// explicit link instead, so a caller never has to know the storage
    /// fact to ask the question.
    #[must_use]
    pub fn runs_for_budget(&self, budget: Uuid) -> Vec<&RunArtifact> {
        let Some(node) = self.node(budget) else {
            return Vec::new();
        };
        let Ok(fields) = node.budget() else {
            return Vec::new();
        };
        let Some(scope) = node.envelope.parent else {
            return Vec::new();
        };
        self.runs(scope)
            .iter()
            .filter(|run| run.budgets.iter().any(|b| b.metric == fields.metric))
            .collect()
    }

    /// The audit history of a node.
    #[must_use]
    pub fn audit(&self, node: Uuid) -> &[AuditRow] {
        self.audit.get(&node).map_or(&[], Vec::as_slice)
    }

    /// The library registry.
    #[must_use]
    pub fn libraries(&self) -> &LibraryRegistry {
        &self.libraries
    }

    /// The project brief, if the project has one.
    #[must_use]
    pub fn brief(&self) -> Option<&ProjectBrief> {
        self.brief.as_ref()
    }

    /// Whether a node was quarantined at load.
    #[must_use]
    pub fn is_quarantined(&self, id: Uuid) -> bool {
        self.quarantined.contains(&id)
    }

    /// Every quarantined node.
    pub fn quarantined(&self) -> impl Iterator<Item = Uuid> + '_ {
        self.quarantined.iter().copied()
    }

    /// How many nodes the graph holds.
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// How many edges the graph holds.
    #[must_use]
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// The containment children of a node.
    #[must_use]
    pub fn children(&self, id: Uuid) -> &[Uuid] {
        self.children.get(&id).map_or(&[], Vec::as_slice)
    }

    /// The nodes with no containment parent.
    #[must_use]
    pub fn roots(&self) -> Vec<Uuid> {
        self.nodes
            .values()
            .filter(|n| n.envelope.parent.is_none())
            .map(Node::id)
            .collect()
    }

    /// Every node under this one, at any depth.
    #[must_use]
    pub fn descendants(&self, id: Uuid) -> Vec<Uuid> {
        let mut found = Vec::new();
        let mut queue = vec![id];
        // The starting node is marked seen, so a `parent` chain that loops
        // back to it terminates the walk and does not report the node as its
        // own descendant.
        let mut seen = HashSet::from([id]);
        while let Some(current) = queue.pop() {
            for child in self.children(current) {
                if seen.insert(*child) {
                    found.push(*child);
                    queue.push(*child);
                }
            }
        }
        found.sort_unstable();
        found
    }

    /// The chain from a node up to the root, nearest parent first.
    ///
    /// A cycle in the `parent` chain terminates the walk rather than hanging.
    /// Rule L01 reports the cycle; this method's job is to return.
    #[must_use]
    pub fn ancestors(&self, id: Uuid) -> Vec<Uuid> {
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut current = self.node(id).and_then(|n| n.envelope.parent);
        while let Some(parent) = current {
            if !seen.insert(parent) {
                break;
            }
            chain.push(parent);
            current = self.node(parent).and_then(|n| n.envelope.parent);
        }
        chain
    }

    /// The lowest common ancestor of a set of nodes.
    ///
    /// `None` means the project root, which is a real answer rather than a
    /// failure: PRD section 4.3 puts `event-bus` there precisely because its
    /// four consumers share no closer ancestor.
    #[must_use]
    pub fn lowest_common_ancestor(&self, ids: &[Uuid]) -> Option<Uuid> {
        let mut candidates: Option<Vec<Uuid>> = None;
        for id in ids {
            let mut chain = vec![*id];
            chain.extend(self.ancestors(*id));
            candidates = Some(match candidates {
                None => chain,
                Some(previous) => previous.into_iter().filter(|c| chain.contains(c)).collect(),
            });
        }
        // The first surviving entry is the deepest, because each chain runs
        // from the node upward and the filter preserves that order.
        candidates?.into_iter().find(|c| !ids.contains(c))
    }

    /// What a node depends on.
    #[must_use]
    pub fn dependencies(&self, id: Uuid) -> Vec<Uuid> {
        self.outgoing.get(&id).cloned().unwrap_or_default()
    }

    /// What depends on a node.
    #[must_use]
    pub fn dependents(&self, id: Uuid) -> Vec<Uuid> {
        self.incoming.get(&id).cloned().unwrap_or_default()
    }

    /// Whether a node is shared, per PRD section 4.3.
    ///
    /// Two or more dependents. One consumer is not a shared node, and the
    /// badge is not drawn for it.
    #[must_use]
    pub fn is_shared(&self, id: Uuid) -> bool {
        self.dependents(id).len() >= 2
    }

    /// Where PRD section 4.3 says a shared node's containment parent belongs:
    /// the lowest common ancestor of everything that depends on it.
    ///
    /// Returns `None` for a node with fewer than two dependents, where the
    /// rule does not apply, and `Some(None)` for a node whose consumers share
    /// only the project root.
    #[must_use]
    pub fn shared_node_parent(&self, id: Uuid) -> Option<Option<Uuid>> {
        let dependents = self.dependents(id);
        if dependents.len() < 2 {
            return None;
        }
        Some(self.lowest_common_ancestor(&dependents))
    }

    /// Whether a shared node sits where PRD section 4.3 puts it.
    ///
    /// A node the rule does not cover passes, because a rule that does not
    /// apply is not a rule that fails.
    #[must_use]
    pub fn shared_node_is_at_lca(&self, id: Uuid) -> bool {
        match self.shared_node_parent(id) {
            None => true,
            Some(expected) => self.node(id).and_then(|n| n.envelope.parent) == expected,
        }
    }

    /// How many facets a module holds, annotation facets included.
    ///
    /// This is the `facet_count` of PRD section 5.4. It is computed here and
    /// stored nowhere, which is PRD section 0.4 applied to the one field the
    /// schema explicitly marks as computed.
    #[must_use]
    pub fn facet_count(&self, module: Uuid) -> usize {
        self.children(module)
            .iter()
            .filter(|id| self.node(**id).is_some_and(|n| n.kind().is_facet()))
            .count()
    }

    /// The modules a Service Schematic draws for one service.
    ///
    /// The walk stops at a nested service, because that service has its own
    /// Schematic and its modules are drawn there. `ledger-store` sitting
    /// inside `session-service` is the case from PRD section 16.1: the six
    /// modules the wireframe draws for `session-service` are its own, and the
    /// ledger's two belong to the ledger.
    #[must_use]
    pub fn modules_of_service(&self, service: Uuid) -> Vec<Uuid> {
        let mut found = Vec::new();
        let mut queue = vec![service];
        // Two node files whose `parent` fields point at each other are a legal
        // thing to find on disk after a bad merge, and without this set the
        // walk never returns. Rule L01 reports the cycle; this method's job is
        // to finish. `descendants` and `ancestors` guard the same way.
        let mut seen = HashSet::new();
        seen.insert(service);
        while let Some(current) = queue.pop() {
            for child in self.children(current) {
                if !seen.insert(*child) {
                    continue;
                }
                let Some(node) = self.node(*child) else {
                    continue;
                };
                if *node.kind() == NodeKind::Service {
                    continue;
                }
                if *node.kind() == NodeKind::Module {
                    found.push(*child);
                }
                queue.push(*child);
            }
        }
        found.sort_unstable();
        found
    }

    /// The module a facet belongs to: the nearest module at or above it.
    ///
    /// PRD section 3.2 scopes a facet slug to its module root rather than to
    /// its immediate parent, and section 5.5 lets a group sit between the two.
    /// Walking is the only way to tell them apart, which is why the loader
    /// resolves the scope here rather than passing a parent that is sometimes
    /// the right answer.
    #[must_use]
    pub fn module_root(&self, id: Uuid) -> Option<Uuid> {
        let node = self.node(id)?;
        if *node.kind() == NodeKind::Module {
            return Some(id);
        }
        self.ancestors(id)
            .into_iter()
            .find(|a| self.node(*a).is_some_and(|n| *n.kind() == NodeKind::Module))
    }

    /// Every node of a kind, in identifier order.
    #[must_use]
    pub fn nodes_of_kind(&self, kind: &NodeKind) -> Vec<Uuid> {
        self.nodes
            .values()
            .filter(|n| n.kind() == kind)
            .map(Node::id)
            .collect()
    }

    /// Whether the dependency graph holds a cycle, which rule L02 forbids.
    #[must_use]
    pub fn has_dependency_cycle(&self) -> bool {
        self.dependency_cycle().is_some()
    }

    /// One dependency cycle, if the graph holds any, as the nodes around it.
    #[must_use]
    pub fn dependency_cycle(&self) -> Option<Vec<Uuid>> {
        let mut settled: HashSet<Uuid> = HashSet::new();
        for start in self.nodes.keys() {
            let mut path = Vec::new();
            let mut on_path = HashSet::new();
            if let Some(cycle) = self.walk_for_cycle(*start, &mut settled, &mut path, &mut on_path)
            {
                return Some(cycle);
            }
        }
        None
    }

    fn walk_for_cycle(
        &self,
        at: Uuid,
        settled: &mut HashSet<Uuid>,
        path: &mut Vec<Uuid>,
        on_path: &mut HashSet<Uuid>,
    ) -> Option<Vec<Uuid>> {
        if settled.contains(&at) {
            return None;
        }
        if !on_path.insert(at) {
            let start = path.iter().position(|n| *n == at).unwrap_or(0);
            return Some(path[start..].to_vec());
        }
        path.push(at);
        for next in self.dependencies(at) {
            if let Some(cycle) = self.walk_for_cycle(next, settled, path, on_path) {
                return Some(cycle);
            }
        }
        path.pop();
        on_path.remove(&at);
        settled.insert(at);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::Lifecycle;
    use crate::node::{Authorship, BudgetFields, BudgetTier, NodeEnvelope, NodeKind};
    use crate::run::{BudgetResult, RUN_SCHEMA_VERSION};
    use crate::slug::Slug;

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

    fn depends(id: u128, source: u128, target: u128) -> Edge {
        Edge::new(
            Uuid::from_u128(id),
            EdgeKind::DependsOn,
            Uuid::from_u128(source),
            Uuid::from_u128(target),
            "2026-08-25T00:00:00Z",
        )
    }

    /// The shape of PRD section 4.3: four consumers under two different
    /// parents, and a shared node at their lowest common ancestor.
    fn shared_graph() -> Graph {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "platform-core", NodeKind::Group, None));
        graph.insert_node(node(2, "auth-service", NodeKind::Service, Some(1)));
        graph.insert_node(node(3, "session-service", NodeKind::Service, Some(1)));
        graph.insert_node(node(4, "billing-service", NodeKind::Service, None));
        graph.insert_node(node(5, "notification-service", NodeKind::Service, None));
        graph.insert_node(node(6, "event-bus", NodeKind::Service, None));
        for (i, consumer) in [2u128, 3, 4, 5].into_iter().enumerate() {
            graph.insert_edge(depends(100 + i as u128, consumer, 6));
        }
        graph.reindex();
        graph
    }

    #[test]
    fn containment_comes_from_the_parent_field_and_not_from_an_edge() {
        let graph = shared_graph();
        assert_eq!(
            graph.children(Uuid::from_u128(1)),
            [Uuid::from_u128(2), Uuid::from_u128(3)]
        );
        assert_eq!(graph.roots().len(), 4);
        assert!(graph.edges().all(|e| e.kind == EdgeKind::DependsOn));
    }

    #[test]
    fn a_shared_node_belongs_at_the_lowest_common_ancestor_of_its_dependents() {
        let graph = shared_graph();
        let bus = Uuid::from_u128(6);
        assert!(graph.is_shared(bus));
        assert_eq!(graph.dependents(bus).len(), 4);
        assert_eq!(graph.shared_node_parent(bus), Some(None));
        assert!(graph.shared_node_is_at_lca(bus));
    }

    #[test]
    fn a_shared_node_below_the_lca_of_its_dependents_fails_the_rule() {
        let mut graph = shared_graph();
        let mut bus = node(6, "event-bus", NodeKind::Service, Some(2));
        bus.envelope.parent = Some(Uuid::from_u128(2));
        graph.insert_node(bus);
        graph.reindex();
        assert!(!graph.shared_node_is_at_lca(Uuid::from_u128(6)));
    }

    #[test]
    fn a_shared_node_above_the_lca_of_its_dependents_fails_the_rule() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "auth-service", NodeKind::Service, None));
        graph.insert_node(node(2, "token-verifier", NodeKind::Module, Some(1)));
        graph.insert_node(node(3, "jwks-cache", NodeKind::Module, Some(2)));
        graph.insert_node(node(4, "clock-skew", NodeKind::Module, Some(2)));
        graph.insert_node(node(5, "crypto-primitives", NodeKind::Module, Some(1)));
        graph.insert_edge(depends(100, 3, 5));
        graph.insert_edge(depends(101, 4, 5));
        graph.reindex();
        assert_eq!(
            graph.shared_node_parent(Uuid::from_u128(5)),
            Some(Some(Uuid::from_u128(2)))
        );
        assert!(!graph.shared_node_is_at_lca(Uuid::from_u128(5)));
    }

    #[test]
    fn a_node_with_one_dependent_is_outside_the_shared_rule() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "a", NodeKind::Module, None));
        graph.insert_node(node(2, "b", NodeKind::Module, None));
        graph.insert_edge(depends(100, 1, 2));
        graph.reindex();
        assert!(!graph.is_shared(Uuid::from_u128(2)));
        assert_eq!(graph.shared_node_parent(Uuid::from_u128(2)), None);
        assert!(graph.shared_node_is_at_lca(Uuid::from_u128(2)));
    }

    #[test]
    fn the_facet_count_is_computed_from_the_children() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "token-verifier", NodeKind::Module, None));
        graph.insert_node(node(2, "verify", NodeKind::ContractMethod, Some(1)));
        graph.insert_node(node(3, "expired", NodeKind::TestCase, Some(1)));
        graph.insert_node(node(4, "note", NodeKind::Comment, Some(1)));
        graph.insert_node(node(5, "child-module", NodeKind::Module, Some(1)));
        graph.reindex();
        assert_eq!(graph.facet_count(Uuid::from_u128(1)), 3);
    }

    fn budget(id: u128, slug: &str, parent: u128, metric: &str) -> Node {
        node(id, slug, NodeKind::Budget, Some(parent))
            .with_fields(&BudgetFields {
                metric: metric.to_owned(),
                op: "<".to_owned(),
                value: 3.0,
                unit: "ms".to_owned(),
                tier: BudgetTier::Hard,
                probe: None,
                sign_off: None,
            })
            .unwrap()
    }

    /// Two budget siblings under one scope, and a run naming only one of
    /// their metrics. A filter that matched any run in the scope rather than
    /// the metric itself would return the run for both, so this is the case
    /// that tells the two apart.
    #[test]
    fn runs_for_budget_matches_by_metric_and_not_by_sharing_a_scope() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "token-verifier", NodeKind::Module, None));
        graph.insert_node(budget(2, "verify-p95", 1, "verify_p95"));
        graph.insert_node(budget(3, "cold-start-p95", 1, "cold_start_p95"));
        graph.reindex();

        graph.insert_run(
            Uuid::from_u128(1),
            RunArtifact {
                schema: RUN_SCHEMA_VERSION.to_owned(),
                run: 1,
                at: "2026-08-25T00:00:00Z".to_owned(),
                commit: "abc".to_owned(),
                workflow: "ci/verify.yml".to_owned(),
                budgets: vec![BudgetResult {
                    metric: "verify_p95".to_owned(),
                    value: 1.8,
                    unit: "ms".to_owned(),
                    pass: true,
                }],
                tests: Vec::new(),
                linter: None,
                reconcile: None,
            },
        );

        assert_eq!(
            graph.runs_for_budget(Uuid::from_u128(2)).len(),
            1,
            "verify_p95 is named in the run and should find it"
        );
        assert!(
            graph.runs_for_budget(Uuid::from_u128(3)).is_empty(),
            "cold_start_p95 shares the scope but is not named in the run"
        );
    }

    #[test]
    fn a_nested_service_keeps_its_own_modules() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "session-service", NodeKind::Service, None));
        graph.insert_node(node(2, "session-codec", NodeKind::Module, Some(1)));
        graph.insert_node(node(3, "ledger-store", NodeKind::Service, Some(1)));
        graph.insert_node(node(4, "ledger-writer", NodeKind::Module, Some(3)));
        graph.reindex();
        assert_eq!(
            graph.modules_of_service(Uuid::from_u128(1)),
            [Uuid::from_u128(2)]
        );
        assert_eq!(
            graph.modules_of_service(Uuid::from_u128(3)),
            [Uuid::from_u128(4)]
        );
        assert_eq!(graph.descendants(Uuid::from_u128(1)).len(), 3);
    }

    #[test]
    fn descendants_reach_every_depth() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "a", NodeKind::Service, None));
        graph.insert_node(node(2, "b", NodeKind::Module, Some(1)));
        graph.insert_node(node(3, "c", NodeKind::Module, Some(2)));
        graph.reindex();
        assert_eq!(
            graph.descendants(Uuid::from_u128(1)),
            [Uuid::from_u128(2), Uuid::from_u128(3)]
        );
        assert_eq!(graph.ancestors(Uuid::from_u128(3)).len(), 2);
    }

    #[test]
    fn a_dependency_cycle_is_found_and_an_acyclic_graph_reports_none() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "session-codec", NodeKind::Module, None));
        graph.insert_node(node(2, "token-issuer", NodeKind::Module, None));
        graph.insert_node(node(3, "session-store", NodeKind::Module, None));
        graph.insert_edge(depends(100, 1, 2));
        graph.insert_edge(depends(101, 2, 3));
        graph.reindex();
        assert!(!graph.has_dependency_cycle());

        graph.insert_edge(depends(102, 3, 1));
        graph.reindex();
        let cycle = graph.dependency_cycle().unwrap();
        assert_eq!(cycle.len(), 3);
    }

    #[test]
    fn a_superseded_edge_leaves_the_dependency_index() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "a", NodeKind::Module, None));
        graph.insert_node(node(2, "b", NodeKind::Module, None));
        let mut edge = depends(100, 1, 2);
        edge.superseded_by = Some(Uuid::from_u128(200));
        graph.insert_edge(edge);
        graph.reindex();
        assert!(graph.dependents(Uuid::from_u128(2)).is_empty());
        assert_eq!(graph.edge_count(), 1);
    }

    #[test]
    fn a_quarantined_node_stays_addressable() {
        let mut graph = shared_graph();
        graph.quarantine(Uuid::from_u128(6));
        assert!(graph.is_quarantined(Uuid::from_u128(6)));
        assert!(graph.node(Uuid::from_u128(6)).is_some());
        assert_eq!(graph.quarantined().count(), 1);
    }

    #[test]
    fn a_parent_cycle_terminates_every_containment_walk() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "a", NodeKind::Module, Some(2)));
        graph.insert_node(node(2, "b", NodeKind::Module, Some(1)));
        graph.reindex();
        assert_eq!(graph.modules_of_service(Uuid::from_u128(1)).len(), 1);
        assert_eq!(graph.descendants(Uuid::from_u128(1)).len(), 1);
    }

    #[test]
    fn a_facet_under_a_group_still_reports_its_module_root() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "auth-service", NodeKind::Service, None));
        graph.insert_node(node(2, "token-verifier", NodeKind::Module, Some(1)));
        graph.insert_node(node(3, "token-pipeline", NodeKind::Group, Some(2)));
        graph.insert_node(node(
            4,
            "verify-signature",
            NodeKind::ContractMethod,
            Some(3),
        ));
        graph.reindex();
        assert_eq!(
            graph.module_root(Uuid::from_u128(4)),
            Some(Uuid::from_u128(2))
        );
        assert_eq!(
            graph.module_root(Uuid::from_u128(2)),
            Some(Uuid::from_u128(2))
        );
        assert_eq!(graph.module_root(Uuid::from_u128(1)), None);
    }

    #[test]
    fn a_parent_cycle_terminates_the_ancestor_walk() {
        let mut graph = Graph::new();
        graph.insert_node(node(1, "a", NodeKind::Module, Some(2)));
        graph.insert_node(node(2, "b", NodeKind::Module, Some(1)));
        graph.reindex();
        assert_eq!(graph.ancestors(Uuid::from_u128(1)).len(), 2);
    }
}
