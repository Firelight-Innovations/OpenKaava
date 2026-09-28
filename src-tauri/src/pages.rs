//! Pages — the OpenKaava Cloud screens that sit at the left of the cluster bar.
//!
//! A page is a **cluster kind**, not an app a person adds to a pane. Its content
//! is still an app — an iframe, `@openkaava/bridge`, and an `apps::<id>::call`
//! — because that is how anything in the window reaches the backend. What makes
//! it a page is where it lives: one dedicated cluster per page per window,
//! holding one pane with one instance, which is never closed, renamed, split,
//! moved or dropped into. `shell_state` enforces that; this module only says
//! which pages exist and which app draws each one.
//!
//! **This table is the one place a page is declared.** Adding one is a row here
//! plus its app's usual three edits (STANDARDS.md §3). A row whose app is not
//! registered in this build is not offered — see [`available`] — so a page can
//! be listed here before its app lands, and appears the moment it does.

use crate::apps;
use serde::Serialize;

/// One page, as declared.
pub struct Page {
    /// The page's id, and what `Cluster::page` records. Stable: it is written to
    /// `layout.json`, so renaming one strands every saved page cluster.
    pub id: &'static str,
    /// The chip's label when it is expanded, and its `aria-label` when not.
    pub name: &'static str,
    /// Which app draws it. Excluded from every list of things you can open —
    /// see [`is_page_app`].
    pub app_id: &'static str,
    /// A key the frontend maps to a glyph (`PAGE_ICONS` in `PageChips.tsx`).
    /// A key rather than markup, so the icon set stays the frontend's.
    pub icon: &'static str,
}

/// Every page, in chip order. See the module doc for how to add one.
pub const PAGES: &[Page] = &[
    Page {
        id: "agents",
        name: "Agents",
        app_id: "agents",
        icon: "robot",
    },
    // GCP billing today; every AI development cost later.
    Page {
        id: "costs",
        name: "Cost Tracker",
        app_id: "costs",
        icon: "receipt",
    },
    Page {
        id: "projects",
        name: "Projects",
        app_id: "projects",
        icon: "kanban",
    },
];

/// One page, as the cluster bar needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub icon: &'static str,
}

/// The pages this build can draw, in chip order.
pub fn available() -> Vec<PageInfo> {
    PAGES
        .iter()
        .filter(|p| apps::is_app(p.app_id))
        .map(|p| PageInfo {
            id: p.id,
            name: p.name,
            icon: p.icon,
        })
        .collect()
}

/// A page this build can draw, by id. `None` for an unknown id *and* for a page
/// whose app is not registered, which are the same answer to "can I open it".
pub fn find(id: &str) -> Option<&'static Page> {
    PAGES.iter().find(|p| p.id == id && apps::is_app(p.app_id))
}

/// Whether an app id draws a page, registered or not.
///
/// What keeps a page's app out of the Apps menu, the add-app button, presets and
/// `kaava/open`. Unfiltered by registration on purpose: a page's app must never
/// be openable as an ordinary surface, whichever build it is in.
pub fn is_page_app(app_id: &str) -> bool {
    PAGES.iter().any(|p| p.app_id == app_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_is_offered_because_its_app_is_registered() {
        assert!(available().iter().any(|p| p.id == "agents"));
        assert!(find("agents").is_some());
    }

    #[test]
    fn the_cost_tracker_is_offered_as_a_page_and_not_as_an_app() {
        assert!(available().iter().any(|p| p.id == "costs"));
        assert!(find("costs").is_some());
        assert!(is_page_app("costs"));
    }

    #[test]
    fn a_page_whose_app_is_not_registered_is_not_offered() {
        let unregistered = PAGES.iter().find(|p| !apps::is_app(p.app_id));
        if let Some(page) = unregistered {
            assert!(!available().iter().any(|p| p.id == page.id));
            assert!(find(page.id).is_none());
        }
    }

    #[test]
    fn every_page_app_is_a_page_app_registered_or_not() {
        for page in PAGES {
            assert!(is_page_app(page.app_id));
        }
        assert!(!is_page_app("files"));
    }

    #[test]
    fn page_ids_are_unique() {
        for (i, a) in PAGES.iter().enumerate() {
            assert!(PAGES[i + 1..].iter().all(|b| b.id != a.id));
        }
    }
}
