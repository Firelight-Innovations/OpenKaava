//! Slugs, and the scope each kind is unique inside.
//!
//! PRD section 3.1 gives every element two identifiers and puts a hard line
//! between them: the `id` is what a reference stores, and the `slug` is what a
//! person reads. Renaming changes the slug alone, so nothing inbound breaks.
//!
//! Uniqueness is per scope and the scope differs by kind, which is the whole
//! content of PRD section 3.2. Two modules named `cache` are legal when they
//! sit under different parents and illegal when they sit under the same one.
//! [`SlugScope`] is that table as a type, so a caller cannot check uniqueness
//! against the wrong scope by accident.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::node::NodeKind;

/// A human-readable name, unique inside its scope.
///
/// The character set is deliberately wider than kebab case. A decision slug is
/// `DEC-TEC-AUTH-004` by PRD section 3.3, and a validator that insisted on
/// lowercase would reject the one slug shape the PRD spells out.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Slug(String);

impl Slug {
    /// Validate and wrap a slug.
    ///
    /// # Errors
    ///
    /// Returns [`SlugError::Malformed`] for an empty slug, one carrying a
    /// character outside `[A-Za-z0-9._-]`, or one that would not survive a
    /// round trip through a filename.
    pub fn new(text: impl Into<String>) -> Result<Self, SlugError> {
        let text = text.into();
        let legal = !text.is_empty()
            && text.len() <= 128
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && !text.starts_with('.');
        if legal {
            Ok(Self(text))
        } else {
            Err(SlugError::Malformed { slug: text })
        }
    }

    /// The slug as it is written.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether this slug matches the `DEC-<AREA>-<TOPIC>-<NNN>` shape PRD
    /// section 3.3 requires of a decision.
    #[must_use]
    pub fn is_decision_shaped(&self) -> bool {
        let parts: Vec<&str> = self.0.split('-').collect();
        parts.len() == 4
            && parts[0] == "DEC"
            && parts[1..3]
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_uppercase()))
            && parts[3].len() == 3
            && parts[3].chars().all(|c| c.is_ascii_digit())
    }
}

impl fmt::Display for Slug {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for Slug {
    type Error = SlugError;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        Self::new(text)
    }
}

impl From<Slug> for String {
    fn from(slug: Slug) -> Self {
        slug.0
    }
}

/// The scope a slug has to be unique inside, one variant per row of PRD
/// section 3.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SlugScope {
    /// A service is unique across the project root.
    ProjectRoot,
    /// A module is unique inside its containment parent.
    ContainmentParent(Uuid),
    /// A facet is unique inside its module root, which is the nearest module
    /// ancestor rather than the immediate parent.
    ModuleRoot(Uuid),
    /// A screen is unique across the screen collection.
    ScreenCollection,
    /// A flow is unique across the flow collection.
    FlowCollection,
    /// A decision is unique across the decision collection.
    DecisionCollection,
    /// A rule is unique across the rule registry.
    RuleRegistry,
    /// A library is unique across the library registry.
    LibraryRegistry,
}

impl SlugScope {
    /// The scope a node of this kind sits in.
    ///
    /// `parent` is the containment parent for a module and the module root for
    /// a facet. A service ignores it, because a service is scoped to the
    /// project root whatever it is nested under.
    #[must_use]
    pub fn for_node(kind: &NodeKind, parent: Option<Uuid>) -> Self {
        match kind {
            NodeKind::Service => Self::ProjectRoot,
            NodeKind::Module | NodeKind::Group => {
                parent.map_or(Self::ProjectRoot, Self::ContainmentParent)
            }
            _ => parent.map_or(Self::ProjectRoot, Self::ModuleRoot),
        }
    }
}

/// Every slug claimed so far, and by what.
///
/// The loader builds one of these as it walks `.veistra/` and reports a
/// collision rather than letting the second file win silently.
#[derive(Debug, Default, Clone)]
pub struct SlugIndex {
    claims: HashMap<(SlugScope, String), Uuid>,
}

impl SlugIndex {
    /// An index with nothing claimed.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim a slug for an identifier.
    ///
    /// Claiming the same slug for the same identifier twice succeeds: a caller
    /// that re-reads a file it already read has not created a collision.
    ///
    /// # Errors
    ///
    /// Returns [`SlugError::Duplicate`] when a different identifier already
    /// holds this slug in this scope.
    pub fn claim(&mut self, scope: SlugScope, slug: &Slug, id: Uuid) -> Result<(), SlugError> {
        let key = (scope, slug.as_str().to_owned());
        match self.claims.get(&key) {
            Some(&held) if held == id => Ok(()),
            Some(&held) => Err(SlugError::Duplicate {
                slug: slug.as_str().to_owned(),
                held_by: held,
                claimed_by: id,
            }),
            None => {
                self.claims.insert(key, id);
                Ok(())
            }
        }
    }

    /// What holds a slug in a scope, if anything does.
    #[must_use]
    pub fn lookup(&self, scope: SlugScope, slug: &str) -> Option<Uuid> {
        self.claims.get(&(scope, slug.to_owned())).copied()
    }

    /// How many slugs are claimed.
    #[must_use]
    pub fn len(&self) -> usize {
        self.claims.len()
    }

    /// Whether nothing has been claimed.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.claims.is_empty()
    }
}

/// Why a slug was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SlugError {
    /// The text is not a legal slug.
    #[error("invalid slug {slug:?}: must be 1 to 128 characters of [A-Za-z0-9._-] and not lead with a dot")]
    Malformed {
        /// The text that was offered.
        slug: String,
    },

    /// Another identifier already holds this slug in this scope.
    #[error("duplicate slug {slug:?} in scope: held by {held_by}, claimed by {claimed_by}")]
    Duplicate {
        /// The slug that collided.
        slug: String,
        /// The identifier that got there first.
        held_by: Uuid,
        /// The identifier that arrived second.
        claimed_by: Uuid,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slug(text: &str) -> Slug {
        Slug::new(text).unwrap()
    }

    #[test]
    fn a_legal_slug_is_accepted_and_an_illegal_one_is_not() {
        assert_eq!(slug("token-verifier").as_str(), "token-verifier");
        assert_eq!(slug("DEC-TEC-AUTH-004").as_str(), "DEC-TEC-AUTH-004");
        assert!(Slug::new("").is_err());
        assert!(Slug::new("has space").is_err());
        assert!(Slug::new("has/slash").is_err());
        assert!(Slug::new(".hidden").is_err());
    }

    #[test]
    fn a_decision_slug_is_recognised_by_shape() {
        assert!(slug("DEC-TEC-AUTH-004").is_decision_shaped());
        assert!(!slug("DEC-TEC-AUTH-4").is_decision_shaped());
        assert!(!slug("dec-tec-auth-004").is_decision_shaped());
        assert!(!slug("token-verifier").is_decision_shaped());
    }

    #[test]
    fn a_slug_round_trips_through_json() {
        let value = slug("token-verifier");
        let text = serde_json::to_string(&value).unwrap();
        assert_eq!(text, "\"token-verifier\"");
        assert_eq!(serde_json::from_str::<Slug>(&text).unwrap(), value);
        assert!(serde_json::from_str::<Slug>("\"has space\"").is_err());
    }

    #[test]
    fn one_scope_refuses_a_second_claim_on_the_same_slug() {
        let mut index = SlugIndex::new();
        let first = Uuid::from_u128(1);
        let second = Uuid::from_u128(2);
        index
            .claim(SlugScope::ProjectRoot, &slug("cache"), first)
            .unwrap();
        let err = index
            .claim(SlugScope::ProjectRoot, &slug("cache"), second)
            .unwrap_err();
        assert!(matches!(err, SlugError::Duplicate { .. }));
    }

    #[test]
    fn two_scopes_hold_the_same_slug_without_colliding() {
        let mut index = SlugIndex::new();
        let parent_a = Uuid::from_u128(10);
        let parent_b = Uuid::from_u128(11);
        index
            .claim(
                SlugScope::ContainmentParent(parent_a),
                &slug("cache"),
                Uuid::from_u128(1),
            )
            .unwrap();
        index
            .claim(
                SlugScope::ContainmentParent(parent_b),
                &slug("cache"),
                Uuid::from_u128(2),
            )
            .unwrap();
        assert_eq!(index.len(), 2);
    }

    #[test]
    fn re_claiming_a_slug_for_the_same_id_is_not_a_collision() {
        let mut index = SlugIndex::new();
        let id = Uuid::from_u128(1);
        index
            .claim(SlugScope::ScreenCollection, &slug("login-form"), id)
            .unwrap();
        index
            .claim(SlugScope::ScreenCollection, &slug("login-form"), id)
            .unwrap();
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn a_service_is_scoped_to_the_project_root_whatever_contains_it() {
        let parent = Some(Uuid::from_u128(7));
        assert_eq!(
            SlugScope::for_node(&NodeKind::Service, parent),
            SlugScope::ProjectRoot
        );
        assert_eq!(
            SlugScope::for_node(&NodeKind::Module, parent),
            SlugScope::ContainmentParent(Uuid::from_u128(7))
        );
        assert_eq!(
            SlugScope::for_node(&NodeKind::ContractMethod, parent),
            SlugScope::ModuleRoot(Uuid::from_u128(7))
        );
    }

    #[test]
    fn an_empty_index_reports_itself_empty() {
        let index = SlugIndex::new();
        assert!(index.is_empty());
        assert_eq!(index.lookup(SlugScope::RuleRegistry, "anything"), None);
    }
}
