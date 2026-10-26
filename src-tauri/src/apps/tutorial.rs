//! The Tutorials app's Rust half — which tutorials exist, and how far through
//! them somebody is.
//!
//! Two things live here and the split between them is the design.
//! `docs/tutorials.md` is the whole account; this is the short version.
//!
//! **What tutorials exist** is `&'static` data below, in Rust because Home draws
//! the same list — a second copy over there would be a second place to add a
//! tutorial and a first place to forget to. Home asks [`catalog`] directly; the
//! app asks for it over `tutorial/catalog`.
//!
//! **What has been finished** is a small file beside `settings.json` in the OS
//! config directory. It is the one thing here that survives a restart.
//!
//! The prose is deliberately *not* here — it is TypeScript in
//! `apps/tutorial/ui/src/content/`, for the reasons in §2 of that doc. The seam
//! that costs is an id in one half with no body in the other, which the app
//! renders as an honest "not written yet" card rather than failing.

use crate::apps::CallContext;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// A group of tutorials, drawn as one heading in the app's sidebar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// Ascending. Spaced by tens so a section can be dropped between two
    /// existing ones without renumbering the rest — the same convention
    /// `settings::Group` uses.
    pub order: i32,
}

/// One tutorial, as a card. Everything needed to *list* it and nothing needed
/// to *read* it: the body lives in the frontend, keyed by this id.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tutorial {
    pub id: &'static str,
    pub section: &'static str,
    pub title: &'static str,
    /// One sentence, in the second person, saying what you will be able to do
    /// afterwards. Shown on the card and nowhere else.
    pub blurb: &'static str,
    /// How long it takes, honestly, for somebody who has not seen Veistra before.
    /// A number rather than a band, because "5 min" reads as a measurement and
    /// "short" reads as a guess.
    pub minutes: u32,
    /// Tutorials worth doing first, in this order. A reader is free to ignore
    /// it — nothing is locked — but a list of ten with no suggested path is a
    /// list nobody starts.
    pub after: Option<&'static str>,
}

static SECTIONS: &[Section] = &[
    Section {
        id: "start",
        title: "Getting started",
        description: "The window, and getting a project open in it.",
        order: 0,
    },
    Section {
        id: "shell",
        title: "Working in the shell",
        description: "Panes, terminals, search — the parts of Veistra that are not an app.",
        order: 10,
    },
    Section {
        id: "project",
        title: "Projects and files",
        description: "What a project is on disk, and the two apps that work on one.",
        order: 20,
    },
    Section {
        id: "agents",
        title: "Agents",
        description: "Pointing a coding agent at Veistra, and what it can reach.",
        order: 30,
    },
    Section {
        id: "stack",
        title: "The stack",
        description: "What the stack's repositories are each for.",
        order: 40,
    },
];

static TUTORIALS: &[Tutorial] = &[
    Tutorial {
        id: "the-window",
        section: "start",
        title: "The Veistra window",
        blurb: "Name every part of the frame, so the rest of these make sense.",
        minutes: 4,
        after: None,
    },
    Tutorial {
        id: "first-project",
        section: "start",
        title: "Your first project",
        blurb: "Open a folder, set it up as a Veistra project, and know what got written.",
        minutes: 6,
        after: Some("the-window"),
    },
    Tutorial {
        id: "panes-and-clusters",
        section: "shell",
        title: "Panes, tabs and clusters",
        blurb: "Split the window, move a tab, and work on two projects at once.",
        minutes: 8,
        after: Some("first-project"),
    },
    Tutorial {
        id: "terminals",
        section: "shell",
        title: "Terminals",
        blurb: "Open a shell that already knows which project you are in.",
        minutes: 5,
        after: Some("panes-and-clusters"),
    },
    Tutorial {
        id: "search",
        section: "shell",
        title: "Finding things",
        blurb: "Jump to a file by name, and search the project's text.",
        minutes: 5,
        after: Some("terminals"),
    },
    Tutorial {
        id: "settings",
        section: "shell",
        title: "Settings",
        blurb: "Change how Veistra looks and behaves, and know when a change takes effect.",
        minutes: 5,
        after: Some("search"),
    },
    Tutorial {
        id: "files-and-editing",
        section: "project",
        title: "Browsing and editing",
        blurb: "Move around a project in the Explorer and edit it in the Viewer.",
        minutes: 8,
        after: Some("first-project"),
    },
    Tutorial {
        id: "git-and-worktrees",
        section: "project",
        title: "Git, and a worktree per branch",
        blurb: "Read what changed, and give a branch a folder of its own.",
        minutes: 7,
        after: Some("files-and-editing"),
    },
    Tutorial {
        id: "mcp-servers",
        section: "agents",
        title: "Give your agent Veistra's tools",
        blurb: "Let Claude Code or another MCP client drive the parts of Veistra you drive.",
        minutes: 7,
        after: None,
    },
    Tutorial {
        id: "the-stack",
        section: "stack",
        title: "The stack, end to end",
        blurb: "How the switcher bar's health badge reads a pinned stack of tools.",
        minutes: 6,
        after: None,
    },
];

/// How many cards Home draws. The first unfinished tutorials in reading order,
/// so the column is a "next thing to do" rather than a table of contents —
/// three because that is what fits beside the Recent list without scrolling.
pub const FEATURED: usize = 3;

/// Every section and tutorial this build ships, plus what has been finished.
///
/// The one place both consumers read from. `completed` is filtered against the
/// catalog on the way out, so an id left behind by a build that dropped a
/// tutorial cannot make Home count to eleven out of ten.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub sections: &'static [Section],
    pub tutorials: &'static [Tutorial],
    pub completed: Vec<String>,
    /// The next few worth doing, already resolved. Home draws exactly this and
    /// makes no decision of its own about ordering.
    pub featured: Vec<&'static str>,
}

pub fn catalog(app: &AppHandle) -> Catalog {
    let done = load(app).completed;
    let completed: Vec<String> = TUTORIALS
        .iter()
        .filter(|t| done.contains(t.id))
        .map(|t| t.id.to_string())
        .collect();

    // Unfinished first; if everything is done, fall back to the opening few so
    // the column never empties out into nothing.
    let mut featured: Vec<&'static str> = TUTORIALS
        .iter()
        .filter(|t| !done.contains(t.id))
        .map(|t| t.id)
        .take(FEATURED)
        .collect();
    if featured.is_empty() {
        featured = TUTORIALS.iter().map(|t| t.id).take(FEATURED).collect();
    }

    Catalog {
        sections: SECTIONS,
        tutorials: TUTORIALS,
        completed,
        featured,
    }
}

pub fn call(
    app: &AppHandle,
    _context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    match method {
        "tutorial/catalog" => encode(&catalog(app)),
        "tutorial/complete" => {
            let (id, done) = completion(params.as_ref())?;
            set_done(app, &id, done);
            encode(&catalog(app))
        }
        "tutorial/reset" => {
            save(app, &Progress::default());
            encode(&catalog(app))
        }
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

fn encode(catalog: &Catalog) -> Result<Value, RpcError> {
    serde_json::to_value(catalog)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not read the tutorials: {e}")))
}

/// `{ id, done }`, with `done` defaulting to `true` so the common call is short.
fn completion(params: Option<&Value>) -> Result<(String, bool), RpcError> {
    let id = params
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "tutorial/complete needs an id"))?;

    if !TUTORIALS.iter().any(|t| t.id == id) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("no such tutorial: {id}"),
        ));
    }

    let done = params
        .and_then(|p| p.get("done"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    Ok((id.to_string(), done))
}

fn set_done(app: &AppHandle, id: &str, done: bool) {
    let mut progress = load(app);
    let changed = if done {
        progress.completed.insert(id.to_string())
    } else {
        progress.completed.remove(id)
    };
    if changed {
        save(app, &progress);
    }
}

// --- what survives a restart ------------------------------------------------

const FILE: &str = "tutorials.json";

/// Reconstructible. Losing this offers a tutorial somebody has already read,
/// which is a small annoyance and not a loss — and the alternative, a directory
/// of set-aside copies of a set of ids, is worth less than the annoyance.
const KEEP: crate::userdata::store::Keep = crate::userdata::store::Keep::Nothing;

/// What is on disk. A set of ids and nothing else — no timestamps, no
/// position within a tutorial. Resuming mid-tutorial would need the frontend to
/// have a notion of "where you are" that it does not have, and a stored scroll
/// offset that went stale the moment the prose was edited would be worse than
/// starting the page again.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Progress {
    pub completed: BTreeSet<String>,
}

/// Read the store, or start empty. Never fails — the same four rules
/// `settings::store` follows, and for the same reason: nothing here is worth
/// refusing to draw a tutorial over.
fn load(app: &AppHandle) -> Progress {
    file(app)
        .map(|path| crate::userdata::store::read(&path, KEEP))
        .unwrap_or_default()
}

/// Temp-and-rename, as everything else that writes here does — through
/// `userdata::store`, which is where that lives now. A half-written progress
/// file is a smaller loss than a half-written project list, but the failure is
/// identical and so is the fix.
fn save(app: &AppHandle, progress: &Progress) {
    if let Some(path) = file(app) {
        crate::userdata::store::write(&path, progress, "the tutorial progress");
    }
}

/// Beside `projects.json` and `settings.json`, never inside a project. Having
/// read a tutorial is a fact about the person, not about the folder they had
/// open when they read it.
fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

/// The shape Home draws its column from, without Home having to know what a
/// `Catalog` is. Kept beside the catalog so the two move together.
pub fn summary(app: &AppHandle) -> Value {
    let catalog = catalog(app);
    let cards: Vec<Value> = catalog
        .featured
        .iter()
        .filter_map(|id| TUTORIALS.iter().find(|t| t.id == *id))
        .map(|t| {
            json!({
                "id": t.id,
                "title": t.title,
                "blurb": t.blurb,
                "minutes": t.minutes,
                "done": catalog.completed.iter().any(|c| c == t.id),
            })
        })
        .collect();

    json!({
        "cards": cards,
        "completed": catalog.completed.len(),
        "total": TUTORIALS.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tutorial_id_is_unique_and_url_safe() {
        let mut seen = BTreeSet::new();
        for tutorial in TUTORIALS {
            assert!(
                seen.insert(tutorial.id),
                "two tutorials share the id {}",
                tutorial.id
            );
            assert!(
                tutorial
                    .id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{} is not a usable id — it is a key in tutorials.json and a route in the app",
                tutorial.id
            );
        }
    }

    #[test]
    fn every_tutorial_lands_in_a_section_that_exists() {
        for tutorial in TUTORIALS {
            assert!(
                SECTIONS.iter().any(|s| s.id == tutorial.section),
                "{} is in section {:?}, which is not declared",
                tutorial.id,
                tutorial.section
            );
        }
    }

    /// A section with nothing in it draws an empty heading, which reads as a
    /// tutorial that failed to load rather than as a section nobody has written
    /// yet.
    #[test]
    fn every_section_holds_at_least_one_tutorial() {
        for section in SECTIONS {
            assert!(
                TUTORIALS.iter().any(|t| t.section == section.id),
                "section {} is empty",
                section.id
            );
        }
    }

    #[test]
    fn every_after_names_a_tutorial_that_exists_and_is_not_itself() {
        for tutorial in TUTORIALS {
            let Some(after) = tutorial.after else {
                continue;
            };
            assert_ne!(after, tutorial.id, "{} comes after itself", tutorial.id);
            assert!(
                TUTORIALS.iter().any(|t| t.id == after),
                "{} comes after {after:?}, which does not exist",
                tutorial.id
            );
        }
    }

    /// The blurb is drawn under the title, so one that repeats it wastes the
    /// only line the card has to say something new.
    #[test]
    fn no_blurb_repeats_its_own_title() {
        for tutorial in TUTORIALS {
            assert_ne!(
                tutorial.blurb.to_lowercase(),
                tutorial.title.to_lowercase(),
                "{}'s blurb says nothing its title did not",
                tutorial.id
            );
            assert!(
                tutorial.minutes > 0,
                "{} claims to take no time at all",
                tutorial.id
            );
        }
    }

    /// `sections` is ordered by the frontend, but only if the numbers are
    /// distinct — two sections sharing an order sort by whatever the sort
    /// happens to do, which is stable but not meaningful.
    #[test]
    fn every_section_order_is_distinct() {
        let orders: BTreeSet<i32> = SECTIONS.iter().map(|s| s.order).collect();
        assert_eq!(orders.len(), SECTIONS.len(), "two sections share an order");
    }

    #[test]
    fn progress_survives_a_round_trip_and_ignores_what_it_does_not_know() {
        let progress = Progress {
            completed: BTreeSet::from(["the-window".to_string(), "terminals".to_string()]),
        };

        let json = serde_json::to_string_pretty(&progress).expect("serializes");
        let back: Progress = serde_json::from_str(&json).expect("and reads back");
        assert_eq!(back.completed, progress.completed);

        let newer: Progress = serde_json::from_str(r#"{"completed":[],"lastReadAt":12}"#)
            .expect("an unknown field must not fail the read");
        assert!(newer.completed.is_empty());

        let empty: Progress = serde_json::from_str("{}").expect("`{}` is nobody having started");
        assert!(empty.completed.is_empty());
    }
}
