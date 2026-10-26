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
//! Three of the seven rows still draw an app — Plane, Cloud agents and Cost keep
//! the iframe they always had, hosted the same way any other app surface is.
//! The other four have no app at all: Git is the shell's own source-control
//! and GitHub content, as two tabs (`rail/GitPage.tsx`), Hindsight shows whether
//! the memory service answers (`cloud::hindsight`), Agents lists the agent
//! tabs in this window's clusters and what each is doing (`rail/AgentsPage.tsx`),
//! and the Artifact registry is `disabled` — listed so the rail reads as the
//! finished set, opened by nothing. Cloud agents is `disabled` too, for the MVP;
//! see its row below.

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
/// `docs/design/VEISTRA-UX-SPEC.md` §1.8: the written spec allows 320-640, and
/// 380 (`--w-panel-default`) is the default within that range, not a fixed one.
pub const DEFAULT_WIDTH: f32 = 380.0;
pub const MIN_WIDTH: f32 = 240.0;
pub const MAX_WIDTH: f32 = 640.0;

/// The width a page opens to. Agents opens as narrow as the spec allows: it is a
/// list beside the work, not a screen of its own.
pub fn opening_width(page: &Page) -> f32 {
    if page.id == "sessions" {
        MIN_WIDTH
    } else {
        DEFAULT_WIDTH
    }
}

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
    /// (the source-control and GitHub tabs), Hindsight (its connection
    /// status; see `cloud::hindsight`), Agents (the agent tabs in this window)
    /// and the Artifact registry (disabled).
    /// Excluded from every list of things you can open as an ordinary
    /// surface — see [`is_page_app`].
    pub app_id: Option<&'static str>,
    /// A key the frontend maps to a glyph (`PAGE_ICONS` in `rail/Rail.tsx`).
    pub icon: &'static str,
    /// Where this page opens the first time a window shows it. See
    /// [`PageMode`] for why this is only the default.
    pub mode: PageMode,
    /// `Alt 1`...`Alt 7`, in rail order -- `docs/design/VEISTRA-UX-SPEC.md` §1.7,
    /// plus Agents before the registry.
    pub key: u8,
    /// Not openable. Drawn on the rail at reduced opacity, per
    /// `VEISTRA-UX-REWORK.md` §4's "(later)": the Artifact registry is not built
    /// yet, and Cloud agents is switched off for the MVP. `open_page` refuses
    /// both, and a restored layout that had one open comes back without it.
    pub disabled: bool,
}

/// Every page, in rail order. `VEISTRA-UX-REWORK.md` §4 and
/// `docs/design/VEISTRA-UX-SPEC.md` §1.7 are both this exact order and key set,
/// with Agents added before the registry.
pub const PAGES: &[Page] = &[
    Page {
        id: "git",
        name: "Git",
        app_id: None,
        icon: "git-branch",
        mode: PageMode::Docked,
        key: 1,
        // Kept off the rail (the rail shows Agents only, by the owner's call on
        // 2026-10-26; see `OFF_THE_RAIL` in `rail/Rail.tsx`), but still openable:
        // the status bar's branch, Review & merge and GitHub buttons open it.
        disabled: false,
    },
    Page {
        id: "plane",
        name: "Plane",
        app_id: Some("projects"),
        icon: "kanban",
        mode: PageMode::Expanded,
        key: 2,
        // Off by the owner's call on 2026-10-26: the rail shows Agents only,
        // for now, and a disabled page is not drawn at all. Turning it back on
        // is this one flag.
        disabled: true,
    },
    Page {
        id: "agents",
        name: "Cloud agents",
        app_id: Some("agents"),
        icon: "bot",
        mode: PageMode::Expanded,
        key: 3,
        // Off by the owner's call on 2026-10-14: the MVP is the local core, and
        // this page reads Google Cloud. The app stays registered, so turning it
        // back on is this one flag.
        disabled: true,
    },
    Page {
        id: "hindsight",
        name: "Hindsight",
        app_id: None,
        icon: "brain",
        mode: PageMode::Docked,
        key: 4,
        // Off by the owner's call on 2026-10-26: the rail shows Agents only,
        // for now, and a disabled page is not drawn at all. Turning it back on
        // is this one flag.
        disabled: true,
    },
    Page {
        id: "costs",
        name: "Cost",
        app_id: Some("costs"),
        icon: "receipt",
        mode: PageMode::Docked,
        key: 5,
        // Off by the owner's call on 2026-10-26: the rail shows Agents only,
        // for now, and a disabled page is not drawn at all. Turning it back on
        // is this one flag.
        disabled: true,
    },
    // Not "agents": that id is Cloud agents, and is written to `layout.json`.
    Page {
        id: "sessions",
        name: "Agents",
        app_id: None,
        icon: "sparkles",
        mode: PageMode::Docked,
        key: 6,
        disabled: false,
    },
    Page {
        id: "registry",
        name: "Artifact registry",
        app_id: None,
        icon: "package",
        mode: PageMode::Docked,
        key: 7,
        disabled: true,
    },
];

/// One page, as the rail needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub id: &'static str,
    pub name: &'static str,
    /// The app that draws this page, or `None` when the shell draws it. The
    /// frontend mounts a docked or expanded page's iframe from this rather than
    /// from a list of ids of its own.
    pub app_id: Option<&'static str>,
    pub icon: &'static str,
    pub mode: PageMode,
    pub key: u8,
    pub disabled: bool,
}

/// Every page, in rail order -- including the disabled one. Unlike the old
/// `pages::available`, this is not filtered by app registration: three rows
/// have no app to register in the first place, and the three that do
/// (`projects`, `agents`, `costs`) ship in every build. The rail draws every
/// row every time; [`Page::disabled`] is what greys one out.
pub fn rail() -> Vec<PageInfo> {
    PAGES
        .iter()
        .map(|p| PageInfo {
            id: p.id,
            name: p.name,
            app_id: p.app_id,
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
/// menu, the add-app button, presets and `veistra/open`: a page's app must never
/// be openable as an ordinary surface, since opening it that way would leave
/// a second copy of it loose in a pane instead of on the rail.
pub fn is_page_app(app_id: &str) -> bool {
    PAGES.iter().any(|p| p.app_id == Some(app_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seven_pages_in_the_written_rail_order() {
        let ids: Vec<&str> = PAGES.iter().map(|p| p.id).collect();
        assert_eq!(
            ids,
            [
                "git",
                "plane",
                "agents",
                "hindsight",
                "costs",
                "sessions",
                "registry"
            ]
        );
    }

    #[test]
    fn keys_are_alt_one_through_seven_in_order() {
        let keys: Vec<u8> = PAGES.iter().map(|p| p.key).collect();
        assert_eq!(keys, [1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn only_agents_and_git_are_enabled() {
        for page in PAGES {
            // Git stays openable for the status bar, which is its only door.
            let expected = !matches!(page.id, "sessions" | "git");
            assert_eq!(page.disabled, expected, "{}", page.id);
        }
    }

    #[test]
    fn three_pages_host_an_app_and_four_do_not() {
        let with_app = PAGES.iter().filter(|p| p.app_id.is_some()).count();
        assert_eq!(with_app, 3);
        assert!(PAGES.iter().any(|p| p.id == "git" && p.app_id.is_none()));
        assert!(PAGES
            .iter()
            .any(|p| p.id == "sessions" && p.app_id.is_none()));
        assert!(PAGES
            .iter()
            .any(|p| p.id == "hindsight" && p.app_id.is_none()));
        assert!(PAGES
            .iter()
            .any(|p| p.id == "registry" && p.app_id.is_none()));
    }

    #[test]
    fn rail_carries_each_pages_app_id_for_the_frontend() {
        let rail = rail();
        let app = |id: &str| rail.iter().find(|p| p.id == id).and_then(|p| p.app_id);
        assert_eq!(app("plane"), Some("projects"));
        assert_eq!(app("agents"), Some("agents"));
        assert_eq!(app("costs"), Some("costs"));
        assert_eq!(app("git"), None);
        assert_eq!(app("hindsight"), None);
        assert_eq!(app("sessions"), None);
    }

    #[test]
    fn plane_and_cloud_agents_default_to_expanded_the_rest_dock() {
        for page in PAGES {
            let expected = matches!(page.id, "plane" | "agents");
            assert_eq!(page.mode == PageMode::Expanded, expected, "{}", page.id);
        }
    }

    #[test]
    fn rail_lists_all_seven_including_the_disabled_one() {
        let ids: Vec<&str> = rail().into_iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), 7);
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
    fn agents_opens_at_the_narrowest_width_and_the_rest_at_the_default() {
        for page in PAGES {
            let expected = if page.id == "sessions" {
                MIN_WIDTH
            } else {
                DEFAULT_WIDTH
            };
            assert_eq!(opening_width(page), expected, "{}", page.id);
        }
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
