//! The node envelope of PRD section 5.1 and the typed fields each kind adds.
//!
//! A node on disk is one flat JSON object: the envelope every node carries,
//! plus whatever its kind adds. [`Node`] mirrors that exactly - a typed
//! envelope and an open map for the rest - and the typed views hand back a
//! [`ServiceFields`] or a [`BudgetFields`] when the kind is one of the nine.
//!
//! The rejected alternative was a `#[serde(tag = "kind")]` enum over those
//! nine. It reads better and it cannot hold PRD section 11.2, where a user
//! registers a node kind this build has never seen. Under the enum that file
//! is a parse error at load; under the open map it round-trips byte for byte
//! and only the typed view is unavailable. An unknown kind is a node this
//! build cannot draw richly, not a node it should refuse to hold.
//!
//! No field here is a count. PRD section 0.4 puts `facet_count` on the graph,
//! computed at draw time, and [`crate::Graph::facet_count`] is where it lives.

use std::fmt;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::lifecycle::{Lifecycle, Staleness};
use crate::slug::Slug;
use crate::uri::Uri;

/// Which kind of thing a node is.
///
/// The nine named variants are the vocabulary of PRD sections 5.3 to 5.5.
/// [`NodeKind::Custom`] carries a kind registered under PRD section 11.2, and
/// keeps its spelling so a round trip does not rename it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeKind {
    /// Tier 1. One service in the stack.
    Service,
    /// Tier 2. One module inside a service, at any containment depth.
    Module,
    /// Tier 3. A method published on a contract.
    ContractMethod,
    /// Tier 3. A declared test.
    TestCase,
    /// Tier 3. A measured claim with a probe behind it.
    Budget,
    /// Tier 3. Prose attached to a design node.
    DocBlock,
    /// Tier 3. A use of an approved external library.
    ExternalDep,
    /// Annotation tier. A note anchored to a node or floating free.
    Comment,
    /// Annotation tier. A titled box around other nodes.
    Group,
    /// A kind registered by a user under PRD section 11.2.
    #[serde(untagged)]
    Custom(String),
}

impl NodeKind {
    /// The word this kind writes into JSON.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Service => "service",
            Self::Module => "module",
            Self::ContractMethod => "contract-method",
            Self::TestCase => "test-case",
            Self::Budget => "budget",
            Self::DocBlock => "doc-block",
            Self::ExternalDep => "external-dep",
            Self::Comment => "comment",
            Self::Group => "group",
            Self::Custom(name) => name,
        }
    }

    /// Whether this kind sits in the annotation tier of PRD section 11.3.
    ///
    /// An annotation node stays out of reconciliation and refuses a semantic
    /// edge. Without the rule the anti-slop constraint holds a hole shaped as
    /// a text box.
    #[must_use]
    pub fn is_annotation(&self) -> bool {
        matches!(self, Self::Comment | Self::Group)
    }

    /// Whether this kind counts toward a module's facet count.
    ///
    /// The seven tier-3 kinds, and the two annotation kinds with them. PRD
    /// section 5.4 defines the count as every facet node whose parent is the
    /// module, "annotation facets included", so a comment and a group are in
    /// it even though PRD section 11.3 keeps them out of reconciliation.
    #[must_use]
    pub fn is_facet(&self) -> bool {
        matches!(
            self,
            Self::ContractMethod
                | Self::TestCase
                | Self::Budget
                | Self::DocBlock
                | Self::ExternalDep
                | Self::Comment
                | Self::Group
        )
    }
}

impl fmt::Display for NodeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The five layer values of PRD section 5.2, drawn as a badge on a service and
/// on a module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    /// Server-side application code.
    Backend,
    /// A store or a schema owner.
    Data,
    /// The outermost hop, at the network boundary.
    Edge,
    /// Client-side code.
    Frontend,
    /// Something outside this project's control.
    External,
}

impl Layer {
    /// The badge string PRD section 5.2 draws for this layer.
    #[must_use]
    pub fn badge(self) -> &'static str {
        match self {
            Self::Backend => "BACKEND",
            Self::Data => "DATA",
            Self::Edge => "EDGE",
            Self::Frontend => "FRONTEND",
            Self::External => "EXTERNAL",
        }
    }
}

/// Who wrote a node.
///
/// PRD section 5.1 allows `human` or `agent` and nothing else, which is why
/// this is not [`crate::Actor`]. `Actor` carries a third value, `system`, for
/// the one lifecycle transition nobody requests, and a node with
/// `authored_by: "system"` would be a node no reviewer could hold to account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Authorship {
    /// A person wrote it.
    Human,
    /// A coding agent wrote it. The node face draws the agent-draft diamond.
    Agent,
}

impl Authorship {
    /// The word this value writes into JSON.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
        }
    }
}

/// The envelope every node carries, whatever its kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeEnvelope {
    /// The UUIDv7 every reference stores.
    pub id: Uuid,
    /// The human-readable name, unique inside the scope its kind names.
    pub slug: Slug,
    /// What kind of thing this is.
    pub kind: NodeKind,
    /// The name drawn on the node face.
    pub title: String,
    /// Prose stating what this is and why it exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Where this node sits on the review path.
    pub lifecycle: Lifecycle,
    /// The layer badge, on a service and a module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<Layer>,
    /// The containment parent. `None` puts the node at the project root.
    #[serde(default)]
    pub parent: Option<Uuid>,
    /// The decisions that produced this node.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decisions: Vec<Uri>,
    /// Whether a person or an agent wrote this node.
    pub authored_by: Authorship,
    /// When the node was created, as an RFC 3339 timestamp.
    pub created: String,
    /// The replacement, once this node is deprecated.
    #[serde(default)]
    pub superseded_by: Option<Uuid>,
    /// Why this node is stale, when `lifecycle` is `stale`.
    ///
    /// PRD section 7.4 draws a second caption line naming the contract that
    /// moved and how long ago. The cascade knows both at the moment it fires
    /// and a reloaded graph does not, so the answer is written here rather
    /// than recomputed. Wave 10 sets it; this crate defines it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<Staleness>,
}

/// One node: the envelope, plus whatever its kind adds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    /// The fields every node carries.
    #[serde(flatten)]
    pub envelope: NodeEnvelope,
    /// The fields this node's kind adds, unparsed.
    ///
    /// Reach for [`Node::service`] and its siblings rather than this map. It
    /// is public so an unknown kind stays inspectable, and so a round trip
    /// through this crate cannot silently drop a field it did not model.
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl Node {
    /// A node with an empty field map.
    #[must_use]
    pub fn new(envelope: NodeEnvelope) -> Self {
        Self {
            envelope,
            fields: Map::new(),
        }
    }

    /// The identifier, which is what every reference stores.
    #[must_use]
    pub fn id(&self) -> Uuid {
        self.envelope.id
    }

    /// What kind of thing this node is.
    #[must_use]
    pub fn kind(&self) -> &NodeKind {
        &self.envelope.kind
    }

    /// Attach the typed fields of a kind, flattening them into the map.
    ///
    /// # Errors
    ///
    /// Returns the serializer's error when `fields` does not serialize to a
    /// JSON object. Every field struct in this module does.
    pub fn with_fields<T: Serialize>(mut self, fields: &T) -> Result<Self, serde_json::Error> {
        if let Value::Object(map) = serde_json::to_value(fields)? {
            self.fields.extend(map);
        }
        Ok(self)
    }

    /// The service fields of PRD section 5.3.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the kind's fields are missing or
    /// mistyped.
    pub fn service(&self) -> Result<ServiceFields, serde_json::Error> {
        self.typed()
    }

    /// The module fields of PRD section 5.4.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the kind's fields are missing or
    /// mistyped.
    pub fn module(&self) -> Result<ModuleFields, serde_json::Error> {
        self.typed()
    }

    /// The contract-method fields of PRD section 5.5.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the kind's fields are missing or
    /// mistyped.
    pub fn contract_method(&self) -> Result<ContractMethodFields, serde_json::Error> {
        self.typed()
    }

    /// The test-case fields of PRD section 5.5.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the kind's fields are missing or
    /// mistyped.
    pub fn test_case(&self) -> Result<TestCaseFields, serde_json::Error> {
        self.typed()
    }

    /// The budget fields of PRD sections 5.5 and 8.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the kind's fields are missing or
    /// mistyped.
    pub fn budget(&self) -> Result<BudgetFields, serde_json::Error> {
        self.typed()
    }

    /// The doc-block fields of PRD section 5.5.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the kind's fields are missing or
    /// mistyped.
    pub fn doc_block(&self) -> Result<DocBlockFields, serde_json::Error> {
        self.typed()
    }

    /// The external-dep fields of PRD section 5.5.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the kind's fields are missing or
    /// mistyped.
    pub fn external_dep(&self) -> Result<ExternalDepFields, serde_json::Error> {
        self.typed()
    }

    /// The comment fields of PRD section 5.5.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the kind's fields are missing or
    /// mistyped.
    pub fn comment(&self) -> Result<CommentFields, serde_json::Error> {
        self.typed()
    }

    /// The group fields of PRD section 5.5.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the kind's fields are missing or
    /// mistyped.
    pub fn group(&self) -> Result<GroupFields, serde_json::Error> {
        self.typed()
    }

    fn typed<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_value(Value::Object(self.fields.clone()))
    }
}

/// What a service node adds, per PRD section 5.3.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ServiceFields {
    /// How the service starts, in natural language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_point: Option<String>,
    /// The contract-method nodes published across the service boundary.
    ///
    /// Authored, never rolled up. An automatic roll-up leaks internals and
    /// misdescribes the surface, so everything absent here is internal by
    /// construction.
    #[serde(default)]
    pub exports: Vec<Uuid>,
    /// The schema definition for a data service, local or remote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schemas: Option<String>,
}

/// What a module node adds, per PRD section 5.4.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModuleFields {
    /// Registry entries this module may use. A library absent from the
    /// registry cannot enter this array.
    #[serde(default)]
    pub allowed_libraries: Vec<Uuid>,
    /// The screens this module backs.
    ///
    /// A derived cache of the `references_ui` edges, written by Schematify and
    /// never hand-edited. PRD section 5.11 makes the edge authoritative and
    /// makes a mismatch a linter error.
    #[serde(default)]
    pub ui_refs: Vec<Uri>,
}

/// What a `contract-method` facet adds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ContractMethodFields {
    /// The call signature, as written in the target language.
    pub signature: String,
    /// The parameters, one entry each.
    #[serde(default)]
    pub params: Vec<String>,
    /// What the method returns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returns: Option<String>,
    /// The failures the method declares.
    #[serde(default)]
    pub errors: Vec<String>,
    /// What the method does, in natural language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantics: Option<String>,
    /// Whether the method crosses the service boundary.
    #[serde(default)]
    pub exported: bool,
}

/// How far a declared test has got, per PRD section 5.5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestStatus {
    /// Written down, with no marker token in code.
    Declared,
    /// A marker token was found, with no result yet.
    Linked,
    /// The last run passed.
    Passing,
    /// The last run failed.
    Failing,
}

/// What a `test-case` facet adds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TestCaseFields {
    /// The starting condition.
    pub given: String,
    /// The action under test.
    pub when: String,
    /// The expected result.
    pub then: String,
    /// The marker token that binds this case to a code site.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impl_ref: Option<String>,
    /// How far this case has got.
    pub status: TestStatus,
    /// The duration the last run reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result_ms: Option<f64>,
}

/// What a budget failure costs, per PRD section 8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetTier {
    /// A probe failure blocks CI.
    Hard,
    /// A probe failure warns and needs one named human sign-off before merge.
    Soft,
    /// A probe result is tracked and graphed, and blocks nothing.
    Target,
}

impl BudgetTier {
    /// The badge string a card draws for this tier. A `target` budget draws no
    /// badge, which is why this returns an option rather than an empty string.
    #[must_use]
    pub fn badge(self) -> Option<&'static str> {
        match self {
            Self::Hard => Some("HARD"),
            Self::Soft => Some("SOFT"),
            Self::Target => None,
        }
    }
}

/// The command that measures a budget, per PRD section 8.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Probe {
    /// The command CI runs. Schematify never invokes it.
    pub command: String,
    /// The artifact schema the command emits.
    pub parser: String,
}

/// What a `budget` facet adds.
///
/// `probe` is optional in the schema and required by the linter: rule L03
/// makes a budget without a probe an error, because an unmeasurable claim is a
/// lint error and not a warning.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetFields {
    /// What is measured, such as `verify_p95`.
    pub metric: String,
    /// The comparison, such as `<`.
    pub op: String,
    /// The threshold.
    pub value: f64,
    /// The unit the threshold is in.
    pub unit: String,
    /// What a failure costs.
    pub tier: BudgetTier,
    /// The command that measures this budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<Probe>,
    /// The actor and run that signed off a soft budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_off: Option<String>,
}

/// Who a doc block is written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocAudience {
    /// Written for a coding agent.
    Agent,
    /// Written for a person.
    Human,
    /// Written for both.
    Both,
}

/// What a `doc-block` facet adds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocBlockFields {
    /// The prose.
    pub body: String,
    /// Who it is for.
    pub audience: DocAudience,
}

/// What an `external-dep` facet adds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExternalDepFields {
    /// The library registry entry this use points at.
    pub registry_ref: Uuid,
    /// Why this module uses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_note: Option<String>,
}

/// What a `comment` annotation adds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommentFields {
    /// The note.
    pub body: String,
    /// Who wrote it.
    pub author: String,
    /// The node this comment is anchored to. `None` floats it free.
    #[serde(default)]
    pub anchor: Option<Uuid>,
}

/// What a `group` annotation adds.
///
/// PRD section 5.5 lists `title` among a group's added fields. It is not here,
/// because the envelope already carries one and a node cannot hold two: the
/// heading drawn on the box is [`NodeEnvelope::title`]. Repeating it would put
/// two spellings of one name in one file and leave a reader to guess which the
/// interface draws.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupFields {
    /// The token name of the box colour. PRD section 13 bans a literal hex
    /// value in the interface, and this field carries a token name for the
    /// same reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// The nodes inside the box. A group nests inside another group.
    #[serde(default)]
    pub members: Vec<Uuid>,
    /// Whether the box is drawn collapsed.
    #[serde(default)]
    pub collapsed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(kind: NodeKind) -> NodeEnvelope {
        NodeEnvelope {
            id: Uuid::from_u128(1),
            slug: Slug::new("token-verifier").unwrap(),
            kind,
            title: "Token Verifier".to_owned(),
            description: Some("Verifies JWT signatures.".to_owned()),
            lifecycle: Lifecycle::Specified,
            layer: Some(Layer::Backend),
            parent: Some(Uuid::from_u128(2)),
            decisions: vec![Uri::decision(Uuid::from_u128(3))],
            authored_by: Authorship::Human,
            created: "2026-08-25T00:00:00Z".to_owned(),
            superseded_by: None,
            stale: None,
        }
    }

    fn round_trip(node: &Node) -> Node {
        let text = serde_json::to_string(node).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn the_envelope_round_trips() {
        let node = Node::new(envelope(NodeKind::Module));
        assert_eq!(round_trip(&node), node);
    }

    #[test]
    fn the_envelope_writes_a_flat_object() {
        let node = Node::new(envelope(NodeKind::Module));
        let value = serde_json::to_value(&node).unwrap();
        let map = value.as_object().unwrap();
        assert_eq!(map["kind"], "module");
        assert_eq!(map["slug"], "token-verifier");
        assert_eq!(
            map["decisions"][0],
            "schematify://decision/00000000-0000-0000-0000-000000000003"
        );
        assert!(!map.contains_key("facet_count"), "counts are never stored");
    }

    #[test]
    fn a_service_round_trips_with_its_own_fields() {
        let fields = ServiceFields {
            entry_point: Some("systemd unit".to_owned()),
            exports: vec![Uuid::from_u128(9)],
            schemas: Some("./schema.sql".to_owned()),
        };
        let node = Node::new(envelope(NodeKind::Service))
            .with_fields(&fields)
            .unwrap();
        let back = round_trip(&node);
        assert_eq!(back, node);
        assert_eq!(back.service().unwrap(), fields);
    }

    #[test]
    fn a_module_round_trips_with_its_own_fields() {
        let fields = ModuleFields {
            allowed_libraries: vec![Uuid::from_u128(4)],
            ui_refs: vec![Uri::screen(Uuid::from_u128(5))],
        };
        let node = Node::new(envelope(NodeKind::Module))
            .with_fields(&fields)
            .unwrap();
        assert_eq!(round_trip(&node).module().unwrap(), fields);
    }

    #[test]
    fn a_contract_method_round_trips_with_its_own_fields() {
        let fields = ContractMethodFields {
            signature: "verify_signature(token: string, jwks: KeySet)".to_owned(),
            params: vec!["token: string".to_owned(), "jwks: KeySet".to_owned()],
            returns: Some("Result<Claims, VerifyError>".to_owned()),
            errors: vec!["VerifyError".to_owned()],
            semantics: Some("Rejects on expiry.".to_owned()),
            exported: true,
        };
        let node = Node::new(envelope(NodeKind::ContractMethod))
            .with_fields(&fields)
            .unwrap();
        assert_eq!(round_trip(&node).contract_method().unwrap(), fields);
    }

    #[test]
    fn a_test_case_round_trips_with_its_own_fields() {
        let fields = TestCaseFields {
            given: "an expired token".to_owned(),
            when: "it is verified".to_owned(),
            then: "the call rejects".to_owned(),
            impl_ref: Some("@veistra:0192f4a1".to_owned()),
            status: TestStatus::Passing,
            last_result_ms: Some(41.0),
        };
        let node = Node::new(envelope(NodeKind::TestCase))
            .with_fields(&fields)
            .unwrap();
        assert_eq!(round_trip(&node).test_case().unwrap(), fields);
    }

    #[test]
    fn a_budget_round_trips_with_its_own_fields() {
        let fields = BudgetFields {
            metric: "verify_p95".to_owned(),
            op: "<".to_owned(),
            value: 3.0,
            unit: "ms".to_owned(),
            tier: BudgetTier::Hard,
            probe: Some(Probe {
                command: "pnpm bench:verify".to_owned(),
                parser: "veistra-bench-v1".to_owned(),
            }),
            sign_off: None,
        };
        let node = Node::new(envelope(NodeKind::Budget))
            .with_fields(&fields)
            .unwrap();
        assert_eq!(round_trip(&node).budget().unwrap(), fields);
        assert_eq!(BudgetTier::Hard.badge(), Some("HARD"));
        assert_eq!(BudgetTier::Target.badge(), None);
    }

    #[test]
    fn a_doc_block_an_external_dep_a_comment_and_a_group_round_trip() {
        let doc = DocBlockFields {
            body: "Call verify_signature first.".to_owned(),
            audience: DocAudience::Agent,
        };
        let dep = ExternalDepFields {
            registry_ref: Uuid::from_u128(6),
            usage_note: Some("MIT, registry ok".to_owned()),
        };
        let comment = CommentFields {
            body: "Two caches here on purpose.".to_owned(),
            author: "m.ross".to_owned(),
            anchor: Some(Uuid::from_u128(7)),
        };
        let group = GroupFields {
            color: Some("accent-1".to_owned()),
            members: vec![Uuid::from_u128(8)],
            collapsed: false,
        };
        assert_eq!(
            round_trip(
                &Node::new(envelope(NodeKind::DocBlock))
                    .with_fields(&doc)
                    .unwrap()
            )
            .doc_block()
            .unwrap(),
            doc
        );
        assert_eq!(
            round_trip(
                &Node::new(envelope(NodeKind::ExternalDep))
                    .with_fields(&dep)
                    .unwrap()
            )
            .external_dep()
            .unwrap(),
            dep
        );
        assert_eq!(
            round_trip(
                &Node::new(envelope(NodeKind::Comment))
                    .with_fields(&comment)
                    .unwrap()
            )
            .comment()
            .unwrap(),
            comment
        );
        assert_eq!(
            round_trip(
                &Node::new(envelope(NodeKind::Group))
                    .with_fields(&group)
                    .unwrap()
            )
            .group()
            .unwrap(),
            group
        );
    }

    #[test]
    fn an_unknown_kind_survives_a_round_trip_intact() {
        let mut node = Node::new(envelope(NodeKind::Custom("risk-register".to_owned())));
        node.fields
            .insert("severity".to_owned(), Value::from("high"));
        let back = round_trip(&node);
        assert_eq!(back, node);
        assert_eq!(back.kind().as_str(), "risk-register");
        assert_eq!(back.fields["severity"], "high");
    }

    #[test]
    fn the_annotation_tier_and_the_facet_tier_are_named() {
        assert!(NodeKind::Comment.is_annotation());
        assert!(NodeKind::Group.is_annotation());
        assert!(!NodeKind::Module.is_annotation());
        assert!(NodeKind::Budget.is_facet());
        assert!(!NodeKind::Service.is_facet());
        assert!(!NodeKind::Custom("x".to_owned()).is_facet());
    }

    #[test]
    fn every_layer_draws_its_badge() {
        assert_eq!(Layer::Backend.badge(), "BACKEND");
        assert_eq!(Layer::Data.badge(), "DATA");
        assert_eq!(Layer::Edge.badge(), "EDGE");
        assert_eq!(Layer::Frontend.badge(), "FRONTEND");
        assert_eq!(Layer::External.badge(), "EXTERNAL");
        assert_eq!(serde_json::to_string(&Layer::Edge).unwrap(), "\"edge\"");
    }

    #[test]
    fn a_typed_view_of_the_wrong_kind_reports_the_missing_field() {
        let node = Node::new(envelope(NodeKind::Module));
        assert!(node.contract_method().is_err());
    }
}
