//! The app library, compiled in from `catalog.toml`.
//!
//! This module is only the reader. `docs/design-notes/app-library.md` is what
//! the list is for, why `default = true` is the field worth being careful
//! about, and why the catalog is compiled in rather than read off disk.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// The catalog as it was at compile time.
const SOURCE: &str = include_str!("../../../catalog.toml");

/// One app the library offers.
///
/// Serialized straight to the frontend, so the field names are the wire format
/// — `src/bindings.ts` mirrors this as `CatalogEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Must equal the `[tool] id` in the app's own manifest. Checked on install.
    pub id: String,
    pub name: String,
    pub description: String,
    /// `owner/name` on GitHub.
    pub repo: String,
    /// Installed on first run without being asked. See `catalog.toml`.
    #[serde(default)]
    pub default: bool,
    /// Changes the wording when a fetch fails, and nothing else. GitHub decides
    /// access; Veistra only decides whether to say "sign in" or "not found".
    #[serde(default)]
    pub private: bool,
}

/// The `[[app]]` array. Named `app` there because TOML reads better that way.
#[derive(Debug, Default, Deserialize)]
struct Document {
    #[serde(default)]
    app: Vec<Entry>,
}

/// Every entry, parsed once.
///
/// A malformed catalog yields an empty library rather than a panic. It cannot
/// realistically happen — `catalog_parses` below fails the build first — but
/// this is startup code, and a shell that will not open is a worse answer than
/// a library tab that is empty.
pub fn entries() -> &'static [Entry] {
    static PARSED: OnceLock<Vec<Entry>> = OnceLock::new();
    PARSED
        .get_or_init(|| match toml::from_str::<Document>(SOURCE) {
            Ok(doc) => doc.app,
            Err(e) => {
                eprintln!("veistra: catalog.toml did not parse, the library will be empty: {e}");
                Vec::new()
            }
        })
        .as_slice()
}

/// One library row: a catalog entry plus whether it is already on this machine.
///
/// `installed` is the only thing the library knows that the catalog does not,
/// and it is what turns an *Install* button into an *Installed* label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRow {
    #[serde(flatten)]
    pub entry: Entry,
    pub installed: bool,
}

/// The library, as the frontend renders it.
///
/// Takes a predicate rather than the registry so this stays a pure function
/// over the catalog — the caller in `commands.rs` is the half that knows about
/// Tauri state, and this half is the one worth testing.
pub fn rows(is_installed: impl Fn(&str) -> bool) -> Vec<CatalogRow> {
    rows_from(entries(), is_installed)
}

/// The half of `rows` that has no dependency on the compiled-in catalog.
///
/// Split out so a test can exercise the predicate wiring against synthetic
/// entries: the shipped `catalog.toml` is empty today (see its header), so a
/// test that only ever called `rows` would have nothing to assert `installed`
/// against.
fn rows_from(source: &[Entry], is_installed: impl Fn(&str) -> bool) -> Vec<CatalogRow> {
    source
        .iter()
        .map(|entry| CatalogRow {
            entry: entry.clone(),
            installed: is_installed(&entry.id),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The build's own copy of `catalog.toml` must parse. This is the check that
    /// makes the `eprintln!` fallback in `entries` unreachable in practice.
    ///
    /// It no longer also asserts the catalog is non-empty: Schematify's two
    /// predecessor applications were its only two entries, both are now
    /// folded into one in-repo app, and an empty `[[app]]` list is the
    /// deliberate, documented state described in `catalog.toml`'s own header
    /// — not a fixture that decayed.
    #[test]
    fn catalog_parses() {
        let _doc: Document = toml::from_str(SOURCE).expect("catalog.toml parses");
    }

    /// Two entries claiming one id would make "is it installed" ambiguous, and
    /// would render as two library rows that disagree with each other.
    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for entry in entries() {
            assert!(seen.insert(&entry.id), "duplicate catalog id: {}", entry.id);
        }
    }

    /// A `repo` that is not `owner/name` cannot be turned into an API URL, and
    /// the failure would arrive at install time on a user's machine rather than
    /// here.
    #[test]
    fn every_repo_is_owner_slash_name() {
        for entry in entries() {
            let parts: Vec<_> = entry.repo.split('/').collect();
            assert_eq!(parts.len(), 2, "{}: repo is not owner/name", entry.id);
            assert!(
                parts.iter().all(|part| !part.is_empty()),
                "{}: repo has an empty half",
                entry.id
            );
        }
    }

    /// An id has to survive being half of a `<package>.<surface>` address, so it
    /// may not contain the separator.
    #[test]
    fn ids_are_addressable() {
        for entry in entries() {
            assert!(
                !entry.id.contains(super::super::ADDRESS_SEPARATOR),
                "{}: an id may not contain `{}`",
                entry.id,
                super::super::ADDRESS_SEPARATOR
            );
        }
    }

    /// Built against synthetic entries rather than `entries()` — the shipped
    /// catalog is empty today (see `catalog.toml`'s header), and this is
    /// testing the predicate wiring in `rows_from`, not the catalog's content.
    #[test]
    fn a_row_reports_what_the_predicate_says() {
        fn entry(id: &str) -> Entry {
            Entry {
                id: id.to_string(),
                name: id.to_string(),
                description: String::new(),
                repo: "o/n".to_string(),
                default: false,
                private: false,
            }
        }

        let source = [entry("a"), entry("b")];
        let rows = rows_from(&source, |id| id == "a");
        let a = rows.iter().find(|row| row.entry.id == "a");
        assert!(a.is_some_and(|row| row.installed), "a reads installed");
        assert!(
            rows.iter()
                .filter(|row| row.entry.id != "a")
                .all(|row| !row.installed),
            "and nothing else does"
        );
    }

    /// The library must list everything, installed or not — an installed app
    /// stays visible with its button changed rather than disappearing.
    #[test]
    fn rows_cover_the_whole_catalog() {
        assert_eq!(rows(|_| true).len(), entries().len());
        assert_eq!(rows(|_| false).len(), entries().len());
    }

    #[test]
    fn an_entry_without_the_optional_flags_is_public_and_not_default() {
        let doc: Document = toml::from_str(
            r#"
            [[app]]
            id = "x"
            name = "X"
            description = "d"
            repo = "o/n"
            "#,
        )
        .expect("parses");
        assert!(!doc.app[0].default);
        assert!(!doc.app[0].private);
    }
}
