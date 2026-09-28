//! Pages — the project-wide screens on the right-side rail.
//!
//! A page used to be a cluster kind: one dedicated cluster per page per window,
//! holding one pane with one instance that could never be closed, renamed or
//! dropped into. It no longer is. A page is now a fact about a **window** —
//! [`crate::shell_state::WindowPlacement::right_page`] — shown docked beside
//! the panes or expanded over them, with the panes underneath never unmounting.
//! `shell_state`'s `migrate_legacy_page_clusters` converts a `layout.json`
//! written by the old build on its way in; this module only says which pages
//! exist, in what order, and how each opens.
//!
//! Three of the six rows still draw an app — Plane, Cloud agents and Cost keep
//! the iframe they always had, hosted the same way any other app surface is.
//! The other three have no app at all: Git is the shell's own source-control
//! and GitHub content (`panel/SecondaryPanel.tsx`), Hindsight has nothing to
//! connect to yet and draws an honest placeholder, and the Artifact registry
//! is `disabled` — listed so the rail reads as the finished set of six, opened
//! by nothing.

use serde::Serialize;

/// Where a page renders. The rail's own [`Page::mode`] is only the *default* —
/// `Ctrl Shift E` and the docked header's expand control move a page between
/// the two, and `RightPage::mode` is what actually decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageMode {
    Docked,
    Expanded,
}

/// The docked width a page opens to before anyone has dragged its handle.
/// `docs/design/KAAVA-UX-SPEC.md` §1.8: the written spec allows 320-640, and
/// 380 (`--w-panel-default`) is the default within that range, not a fixed one.
pub const DEFAULT_WIDTH: f32 = 380.0;
pub const MIN_WIDTH: f32 = 320.0;
pub const MAX_WIDTH: f32 = 640.0;

/// Clamp a requested docked width to the range the spec allows.
pub fn clamp_width(width: f32) -> f32 {
    width.clamp(MIN_WIDTH, MAX_WIDTH)
}

/// One page, as declared.
pub struct Page {
    /// The page's id, and what `RightPage::id` records. Stable: it is written
    /// to `layout.json`, so renaming one strands every saved `rightPage`.
    pub id: &'static str,
    /// The rail button's `aria-label`/tooltip, and the expanded header's title.
    pub name: &'static str,
    /// Which app draws it, or `None` for a page the shell draws itself — Git
    /// (today's source-control/GitHub panel), Hindsight (a placeholder; there
    /// is nothing to connect to yet) and the Artifact registry (disabled).
    /// Excluded from every list of things you can open as an ordinary
    /// surface — see [`is_page_app`].
    pub app_id: Option<&'static str>,
    /// A key the frontend maps to a glyph (`PAGE_ICONS` in `rail/Rail.tsx`).
    pub icon: &'static str,
    /// Where this page opens the first time a window shows it. See
    /// [`PageMode`] for why this is only the default.
    pub mode: PageMode,
    /// `Alt 1`...`Alt 6`, in rail order -- `docs/design/KAAVA-UX-SPEC.md` §1.7.
    pub key: u8,
    /// Not openable yet. Drawn on the rail at reduced opacity, per
    /// `KAAVA-UX-REWORK.md` §4's "(later)": the Artifact registry is the one
    /// row today, listed so the six-button set reads as finished rather than
    /// missing a button.
    pub disabled: bool,
}

/// Every page, in rail order. `KAAVA-UX-REWORK.md` §4 and
/// `docs/design/KAAVA-UX-SPEC.md` §1.7 are both this exact order and key set.
pub const PAGES: &[Page] = &[
    Page {
        id: "git",
        name: "Git",
        app_id: None,
        icon: "git-branch",
        mode: PageMode::Docked,
        key: 1,
        disabled: false,
    },
    Page {
        id: "plane",
        name: "Plane",
        app_id: Some("projects"),
        icon: "kanban",
        mode: PageMode::Expanded,
        key: 2,
        disabled: false,
    },
    Page {
        id: "agents",
        name: "Cloud agents",
        app_id: Some("agents"),
        icon: "bot",
        mode: PageMode::Expanded,
        key: 3,
        disabled: false,
    },
    Page {
        id: "hindsight",
        name: "Hindsight",
        app_id: None,
        icon: "brain",
        mode: PageMode::Docked,
        key: 4,
        disabled: false,
    },
    Page {
        id: "costs",
        name: "Cost",
        app_id: Some("costs"),
        icon: "receipt",
        mode: PageMode::Docked,
        key: 5,
        disabled: false,
    },
    Page {
        id: "registry",
        name: "Artifact registry",
        app_id: None,
        icon: "package",
        mode: PageMode::Docked,
        key: 6,
        disabled: true,
    },
];

/// One page, as the rail needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub icon: &'static str,
    pub mode: PageMode,
    pub key: u8,
    pub disabled: bool,
}

/// Every page, in rail order -- including the disabled one. Unlike the old
/// `pages::available`, this is not filtered by app registration: three rows
/// have no app to register in the first place, and the three that do
/// (`projects`, `agents`, `costs`) ship in every build. The rail draws all
/// six every time; [`Page::disabled`] is what greys one out.
pub fn rail() -> Vec<PageInfo> {
    PAGES
        .iter()
        .map(|p| PageInfo {
            id: p.id,
            name: p.name,
            icon: p.icon,
            mode: p.mode,
            key: p.key,
            disabled: p.disabled,
        })
        .collect()
}

/// A page by id, whether or not it can be opened. `open_page` is what checks
/// `disabled`; this is the plain lookup everything else -- including a
/// disabled row's own entry -- needs.
pub fn find(id: &str) -> Option<&'static Page> {
    PAGES.iter().find(|p| p.id == id)
}

/// Whether an app id draws a page. What keeps a page's app out of the Apps
/// menu, the add-app button, presets and `kaava/open`: a page's app must never
/// be openable as an ordinary surface, since opening it that way would leave
/// a second copy of it loose in a pane instead of on the rail.
pub fn is_page_app(app_id: &str) -> bool {
    PAGES.iter().any(|p| p.app_id == Some(app_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_pages_in_the_written_rail_order() {
        let ids: Vec<&str> = PAGES.iter().map(|p| p.id).collect();
        assert_eq!(
            ids,
            ["git", "plane", "agents", "hindsight", "costs", "registry"]
        );
    }

    #[test]
    fn keys_are_alt_one_through_six_in_order() {
        let keys: Vec<u8> = PAGES.iter().map(|p| p.key).collect();
        assert_eq!(keys, [1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn only_the_registry_is_disabled() {
        for page in PAGES {
            assert_eq!(page.disabled, page.id == "registry", "{}", page.id);
        }
    }

    #[test]
    fn three_pages_host_an_app_and_three_do_not() {
        let with_app = PAGES.iter().filter(|p| p.app_id.is_some()).count();
        assert_eq!(with_app, 3);
        assert!(PAGES.iter().any(|p| p.id == "git" && p.app_id.is_none()));
        assert!(PAGES
            .iter()
            .any(|p| p.id == "hindsight" && p.app_id.is_none()));
        assert!(PAGES
            .iter()
            .any(|p| p.id == "registry" && p.app_id.is_none()));
    }

    #[test]
    fn plane_and_cloud_agents_default_to_expanded_the_rest_dock() {
        for page in PAGES {
            let expected = matches!(page.id, "plane" | "agents");
            assert_eq!(page.mode == PageMode::Expanded, expected, "{}", page.id);
        }
    }

    #[test]
    fn rail_lists_all_six_including_the_disabled_one() {
        let ids: Vec<&str> = rail().into_iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), 6);
        assert!(ids.contains(&"registry"));
    }

    #[test]
    fn find_answers_for_every_row_disabled_or_not() {
        assert!(find("git").is_some());
        assert!(find("registry").is_some());
        assert!(find("nonesuch").is_none());
    }

    #[test]
    fn is_page_app_covers_the_three_app_hosting_pages_and_nothing_else() {
        assert!(is_page_app("projects"));
        assert!(is_page_app("agents"));
        assert!(is_page_app("costs"));
        assert!(!is_page_app("files"));
        assert!(!is_page_app("git"));
    }

    #[test]
    fn width_clamps_to_the_written_range() {
        assert_eq!(clamp_width(100.0), MIN_WIDTH);
        assert_eq!(clamp_width(1000.0), MAX_WIDTH);
        assert_eq!(clamp_width(400.0), 400.0);
    }

    #[test]
    fn page_ids_are_unique() {
        for (i, a) in PAGES.iter().enumerate() {
            assert!(PAGES[i + 1..].iter().all(|b| b.id != a.id));
        }
    }
}
