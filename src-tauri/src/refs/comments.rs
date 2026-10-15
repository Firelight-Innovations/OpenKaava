//! Every comment the person has left, wherever it was left, as references:
//! viewer comments on disk, canvas comments through the Canvas app, and
//! Design Mode comments in app state. Each row carries a `kaava://` reference,
//! so reading or showing one goes through the resolver like anything else.

use super::live::{self, Actor};
use super::resolve::first_line;
use super::search::anchor_label;
use super::uri::{CanvasPart, Ref};
use crate::apps::CallContext;
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::AppHandle;

/// Most rows one listing returns; `total` says how many there were.
pub const MAX_LISTED: usize = 100;

/// Where comments are left.
pub const SOURCES: &[&str] = &["viewer", "canvas", "design"];

/// Which comments a listing wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wanted {
    Open,
    Resolved,
    All,
}

impl Wanted {
    pub fn parse(word: Option<&str>) -> Result<Self, String> {
        match word.unwrap_or("open") {
            "open" => Ok(Wanted::Open),
            "resolved" => Ok(Wanted::Resolved),
            "all" => Ok(Wanted::All),
            other => Err(format!(
                "`{other}` is not a status; use open, resolved or all"
            )),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Wanted::Open => "open",
            Wanted::Resolved => "resolved",
            Wanted::All => "all",
        }
    }

    /// Whether a comment that is still open (`active`) is wanted.
    fn takes(self, active: bool) -> bool {
        match self {
            Wanted::Open => active,
            Wanted::Resolved => !active,
            Wanted::All => true,
        }
    }
}

fn row(r: &Ref, source: &str, status: Value, text: &str, at: String) -> Value {
    json!({
        "uri": r.to_string(),
        "source": source,
        "status": status,
        "text": first_line(text),
        "where": at,
    })
}

/// Comments from `sources` (all of them when `None`), open ones unless asked.
pub fn list(
    app: &AppHandle,
    ctx: &CallContext,
    wanted: Wanted,
    sources: Option<&[String]>,
) -> Value {
    let from = |s: &str| sources.is_none_or(|list| list.iter().any(|w| w == s));
    let mut rows = Vec::new();
    let mut problems = Vec::new();
    if from("viewer") {
        match crate::comments::list(ctx) {
            Ok(all) => rows.extend(viewer_rows(all, wanted)),
            Err(e) => problems.push(format!("viewer comments: {}", e.message)),
        }
    }
    if from("canvas") {
        rows.extend(canvas_rows(app, ctx, wanted, &mut problems));
    }
    if from("design") {
        rows.extend(design_rows(app, wanted));
    }
    listing(rows, problems)
}

fn listing(mut rows: Vec<Value>, problems: Vec<String>) -> Value {
    let total = rows.len();
    rows.truncate(MAX_LISTED);
    let mut out = json!({
        "comments": rows,
        "total": total,
        "covers": "Comments the person left in this project's viewers and canvases, and in \
                   Design Mode on this machine. An empty list means none are outstanding, \
                   not that the work is fine.",
    });
    if !problems.is_empty() {
        out["problems"] = json!(problems);
    }
    out
}

fn viewer_rows(all: Vec<crate::comments::Comment>, wanted: Wanted) -> Vec<Value> {
    use crate::comments::Status;
    all.into_iter()
        .filter(|c| wanted.takes(c.status == Status::Open))
        .map(|c| {
            let r = Ref::Comment { id: c.id.clone() };
            row(
                &r,
                "viewer",
                json!(c.status),
                &c.body,
                anchor_label(&c.anchor),
            )
        })
        .collect()
}

/// Every canvas's comments. A canvas lists the comments on its split frames'
/// children too, so a child that is also listed on its own is not counted twice.
fn canvas_rows(
    app: &AppHandle,
    ctx: &CallContext,
    wanted: Wanted,
    problems: &mut Vec<String>,
) -> Vec<Value> {
    let listed = match live::canvas_call(app, ctx, Actor::Agent, "canvas/frames", json!({})) {
        Ok(listed) => listed,
        Err(e) => {
            problems.push(format!("canvases: {e}"));
            return Vec::new();
        }
    };
    let ids = listed["canvases"].as_array().into_iter().flatten();
    let mut answers = Vec::new();
    for id in ids.filter_map(|c| c["id"].as_str()) {
        let asked = json!({ "id": id, "status": wanted.name() });
        match live::canvas_call(app, ctx, Actor::Agent, "canvas/list-comments", asked) {
            Ok(answer) => answers.push(answer),
            Err(e) => problems.push(format!("canvas `{id}`: {e}")),
        }
    }
    canvas_rows_from(&answers)
}

/// Rows from `canvas/list-comments` answers, each comment once.
fn canvas_rows_from(answers: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    let comments = answers
        .iter()
        .flat_map(|a| a["comments"].as_array().into_iter().flatten());
    comments
        .filter_map(|c| {
            let (canvas, id) = (c["canvas"].as_str()?, c["id"].as_str()?);
            let r = Ref::Canvas {
                id: canvas.into(),
                part: Some(CanvasPart::Comment(id.into())),
            };
            if !seen.insert(r.to_string()) {
                return None;
            }
            let frame = c["frameId"].as_str().unwrap_or("");
            let at = format!("canvas {canvas}, frame {frame}");
            let text = c["text"].as_str().unwrap_or("");
            Some(row(&r, "canvas", c["status"].clone(), text, at))
        })
        .collect()
}

#[cfg(feature = "design-mode")]
fn design_rows(app: &AppHandle, wanted: Wanted) -> Vec<Value> {
    use tauri::Manager;
    let all = app.state::<crate::design_comments::Comments>().all();
    all.into_iter()
        .filter(|c| wanted.takes(c.status.active()))
        .map(|c| {
            let r = Ref::DesignComment { id: c.id.clone() };
            let at = format!("{} ({})", c.page.title, c.element.selector);
            row(&r, "design", json!(c.status), &c.request, at)
        })
        .collect()
}

#[cfg(not(feature = "design-mode"))]
fn design_rows(_app: &AppHandle, _wanted: Wanted) -> Vec<Value> {
    Vec::new()
}

/// Close the comment `r` names with the agent's `note`.
pub fn resolve(app: &AppHandle, ctx: &CallContext, r: &Ref, note: &str) -> Result<Value, String> {
    live::check(app, ctx, r)?;
    match r {
        Ref::Comment { id } => {
            let by = crate::comments::Author::Agent;
            crate::comments::resolve(ctx, id, note.to_string(), by).map_err(|e| e.message)?;
        }
        Ref::Canvas {
            id,
            part: Some(CanvasPart::Comment(c)),
        } => {
            let asked = json!({ "id": id, "commentId": c, "note": note });
            live::canvas_call(app, ctx, Actor::Agent, "canvas/resolve-comment", asked)?;
        }
        Ref::DesignComment { id } => resolve_design(app, id, note)?,
        _ => {
            return Err(format!(
                "`{r}` is not a comment; `list_comments` has the ones to resolve"
            ))
        }
    }
    Ok(json!({ "uri": r.to_string(), "status": "resolved", "note": note }))
}

#[cfg(feature = "design-mode")]
fn resolve_design(app: &AppHandle, id: &str, note: &str) -> Result<(), String> {
    use crate::design_comments::{Author, Comments, Status};
    use tauri::Manager;
    let said = app
        .state::<Comments>()
        .say(app, id, Author::Agent, note, Status::Resolved);
    said.map(drop)
        .ok_or_else(|| format!("there is no Design Mode comment `{id}`"))
}

#[cfg(not(feature = "design-mode"))]
fn resolve_design(_app: &AppHandle, _id: &str, _note: &str) -> Result<(), String> {
    Err("this build has no Design Mode".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_is_open_resolved_or_all_and_open_by_default() {
        assert_eq!(Wanted::parse(None), Ok(Wanted::Open));
        assert_eq!(Wanted::parse(Some("all")), Ok(Wanted::All));
        assert!(Wanted::parse(Some("closed")).is_err());
        assert!(Wanted::Open.takes(true) && !Wanted::Open.takes(false));
        assert!(Wanted::Resolved.takes(false) && !Wanted::Resolved.takes(true));
    }

    #[test]
    fn a_canvas_comment_is_listed_once_with_its_own_canvas() {
        let parent = json!({ "comments": [
            { "id": "c-1", "canvas": "world", "frameId": "f_1", "text": "Move this\nleft",
              "status": "open" },
            { "id": "c-2", "canvas": "world/menu", "frameId": "f_9", "text": "Too dark",
              "status": "open" },
        ]});
        let child = json!({ "comments": [
            { "id": "c-2", "canvas": "world/menu", "frameId": "f_9", "text": "Too dark",
              "status": "open" },
        ]});
        let rows = canvas_rows_from(&[parent, child]);
        let uris: Vec<_> = rows.iter().map(|r| r["uri"].as_str().unwrap()).collect();
        assert_eq!(
            uris,
            [
                "kaava://canvas/world#comment=c-1",
                "kaava://canvas/world/menu#comment=c-2"
            ]
        );
        assert_eq!(rows[0]["text"], "Move this");
        assert_eq!(rows[0]["where"], "canvas world, frame f_1");
    }

    #[test]
    fn a_listing_is_capped_and_says_how_many_there_were() {
        let rows = (0..MAX_LISTED + 5).map(|i| json!(i)).collect();
        let out = listing(rows, Vec::new());
        assert_eq!(out["comments"].as_array().unwrap().len(), MAX_LISTED);
        assert_eq!(out["total"], MAX_LISTED + 5);
        assert!(out.get("problems").is_none());
        let out = listing(Vec::new(), vec!["canvases: no project".into()]);
        assert_eq!(out["problems"][0], "canvases: no project");
    }
}
