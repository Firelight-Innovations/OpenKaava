//! Finding things to reference by what they are called: files and folders,
//! canvases and frames, comments and context items.
//!
//! Names, not contents. An agent greps file contents with its own tools, and a
//! person typing after `@` types what they remember a thing is called. Every
//! hit is a reference that resolves under the same rules as any other, and a
//! path a reference would withhold as a secret is never listed.

use super::live::Actor;
use super::policy;
use super::resolve::first_line;
use super::uri::{CanvasPart, Ref};
use crate::apps::CallContext;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use tauri::AppHandle;

/// Hits returned when the caller names no limit, and the most it may ask for.
pub const DEFAULT_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 50;
/// Most entries the file walk visits before it stops looking.
const MAX_WALKED: usize = 20_000;

/// The kinds a search can be narrowed to.
pub const KINDS: &[&str] = &[
    "file",
    "folder",
    "canvas",
    "frame",
    "comment",
    "design-comment",
    "context",
    "selection",
];

/// One thing found: a reference and the words to show beside it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Hit {
    pub uri: String,
    pub kind: &'static str,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip)]
    score: u32,
}

/// What was asked: the words, the kinds and how many hits.
#[derive(Debug, Clone)]
pub struct Query {
    words: Vec<String>,
    kinds: Option<Vec<String>>,
    pub limit: usize,
}

impl Query {
    pub fn new(
        text: &str,
        kinds: Option<Vec<String>>,
        limit: Option<usize>,
    ) -> Result<Self, String> {
        if let Some(bad) = kinds
            .iter()
            .flatten()
            .find(|k| !KINDS.contains(&k.as_str()))
        {
            return Err(format!(
                "`{bad}` is not a kind; use one of {}",
                KINDS.join(", ")
            ));
        }
        Ok(Query {
            words: text.split_whitespace().map(str::to_lowercase).collect(),
            kinds,
            limit: limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
        })
    }

    fn wants(&self, kind: &str) -> bool {
        self.kinds
            .as_ref()
            .is_none_or(|k| k.iter().any(|w| w == kind))
    }

    /// How well a thing called `name`, found at `path`, matches; `None` when a
    /// word is in neither. An exact name beats a prefix, a prefix beats a
    /// match anywhere in the name, and that beats one only in the path. A
    /// shorter path wins a tie. With no words everything matches equally.
    fn score(&self, name: &str, path: &str) -> Option<u32> {
        let (name, path) = (name.to_lowercase(), path.to_lowercase());
        let found = |w: &String| name.contains(w.as_str()) || path.contains(w.as_str());
        if !self.words.iter().all(found) {
            return None;
        }
        let phrase = self.words.join(" ");
        let tier = if self.words.is_empty() {
            1
        } else if name == phrase {
            4
        } else if name.starts_with(&phrase) {
            3
        } else if self.words.iter().all(|w| name.contains(w.as_str())) {
            2
        } else {
            1
        };
        Some(tier * 1000 - path.chars().count().min(999) as u32)
    }
}

/// Everything that matches, best first, at most `q.limit`.
pub fn run(app: &AppHandle, ctx: &CallContext, actor: Actor, q: &Query) -> Vec<Hit> {
    let Some(root) = ctx.project.as_deref() else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    hits.extend(selection(q));
    hits.extend(context_items(root, q));
    hits.extend(viewer_comments(ctx, q));
    hits.extend(canvases(app, ctx, actor, q));
    hits.extend(design_comments(app, q));
    hits.extend(files(root, q));
    rank(hits, q.limit)
}

fn rank(mut hits: Vec<Hit>, limit: usize) -> Vec<Hit> {
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.cmp(&b.title)));
    hits.truncate(limit);
    hits
}

fn hit(r: &Ref, kind: &'static str, title: String, detail: Option<String>, score: u32) -> Hit {
    Hit {
        uri: r.to_string(),
        kind,
        title,
        detail,
        score,
    }
}

fn selection(q: &Query) -> Option<Hit> {
    let score = q
        .wants("selection")
        .then(|| q.score("selection", "selection"))
        .flatten()?;
    Some(hit(
        &Ref::Selection,
        "selection",
        "Selection".into(),
        Some("what is selected in this cluster's panes".into()),
        score,
    ))
}

/// Files and folders under `root`, by name. Gitignored entries, hidden ones,
/// links and secrets are not walked into or listed. An empty query lists
/// none: a project has too many files for a list of them to help.
fn files(root: &Path, q: &Query) -> Vec<Hit> {
    let (want_files, want_folders) = (q.wants("file"), q.wants("folder"));
    if q.words.is_empty() || !(want_files || want_folders) {
        return Vec::new();
    }
    let walk = ignore::WalkBuilder::new(root)
        .hidden(true)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .build();
    let mut hits = Vec::new();
    for entry in walk.flatten().skip(1).take(MAX_WALKED) {
        if entry.path_is_symlink() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        if (is_dir && !want_folders) || (!is_dir && !want_files) {
            continue;
        }
        if policy::secret_rule(&rel).is_some() || policy::check_relative(&rel).is_err() {
            continue;
        }
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        if let Some(score) = q.score(&name, &rel) {
            let r = Ref::File {
                path: rel.clone(),
                lines: None,
            };
            let kind = if is_dir { "folder" } else { "file" };
            hits.push(hit(&r, kind, name, Some(rel), score));
        }
    }
    hits
}

/// Items in the context store, by title. One copied from a secrets file is
/// left out, as the file itself would be.
fn context_items(root: &Path, q: &Query) -> Vec<Hit> {
    if !q.wants("context") {
        return Vec::new();
    }
    crate::context::list(root)
        .into_iter()
        .filter(|i| !i.missing)
        .filter(|i| policy::secret_rule(&i.rel_path).is_none())
        .filter(|i| policy::secret_rule(&i.title).is_none())
        .filter_map(|i| {
            let score = q.score(&i.title, &i.title)?;
            let from = i.source.label.clone().unwrap_or(i.source.app_id.clone());
            let r = Ref::Context { id: i.id };
            Some(hit(
                &r,
                "context",
                i.title,
                Some(format!("context · {from}")),
                score,
            ))
        })
        .collect()
}

/// Viewer comments, by what they say and where they are pinned.
fn viewer_comments(ctx: &CallContext, q: &Query) -> Vec<Hit> {
    if !q.wants("comment") {
        return Vec::new();
    }
    let Ok(all) = crate::comments::list(ctx) else {
        return Vec::new();
    };
    all.into_iter()
        .filter_map(|c| {
            let at = anchor_label(&c.anchor);
            let title = first_line(&c.body);
            let score = q.score(&title, &format!("{at} {}", c.body))?;
            let status = if c.status == crate::comments::Status::Open {
                "open"
            } else {
                "resolved"
            };
            let r = Ref::Comment { id: c.id };
            Some(hit(
                &r,
                "comment",
                title,
                Some(format!("{status} · {at}")),
                score,
            ))
        })
        .collect()
}

fn anchor_label(anchor: &crate::comments::Anchor) -> String {
    use crate::comments::Anchor;
    match anchor {
        Anchor::Node { path } => format!("node {path}"),
        Anchor::Mesh { part, material } => format!("mesh {part} ({material})"),
        Anchor::Scene { scene, time, .. } => format!("{scene} at {time:.1}s"),
    }
}

/// Canvases by title or id, and frames by what the Canvas app's own frame
/// search finds. Comments on canvases are the server's `list_comments`.
fn canvases(app: &AppHandle, ctx: &CallContext, actor: Actor, q: &Query) -> Vec<Hit> {
    let call = |method: &str, mut params: Value| {
        params["actor"] = json!(actor.name());
        crate::apps::call(app, ctx, "canvas", method, Some(params)).unwrap_or_default()
    };
    let mut hits = Vec::new();
    if q.wants("canvas") {
        hits.extend(canvas_hits(&call("canvas/frames", json!({})), q));
    }
    if q.wants("frame") && !q.words.is_empty() {
        let asked = json!({ "query": q.words.join(" "), "limit": q.limit });
        hits.extend(frame_hits(&call("canvas/search-frames", asked), q));
    }
    hits
}

/// Canvases from a `canvas/frames` answer's `canvases`.
fn canvas_hits(listed: &Value, q: &Query) -> Vec<Hit> {
    let rows = listed["canvases"].as_array().into_iter().flatten();
    rows.filter_map(|c| {
        let id = c["id"].as_str()?;
        let title = c["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(id);
        let score = q.score(title, id)?;
        let r = Ref::Canvas {
            id: id.into(),
            part: None,
        };
        Some(hit(
            &r,
            "canvas",
            title.into(),
            Some(format!("canvas {id}")),
            score,
        ))
    })
    .collect()
}

/// Frames from a `canvas/search-frames` answer's `matches`. One matched on a
/// property rather than its name ranks with the weakest name match.
fn frame_hits(found: &Value, q: &Query) -> Vec<Hit> {
    let rows = found["matches"].as_array().into_iter().flatten();
    rows.filter_map(|f| {
        let (canvas, id) = (f["canvas"].as_str()?, f["id"].as_str()?);
        let name = f["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(id);
        let score = q.score(name, name).unwrap_or(1000);
        let r = Ref::Canvas {
            id: canvas.into(),
            part: Some(CanvasPart::Frame(id.into())),
        };
        let what = f["typeName"].as_str().unwrap_or("frame");
        let detail = format!("{what} on canvas {canvas}");
        Some(hit(&r, "frame", name.into(), Some(detail), score))
    })
    .collect()
}

#[cfg(feature = "design-mode")]
fn design_comments(app: &AppHandle, q: &Query) -> Vec<Hit> {
    use tauri::Manager;
    if !q.wants("design-comment") {
        return Vec::new();
    }
    let all = app.state::<crate::design_comments::Comments>().all();
    all.into_iter()
        .filter_map(|c| {
            let title = first_line(&c.request);
            let score = q.score(&title, &format!("{} {}", c.page.title, c.request))?;
            let detail = format!("Design Mode · {}", c.page.title);
            let r = Ref::DesignComment { id: c.id };
            Some(hit(&r, "design-comment", title, Some(detail), score))
        })
        .collect()
}

#[cfg(not(feature = "design-mode"))]
fn design_comments(_app: &AppHandle, _q: &Query) -> Vec<Hit> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn q(text: &str) -> Query {
        Query::new(text, None, None).unwrap()
    }

    #[test]
    fn a_kind_outside_the_list_is_refused_and_the_limit_is_clamped() {
        let err = Query::new("x", Some(vec!["files".into()]), None).unwrap_err();
        assert!(err.contains("`files` is not a kind"), "{err}");
        assert_eq!(Query::new("x", None, Some(500)).unwrap().limit, MAX_LIMIT);
        assert_eq!(Query::new("x", None, Some(0)).unwrap().limit, 1);
        assert_eq!(q("x").limit, DEFAULT_LIMIT);
    }

    #[test]
    fn an_exact_name_beats_a_prefix_beats_a_part_beats_the_path() {
        let q = q("player");
        let exact = q.score("player", "a/player").unwrap();
        let prefix = q.score("player.gd", "a/player.gd").unwrap();
        let inside = q.score("the_player.gd", "a/the_player.gd").unwrap();
        let path = q.score("main.gd", "player/main.gd").unwrap();
        assert!(exact > prefix && prefix > inside && inside > path);
        assert_eq!(q.score("main.gd", "src/main.gd"), None);
    }

    #[test]
    fn every_word_has_to_match_somewhere() {
        let q = q("Hero SHEET");
        assert!(q.score("hero_sheet.png", "art/hero_sheet.png").is_some());
        assert!(q.score("sheet.png", "hero/sheet.png").is_some());
        assert_eq!(q.score("hero.png", "art/hero.png"), None);
    }

    #[test]
    fn hits_rank_best_first_up_to_the_limit() {
        let mk = |t: &str, s| hit(&Ref::Selection, "file", t.into(), None, s);
        let out = rank(vec![mk("b", 1), mk("c", 3), mk("a", 3)], 2);
        let titles: Vec<_> = out.iter().map(|h| h.title.as_str()).collect();
        assert_eq!(titles, ["a", "c"]);
    }

    #[test]
    fn files_are_found_by_name_but_never_secrets_ignored_or_hidden_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("scripts/config")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        for f in [
            "scripts/config/config.gd",
            "build/config.gd",
            "config.env",
            "config.pem",
            ".config",
        ] {
            fs::write(root.join(f), "x").unwrap();
        }
        fs::write(root.join(".gitignore"), "build/\n").unwrap();

        let uris: Vec<String> = files(root, &q("config"))
            .into_iter()
            .map(|h| h.uri)
            .collect();
        assert!(uris.contains(&"kaava://file/scripts/config/config.gd".to_string()));
        assert!(uris.contains(&"kaava://file/scripts/config".to_string()));
        for absent in ["build/config.gd", "config.env", "config.pem", ".config"] {
            assert!(
                !uris.iter().any(|u| u.ends_with(absent)),
                "{absent}: {uris:?}"
            );
        }
        assert!(files(root, &q("")).is_empty());
        let only = Query::new("config", Some(vec!["folder".into()]), None).unwrap();
        let kinds: Vec<_> = files(root, &only).into_iter().map(|h| h.kind).collect();
        assert_eq!(kinds, ["folder"]);
    }

    #[test]
    fn canvases_and_frames_come_from_the_canvas_apps_answers() {
        let listed = json!({ "canvases": [
            { "id": "levels/hospital", "title": "Hospital" },
            { "id": "world", "title": "" },
        ]});
        let hits = canvas_hits(&listed, &q("hosp"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].uri, "kaava://canvas/levels/hospital");
        assert_eq!(canvas_hits(&listed, &q("world"))[0].title, "world");

        let found = json!({ "matches": [
            { "canvas": "world", "id": "f_1", "name": "Main Menu", "typeName": "Screen" },
            { "canvas": "world", "id": "f_2", "name": null },
        ]});
        let hits = frame_hits(&found, &q("menu"));
        assert_eq!(hits[0].uri, "kaava://canvas/world#frame=f_1");
        assert_eq!(hits[0].detail.as_deref(), Some("Screen on canvas world"));
        assert_eq!(hits[1].title, "f_2");
        assert_eq!(hits[1].score, 1000);
    }

    #[test]
    fn the_selection_is_one_hit_when_its_name_is_asked_for() {
        assert_eq!(selection(&q("sel")).unwrap().uri, "kaava://selection");
        assert!(selection(&q("door")).is_none());
        let other = Query::new("sel", Some(vec!["file".into()]), None).unwrap();
        assert!(selection(&other).is_none());
    }
}
