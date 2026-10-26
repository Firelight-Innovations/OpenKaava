//! The rule registry and the library registry of PRD sections 5.10 and 10.
//!
//! These two are registries rather than nodes, and they behave differently
//! from each other on disk. A rule is one file per entry like everything else.
//! The library registry is one file holding an array, and it is the stated
//! exception to the one-node-per-file rule: PRD section 10.3 derives the whole
//! tech-stack view from it, and a derivation that has to open two hundred
//! files to answer "which modules use jose" is a derivation nobody runs.
//!
//! License enforcement runs at design time, which is what makes the registry
//! worth a file of its own. A GPL dependency is a blocked add while somebody
//! is drawing, rather than a legal finding after a release.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::lifecycle::AuditRow;
use crate::node::{Node, NodeKind};
use crate::slug::Slug;

/// What a rule violation costs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// The build stops.
    Error,
    /// The build continues and says so.
    Warning,
    /// A person looks at it.
    Review,
}

/// One code standard an agent follows on the target project.
///
/// Closed to unknown fields for the reason [`crate::Screen`] gives.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    /// The UUIDv7 every reference stores.
    pub id: Uuid,
    /// The name, unique across the rule registry.
    pub slug: Slug,
    /// The rule, in one sentence.
    pub statement: String,
    /// The command that enforces it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The marker token that locates its implementation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    /// What a violation costs.
    pub severity: Severity,
    /// This rule's own history.
    #[serde(default)]
    pub audit: Vec<AuditRow>,
}

/// One approved external library.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryEntry {
    /// The UUIDv7 a module's `allowed_libraries` array stores.
    pub id: Uuid,
    /// The package name, as the ecosystem spells it.
    pub name: String,
    /// The pinned version.
    pub version: String,
    /// The license, as an SPDX identifier.
    pub license: String,
    /// Why this library is approved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    /// The decision that approved it.
    #[serde(default)]
    pub decision: Option<Uuid>,
}

/// The whole of `registry/libraries.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryRegistry {
    /// Every approved library, in one global list.
    #[serde(default)]
    pub libraries: Vec<LibraryEntry>,
}

impl LibraryRegistry {
    /// Look up one entry by identifier.
    #[must_use]
    pub fn get(&self, id: Uuid) -> Option<&LibraryEntry> {
        self.libraries.iter().find(|entry| entry.id == id)
    }

    /// Whether an identifier names an approved library.
    ///
    /// Linter rule L04 is this question asked of every entry in every module's
    /// `allowed_libraries` array.
    #[must_use]
    pub fn contains(&self, id: Uuid) -> bool {
        self.get(id).is_some()
    }

    /// Look up one entry by package name.
    #[must_use]
    pub fn by_name(&self, name: &str) -> Option<&LibraryEntry> {
        self.libraries.iter().find(|entry| entry.name == name)
    }

    /// Add a library, or refuse it and say why.
    ///
    /// This is the design-time gate of PRD sections 10.1 and 12.15. The
    /// refusal carries the reason so the surface states it at the point of the
    /// add, rather than reporting a failure the user has to go and interpret.
    ///
    /// # Errors
    ///
    /// [`RegistryError::BlockedLicense`] when the policy blocks the licence,
    /// and [`RegistryError::AlreadyRegistered`] when the name or the
    /// identifier is already held.
    pub fn add(
        &mut self,
        entry: LibraryEntry,
        policy: &LicensePolicy,
    ) -> std::result::Result<(), RegistryError> {
        if let Some(held) = self.by_name(&entry.name) {
            return Err(RegistryError::AlreadyRegistered {
                name: entry.name.clone(),
                version: held.version.clone(),
            });
        }
        if self.contains(entry.id) {
            return Err(RegistryError::AlreadyRegistered {
                name: entry.name.clone(),
                version: entry.version.clone(),
            });
        }
        if let LicenseVerdict::Blocked { pattern, reason } = policy.verdict(&entry.license) {
            return Err(RegistryError::BlockedLicense {
                name: entry.name,
                version: entry.version,
                license: entry.license,
                pattern,
                reason,
            });
        }
        self.libraries.push(entry);
        Ok(())
    }
}

/// Why an add was refused, in words a surface draws unchanged.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RegistryError {
    /// The licence is one this project does not take.
    #[error("{name} {version} is licensed {license}, which this project blocks under {pattern}: {reason}")]
    BlockedLicense {
        /// The package the caller asked to add.
        name: String,
        /// Its pinned version.
        version: String,
        /// The licence read off the entry.
        license: String,
        /// The policy entry that matched.
        pattern: String,
        /// Why that entry exists, stated for the person doing the add.
        reason: String,
    },

    /// PRD section 10.1 holds one global list, so one entry per library.
    #[error("{name} is already in the registry, pinned at {version}; edit that entry rather than adding a second")]
    AlreadyRegistered {
        /// The package name already held.
        name: String,
        /// The version the held entry pins.
        version: String,
    },

    /// PRD section 10.1: a module whitelists a library in the registry and no
    /// other. This is that rule at the moment of the write.
    #[error("library {library} is not in the registry, so {module} cannot whitelist it")]
    LibraryNotInRegistry {
        /// The library the caller named.
        library: Uuid,
        /// The module that named it.
        module: Uuid,
    },

    /// Only a module carries `allowed_libraries`, per PRD section 5.4.
    #[error("{id} is a {kind} and carries no allowed_libraries")]
    NotAModule {
        /// The node the caller passed.
        id: Uuid,
        /// What kind it turned out to be.
        kind: String,
    },

    /// The node held an `allowed_libraries` value that is not an array of
    /// identifiers, so the whitelist could not be read to be written.
    #[error("cannot read the module fields of {id}: {detail}")]
    UnreadableModule {
        /// The node whose fields failed to parse.
        id: Uuid,
        /// The underlying cause, as the deserializer reported it.
        detail: String,
    },
}

/// One entry of the licence policy: what it matches, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockedLicense {
    /// An SPDX identifier, or the family prefix of one. `GPL` matches
    /// `GPL-3.0-only` and does not match `LGPL-3.0`, which is why the default
    /// policy names the three families separately.
    pub pattern: String,
    /// Why this project does not take it. The refusal states this.
    pub reason: String,
}

/// What a licence verdict came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseVerdict {
    /// The policy takes it.
    Allowed,
    /// The policy does not, and this is the entry that said so.
    Blocked {
        /// The policy entry that matched, or `allow-list` in allow-list mode.
        pattern: String,
        /// Why, stated for the person doing the add.
        reason: String,
    },
}

/// Which licences a project takes, per PRD section 10.1.
///
/// **A deny-list by default, unlike this repository's own `deny.toml`.** The
/// argument for an allow-list is sound where the set of licences is knowable,
/// which is true of one repository's dependency tree and false of every
/// project Schematify is ever pointed at. A default allow-list would refuse
/// `Unlicense` the first time somebody added a library under it, and the thing
/// a person does when a check refuses something obviously fine is switch the
/// check off. A project that wants the stricter shape sets `allowed`, and gets
/// it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LicensePolicy {
    /// Licences this project refuses, each with its reason.
    #[serde(default)]
    pub blocked: Vec<BlockedLicense>,
    /// When set, the only licences this project takes. Anything absent is
    /// refused, which is the allow-list shape `deny.toml` argues for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed: Option<Vec<String>>,
}

impl Default for LicensePolicy {
    /// The copyleft families, and nothing else.
    ///
    /// PRD section 10.1 names GPL alone. The other two families are here
    /// because a policy that blocks `GPL-3.0` and takes `AGPL-3.0` is not a
    /// policy anybody meant to write, and SPDX spells them as separate
    /// identifiers that no prefix of `GPL` reaches.
    fn default() -> Self {
        Self {
            blocked: vec![
                BlockedLicense {
                    pattern: "GPL".to_owned(),
                    reason: "GPL is copyleft: linking it in can oblige the whole work to be \
                             released under the GPL."
                        .to_owned(),
                },
                BlockedLicense {
                    pattern: "AGPL".to_owned(),
                    reason: "AGPL is network copyleft: the release obligation reaches users \
                             served over a network, not only those given a binary."
                        .to_owned(),
                },
                BlockedLicense {
                    pattern: "LGPL".to_owned(),
                    reason: "LGPL is weak copyleft and constrains static linking and \
                             modification of the library."
                        .to_owned(),
                },
            ],
            allowed: None,
        }
    }
}

impl LicensePolicy {
    /// A policy that blocks nothing, for a project that does not want the gate.
    #[must_use]
    pub fn permissive() -> Self {
        Self {
            blocked: Vec::new(),
            allowed: None,
        }
    }

    /// Whether this project takes a licence, and why not when it does not.
    #[must_use]
    pub fn verdict(&self, license: &str) -> LicenseVerdict {
        let found = license.trim();
        for entry in &self.blocked {
            if matches_family(found, &entry.pattern) {
                return LicenseVerdict::Blocked {
                    pattern: entry.pattern.clone(),
                    reason: entry.reason.clone(),
                };
            }
        }
        if let Some(allowed) = &self.allowed {
            if !allowed.iter().any(|a| a.eq_ignore_ascii_case(found)) {
                return LicenseVerdict::Blocked {
                    pattern: "allow-list".to_owned(),
                    reason: format!(
                        "this project runs a licence allow-list and {found} is not on it"
                    ),
                };
            }
        }
        LicenseVerdict::Allowed
    }
}

/// Whether a licence identifier belongs to a licence family.
///
/// Three shapes count, and the third is the one that matters. The name on its
/// own, `GPL`. The name and a separator, which is canonical SPDX:
/// `GPL-3.0-only`, `GPL+`, `GPL 2.0`. And the name with the version written
/// straight onto it, which is how people who are not reading SPDX spell it:
/// `GPLv2`, `GPL2`, `AGPLv3`.
///
/// Without that third shape the gate does half a job. A registry that blocks
/// `GPL-2.0` and admits `GPLv2` blocks a spelling rather than a licence, and
/// the entry a person is most likely to type by hand is the one that gets in.
/// Every fixture and every canonical identifier uses a separator, which is
/// exactly why nothing here caught it.
///
/// A version suffix is a digit, optionally behind a `v`. That is what keeps
/// `GPLish-1.0` out: `i` is neither. A different family stays out on the
/// prefix alone, since `LGPL-3.0` does not begin with `GPL`, and `LGPL` has
/// its own entry in the default policy.
fn matches_family(license: &str, pattern: &str) -> bool {
    if license.eq_ignore_ascii_case(pattern) {
        return true;
    }
    let Some(head) = license.get(..pattern.len()) else {
        return false;
    };
    if !head.eq_ignore_ascii_case(pattern) {
        return false;
    }
    let mut tail = license[pattern.len()..].chars();
    let Some(next) = tail.next() else {
        return false;
    };
    if !next.is_ascii_alphanumeric() {
        return true;
    }
    if next.is_ascii_digit() {
        return true;
    }
    next.eq_ignore_ascii_case(&'v') && tail.next().is_some_and(|c| c.is_ascii_digit())
}

/// Whitelist a library on a module, or refuse it and say why.
///
/// PRD section 10.1: a module whitelists a library present in the registry and
/// no other. This is that rule at the moment of the write, which is the only
/// place it can be a refusal rather than a report.
///
/// Linter rule L04 asks the same question of the whole graph and is not
/// redundant with this. A `.veistra/` tree arrives by `git merge` and by hand as
/// well as through this function, and a rule that only guards one of those
/// three doors guards nothing. This one refuses; L04 finds what got in anyway.
///
/// Adding a library the module already holds succeeds and changes nothing, so
/// a caller retrying a write does not have to check first.
///
/// # Errors
///
/// [`RegistryError::NotAModule`] when the node carries no `allowed_libraries`,
/// [`RegistryError::LibraryNotInRegistry`] when the registry lacks the
/// library, and [`RegistryError::UnreadableModule`] when the node's own fields
/// will not parse.
pub fn whitelist_library(
    module: &mut Node,
    registry: &LibraryRegistry,
    library: Uuid,
) -> std::result::Result<(), RegistryError> {
    if *module.kind() != NodeKind::Module {
        return Err(RegistryError::NotAModule {
            id: module.id(),
            kind: module.kind().as_str().to_owned(),
        });
    }
    if !registry.contains(library) {
        return Err(RegistryError::LibraryNotInRegistry {
            library,
            module: module.id(),
        });
    }
    let mut fields = module
        .module()
        .map_err(|cause| RegistryError::UnreadableModule {
            id: module.id(),
            detail: cause.to_string(),
        })?;
    if fields.allowed_libraries.contains(&library) {
        return Ok(());
    }
    fields.allowed_libraries.push(library);
    // The open map is the node's own storage, so writing the whole parsed
    // struct back cannot lose a field: everything in it was just read out of
    // that same map.
    if let Ok(serde_json::Value::Object(map)) = serde_json::to_value(&fields) {
        module.fields.extend(map);
    }
    Ok(())
}

/// The rule registry of PRD section 10.2, arranged as the document that PRD
/// section 12.15 asks for rather than as a configuration dump.
///
/// The arrangement is by severity, because what a violation costs is the thing
/// a reader is deciding about when they scan a standards document: these stop
/// the build, these warn, these get a human look. Within a section the order
/// is by slug, so the page does not reshuffle between loads.
///
/// Nothing here is stored. PRD section 0.4 makes a count a draw-time
/// computation, and this whole type is one: it is built from the rules the
/// graph already holds and thrown away after the page renders.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleDocument {
    /// The sections, in severity order. A severity no rule carries is absent
    /// rather than empty, so the page holds no heading with nothing under it.
    pub sections: Vec<RuleSection>,
}

/// One section of the rule document.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleSection {
    /// The severity every rule in this section carries.
    pub severity: Severity,
    /// The heading the section draws.
    pub heading: &'static str,
    /// What this severity means, drawn under the heading so the document
    /// explains its own arrangement.
    pub caption: &'static str,
    /// The rules, in slug order.
    pub rules: Vec<RuleRow>,
}

/// One rule as the document draws it.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleRow {
    /// The rule this row came from.
    pub id: Uuid,
    /// The name, drawn as the row heading.
    pub slug: String,
    /// The standard, in one sentence. This is the body of the row.
    pub statement: String,
    /// The command that enforces it, where there is one.
    pub command: Option<String>,
    /// The marker token that locates its implementation, where there is one.
    pub marker: Option<String>,
    /// The most recent row of this rule's own audit history, which is what
    /// dates the standard on the page.
    pub last_change: Option<AuditRow>,
}

impl RuleDocument {
    /// Arrange a set of rules as the document.
    #[must_use]
    pub fn build<'a>(rules: impl Iterator<Item = &'a Rule>) -> Self {
        let mut held: Vec<&Rule> = rules.collect();
        held.sort_by(|a, b| a.slug.as_str().cmp(b.slug.as_str()));

        let sections = [
            (
                Severity::Error,
                "MUST",
                "A violation stops the build. An agent does not merge past one.",
            ),
            (
                Severity::Warning,
                "SHOULD",
                "A violation warns and says so. The build continues.",
            ),
            (
                Severity::Review,
                "UNDER REVIEW",
                "A violation is drawn to a person, who decides.",
            ),
        ]
        .into_iter()
        .filter_map(|(severity, heading, caption)| {
            let rules: Vec<RuleRow> = held
                .iter()
                .filter(|rule| rule.severity == severity)
                .map(|rule| RuleRow {
                    id: rule.id,
                    slug: rule.slug.as_str().to_owned(),
                    statement: rule.statement.clone(),
                    command: rule.command.clone(),
                    marker: rule.marker.clone(),
                    last_change: rule.audit.last().cloned(),
                })
                .collect();
            if rules.is_empty() {
                None
            } else {
                Some(RuleSection {
                    severity,
                    heading,
                    caption,
                    rules,
                })
            }
        })
        .collect();

        Self { sections }
    }

    /// How many rules the document holds.
    ///
    /// This is the left half of the dashboard `LINTER` card of PRD section
    /// 10.2, which the wireframe draws as `14 rules · 0 violations`. The right
    /// half is a violation count, and it does not come from here: this
    /// registry holds the standards an agent follows on the target project,
    /// and the graph linter of section 10.4 is a different set of rules
    /// entirely. The wave 7a handoff records that the two are not the same
    /// number.
    #[must_use]
    pub fn rule_count(&self) -> usize {
        self.sections.iter().map(|s| s.rules.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::{Actor, Lifecycle};

    fn library() -> LibraryEntry {
        LibraryEntry {
            id: Uuid::from_u128(1),
            name: "jose".to_owned(),
            version: "5.2.4".to_owned(),
            license: "MIT".to_owned(),
            rationale: Some("JWT verification without a hand-rolled parser.".to_owned()),
            decision: Some(Uuid::from_u128(2)),
        }
    }

    #[test]
    fn a_rule_round_trips_with_its_audit_history() {
        let rule = Rule {
            id: Uuid::from_u128(1),
            slug: Slug::new("no-unwrap").unwrap(),
            statement: "No unwrap on anything that touches the filesystem.".to_owned(),
            command: Some("cargo clippy".to_owned()),
            marker: Some("@veistra:0192f4a1".to_owned()),
            severity: Severity::Error,
            audit: vec![AuditRow {
                node: Uuid::from_u128(1),
                at: "2026-08-25T00:00:00Z".to_owned(),
                from: Lifecycle::Draft,
                to: Lifecycle::Specified,
                actor: Actor::Human,
                actor_name: "m.ross".to_owned(),
                reason: "Written up.".to_owned(),
            }],
        };
        let text = serde_json::to_string(&rule).unwrap();
        assert_eq!(serde_json::from_str::<Rule>(&text).unwrap(), rule);
    }

    #[test]
    fn the_registry_round_trips_as_one_object_holding_an_array() {
        let registry = LibraryRegistry {
            libraries: vec![library()],
        };
        let value = serde_json::to_value(&registry).unwrap();
        assert!(value["libraries"].is_array());
        let text = serde_json::to_string(&registry).unwrap();
        assert_eq!(
            serde_json::from_str::<LibraryRegistry>(&text).unwrap(),
            registry
        );
    }

    #[test]
    fn the_registry_answers_the_question_rule_l04_asks() {
        let registry = LibraryRegistry {
            libraries: vec![library()],
        };
        assert!(registry.contains(Uuid::from_u128(1)));
        assert!(!registry.contains(Uuid::from_u128(99)));
        assert_eq!(
            registry.by_name("jose").map(|e| e.version.as_str()),
            Some("5.2.4")
        );
        assert!(registry.by_name("left-pad").is_none());
    }

    #[test]
    fn an_empty_registry_parses_from_an_empty_object() {
        let registry: LibraryRegistry = serde_json::from_str("{}").unwrap();
        assert!(registry.libraries.is_empty());
    }

    #[test]
    fn every_severity_writes_its_word() {
        assert_eq!(
            serde_json::to_string(&Severity::Error).unwrap(),
            "\"error\""
        );
        assert_eq!(
            serde_json::to_string(&Severity::Warning).unwrap(),
            "\"warning\""
        );
        assert_eq!(
            serde_json::to_string(&Severity::Review).unwrap(),
            "\"review\""
        );
    }

    fn module(id: u128, slug: &str) -> Node {
        use crate::lifecycle::Lifecycle;
        use crate::node::{Authorship, ModuleFields, NodeEnvelope};
        Node::new(NodeEnvelope {
            id: Uuid::from_u128(id),
            slug: Slug::new(slug).unwrap(),
            kind: NodeKind::Module,
            title: slug.to_owned(),
            description: None,
            lifecycle: Lifecycle::Specified,
            layer: None,
            parent: None,
            decisions: Vec::new(),
            authored_by: Authorship::Human,
            created: "2026-08-25T00:00:00Z".to_owned(),
            superseded_by: None,
            stale: None,
        })
        .with_fields(&ModuleFields::default())
        .unwrap()
    }

    fn gpl() -> LibraryEntry {
        LibraryEntry {
            id: Uuid::from_u128(9),
            name: "readline".to_owned(),
            version: "8.2".to_owned(),
            license: "GPL-3.0-or-later".to_owned(),
            rationale: None,
            decision: None,
        }
    }

    #[test]
    fn a_blocked_licence_is_refused_and_the_refusal_states_the_reason() {
        let mut registry = LibraryRegistry::default();
        let error = registry
            .add(gpl(), &LicensePolicy::default())
            .expect_err("GPL is blocked");

        let RegistryError::BlockedLicense {
            name,
            license,
            pattern,
            reason,
            ..
        } = &error
        else {
            panic!("wrong refusal: {error}");
        };
        assert_eq!(name, "readline");
        assert_eq!(license, "GPL-3.0-or-later");
        assert_eq!(pattern, "GPL");
        assert!(reason.contains("copyleft"), "the reason says why: {reason}");
        // The whole message is what a surface draws at the point of the add.
        let drawn = error.to_string();
        assert!(drawn.contains("readline 8.2"), "{drawn}");
        assert!(drawn.contains("GPL-3.0-or-later"), "{drawn}");
        assert!(drawn.contains(reason.as_str()), "{drawn}");
        assert!(registry.libraries.is_empty(), "nothing was added");
    }

    #[test]
    fn the_three_copyleft_families_are_blocked_and_the_permissive_ones_are_not() {
        let policy = LicensePolicy::default();
        for blocked in [
            "GPL-2.0",
            "GPL-3.0-only",
            "AGPL-3.0",
            "LGPL-2.1-or-later",
            "gpl-3.0",
        ] {
            assert!(
                matches!(policy.verdict(blocked), LicenseVerdict::Blocked { .. }),
                "{blocked} should be blocked"
            );
        }
        for allowed in ["MIT", "Apache-2.0", "Unlicense", "BSD-3-Clause", "MPL-2.0"] {
            assert_eq!(
                policy.verdict(allowed),
                LicenseVerdict::Allowed,
                "{allowed} should be allowed"
            );
        }
    }

    #[test]
    fn a_family_prefix_does_not_reach_a_different_family_or_a_longer_word() {
        let policy = LicensePolicy::default();
        // LGPL is its own family, blocked by its own entry rather than by the
        // GPL one. A name that merely starts with those letters is not.
        assert!(matches!(
            policy.verdict("LGPL-3.0"),
            LicenseVerdict::Blocked { ref pattern, .. } if pattern == "LGPL"
        ));
        assert_eq!(policy.verdict("GPLish-1.0"), LicenseVerdict::Allowed);
        assert_eq!(policy.verdict("MIT"), LicenseVerdict::Allowed);
    }

    #[test]
    fn a_version_written_straight_onto_the_family_name_is_still_that_family() {
        let policy = LicensePolicy::default();
        // The spellings a person types by hand. Blocking `GPL-2.0` and
        // admitting `GPLv2` would block a spelling rather than a licence.
        for blocked in [
            "GPLv2", "GPLv3", "GPL2", "GPL3", "gplv2", "AGPLv3", "LGPLv2", "LGPL3",
        ] {
            assert!(
                matches!(policy.verdict(blocked), LicenseVerdict::Blocked { .. }),
                "{blocked} is the same licence as its SPDX spelling"
            );
        }
        // And the boundary still holds: a longer word is a different name.
        for allowed in ["GPLish", "GPLish-1.0", "GPLv", "AGPLish2"] {
            assert_eq!(
                policy.verdict(allowed),
                LicenseVerdict::Allowed,
                "{allowed} is not a copyleft family"
            );
        }
    }

    #[test]
    fn a_separatorless_spelling_is_refused_at_the_add_like_any_other() {
        let mut registry = LibraryRegistry::default();
        let mut entry = gpl();
        entry.license = "GPLv2".to_owned();

        let error = registry
            .add(entry, &LicensePolicy::default())
            .expect_err("GPLv2 is GPL");
        let drawn = error.to_string();
        assert!(drawn.contains("GPLv2"), "{drawn}");
        assert!(drawn.contains("copyleft"), "{drawn}");
        assert!(registry.libraries.is_empty(), "nothing was added");
    }

    #[test]
    fn an_allow_list_refuses_everything_it_does_not_name() {
        let policy = LicensePolicy {
            blocked: Vec::new(),
            allowed: Some(vec!["MIT".to_owned(), "Apache-2.0".to_owned()]),
        };
        assert_eq!(policy.verdict("MIT"), LicenseVerdict::Allowed);
        assert_eq!(policy.verdict("apache-2.0"), LicenseVerdict::Allowed);
        let verdict = policy.verdict("Unlicense");
        let LicenseVerdict::Blocked { pattern, reason } = verdict else {
            panic!("an allow-list refuses what it does not name");
        };
        assert_eq!(pattern, "allow-list");
        assert!(reason.contains("Unlicense"), "{reason}");
    }

    #[test]
    fn a_permitted_licence_is_added_and_a_second_entry_for_it_is_refused() {
        let mut registry = LibraryRegistry::default();
        registry.add(library(), &LicensePolicy::default()).unwrap();
        assert_eq!(registry.libraries.len(), 1);
        assert!(registry.contains(Uuid::from_u128(1)));

        let mut second = library();
        second.id = Uuid::from_u128(2);
        second.version = "5.3.0".to_owned();
        let error = registry
            .add(second, &LicensePolicy::default())
            .expect_err("one global list holds one entry per library");
        assert!(error.to_string().contains("5.2.4"), "{error}");
        assert_eq!(registry.libraries.len(), 1);
    }

    #[test]
    fn a_permissive_policy_takes_what_the_default_blocks() {
        let mut registry = LibraryRegistry::default();
        registry.add(gpl(), &LicensePolicy::permissive()).unwrap();
        assert_eq!(registry.libraries.len(), 1);
    }

    #[test]
    fn a_module_cannot_whitelist_a_library_the_registry_lacks() {
        let registry = LibraryRegistry {
            libraries: vec![library()],
        };
        let mut node = module(10, "token-issuer");
        let absent = Uuid::from_u128(99);

        let error = whitelist_library(&mut node, &registry, absent).expect_err("not registered");
        assert!(matches!(
            error,
            RegistryError::LibraryNotInRegistry { library, module }
                if library == absent && module == Uuid::from_u128(10)
        ));
        assert!(
            node.module().unwrap().allowed_libraries.is_empty(),
            "the refusal wrote nothing"
        );
    }

    #[test]
    fn whitelisting_a_registered_library_writes_it_once_however_often_it_is_asked() {
        let registry = LibraryRegistry {
            libraries: vec![library()],
        };
        let mut node = module(10, "token-issuer");
        whitelist_library(&mut node, &registry, Uuid::from_u128(1)).unwrap();
        whitelist_library(&mut node, &registry, Uuid::from_u128(1)).unwrap();
        assert_eq!(
            node.module().unwrap().allowed_libraries,
            [Uuid::from_u128(1)]
        );
        // The other module field survived the rewrite of the open map.
        assert!(node.module().unwrap().ui_refs.is_empty());
    }

    #[test]
    fn only_a_module_carries_a_whitelist() {
        let registry = LibraryRegistry {
            libraries: vec![library()],
        };
        let mut node = module(10, "token-issuer");
        node.envelope.kind = NodeKind::Service;
        let error = whitelist_library(&mut node, &registry, Uuid::from_u128(1))
            .expect_err("a service holds no allowed_libraries");
        assert!(error.to_string().contains("service"), "{error}");
    }

    fn rule(id: u128, slug: &str, severity: Severity) -> Rule {
        Rule {
            id: Uuid::from_u128(id),
            slug: Slug::new(slug).unwrap(),
            statement: format!("The {slug} standard."),
            command: Some("pnpm verify".to_owned()),
            marker: None,
            severity,
            audit: Vec::new(),
        }
    }

    #[test]
    fn the_rule_document_reads_by_severity_and_by_slug_inside_it() {
        let rules = [
            rule(1, "no-unwrap", Severity::Error),
            rule(2, "tokens-not-hex", Severity::Warning),
            rule(3, "append-only-audit", Severity::Error),
        ];
        let document = RuleDocument::build(rules.iter());

        assert_eq!(document.rule_count(), 3);
        assert_eq!(document.sections.len(), 2, "no rule is under review");
        assert_eq!(document.sections[0].severity, Severity::Error);
        assert_eq!(document.sections[0].heading, "MUST");
        assert_eq!(
            document.sections[0]
                .rules
                .iter()
                .map(|r| r.slug.as_str())
                .collect::<Vec<_>>(),
            ["append-only-audit", "no-unwrap"],
            "slug order inside a section"
        );
        assert_eq!(document.sections[1].severity, Severity::Warning);
        assert!(
            !document.sections[0].caption.is_empty(),
            "the document explains its own arrangement"
        );
    }

    #[test]
    fn a_severity_no_rule_carries_draws_no_empty_heading() {
        let rules = [rule(1, "no-unwrap", Severity::Error)];
        let document = RuleDocument::build(rules.iter());
        assert_eq!(document.sections.len(), 1);
        assert!(document
            .sections
            .iter()
            .all(|s| s.severity != Severity::Review));
    }

    #[test]
    fn the_document_carries_the_row_the_page_dates_a_standard_by() {
        let mut held = rule(1, "no-unwrap", Severity::Error);
        held.audit = vec![AuditRow {
            node: Uuid::from_u128(1),
            at: "2026-08-25T00:00:00Z".to_owned(),
            from: Lifecycle::Draft,
            to: Lifecycle::Specified,
            actor: Actor::Human,
            actor_name: "m.ross".to_owned(),
            reason: "Written up.".to_owned(),
        }];
        let rules = [held];
        let document = RuleDocument::build(rules.iter());
        let row = &document.sections[0].rules[0];
        assert_eq!(row.command.as_deref(), Some("pnpm verify"));
        assert_eq!(
            row.last_change.as_ref().map(|a| a.actor_name.as_str()),
            Some("m.ross")
        );
    }
}
