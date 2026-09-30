//! Review comments pinned to a diagram: a person points at something, an
//! agent fixes it and says how.
//!
//! One JSON file per comment, in a sidecar folder beside the canvas:
//! `canvas/<id>.comments/<comment-id>.json`. One file each so two people
//! commenting on one canvas on two branches merge without a conflict, and so a
//! resolution is a one-file diff. The folder name has a `.`, which no canvas id
//! may, so the canvas walker never mistakes it for a nested canvas.
//!
//! Rejected: comments inside the canvas file. Every autosave rewrites that
//! file, so an agent resolving a comment while a person draws would race the
//! editor's write, and a merge of two review rounds would conflict on the
//! elements array rather than add two files.
//!
//! The shape follows `crate::comments` (viewer comments) and the markup format
//! on the `ux/markup` branch in spirit: a target is element ids (markup's
//! `targets`) or a frame-relative box (markup's `bounds`), plus text, author,
//! status and a resolution note. It does not depend on either.

use super::{bad, file_for, now_rfc3339, relative, DIR};
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The `schema` value this build writes.
const SCHEMA: u64 = 1;

/// The longest comment accepted. A review note, not a document.
const MAX_TEXT: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resolution {
    pub note: String,
    pub by: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub schema: u64,
    pub id: String,
    pub canvas: String,
    /// The diagram id the comment is on (the frame element id for an unnamed
    /// frame).
    pub frame_id: String,
    /// The elements pointed at. Empty when the target is a region.
    #[serde(default)]
    pub element_ids: Vec<String>,
    /// A box relative to the frame's top-left, when the target is a region.
    #[serde(default)]
    pub region: Option<Region>,
    pub text: String,
    pub author: String,
    pub created_at: String,
    pub status: String,
    #[serde(default)]
    pub resolution: Option<Resolution>,
}

/// `canvas/<id>.comments/`.
pub fn dir_for(root: &Path, canvas: &str) -> PathBuf {
    let file = file_for(root, canvas);
    let mut name = file.file_stem().unwrap_or_default().to_os_string();
    name.push(".comments");
    file.with_file_name(name)
}

fn validate_comment_id(id: &str) -> Result<(), RpcError> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(bad(format!("comment id `{id}` is not one this app made")))
    }
}

fn path_of(root: &Path, canvas: &str, id: &str) -> PathBuf {
    dir_for(root, canvas).join(format!("{id}.json"))
}

/// A new id: time first so a folder listing sorts oldest first, then a random
/// tail so two comments in one millisecond do not collide.
fn new_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tail: u32 = rand::random();
    format!("c-{millis:x}-{:06x}", tail & 0x00ff_ffff)
}

/// Every comment on `canvas`, oldest first. A file that does not parse is
/// named in `unreadable`, not dropped in silence.
pub fn load_all(root: &Path, canvas: &str) -> (Vec<Comment>, Vec<String>) {
    let mut out = Vec::new();
    let mut unreadable = Vec::new();
    let Ok(reader) = std::fs::read_dir(dir_for(root, canvas)) else {
        return (out, unreadable);
    };
    for entry in reader.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Comment>(&t).ok())
        {
            Some(c) => out.push(c),
            None => unreadable.push(relative(root, &path)),
        }
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    (out, unreadable)
}

pub fn load_one(root: &Path, canvas: &str, id: &str) -> Result<Comment, RpcError> {
    validate_comment_id(id)?;
    let path = path_of(root, canvas, id);
    let text = std::fs::read_to_string(&path).map_err(|_| {
        RpcError::with_data(
            INVALID_PARAMS,
            format!("canvas `{canvas}` has no comment `{id}`"),
            json!({ "kind": "missing" }),
        )
    })?;
    serde_json::from_str(&text).map_err(|e| {
        RpcError::with_data(
            INTERNAL_ERROR,
            format!("{} is not a comment: {e}", relative(root, &path)),
            json!({ "kind": "corrupt" }),
        )
    })
}

fn save(root: &Path, comment: &Comment) -> Result<(), RpcError> {
    let path = path_of(root, &comment.canvas, &comment.id);
    let mut text = serde_json::to_string_pretty(comment)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not serialize: {e}")))?;
    text.push('\n');
    super::store::atomic_write(&path, text.as_bytes())
}

pub fn to_json(root: &Path, c: &Comment) -> Value {
    let mut v = serde_json::to_value(c).unwrap_or(Value::Null);
    v["path"] = json!(relative(root, &path_of(root, &c.canvas, &c.id)));
    v
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateParams {
    pub diagram: String,
    #[serde(default)]
    pub element_ids: Vec<String>,
    #[serde(default)]
    pub region: Option<Region>,
    pub text: String,
}

/// Validate and store a new comment. `frame_id` is already resolved to the
/// diagram's id by the caller, which has the scene.
pub fn create(
    root: &Path,
    canvas: &str,
    frame_id: &str,
    p: CreateParams,
    author: &str,
) -> Result<Comment, RpcError> {
    let text = p.text.trim().to_string();
    if text.is_empty() {
        return Err(bad("a comment needs text"));
    }
    if text.chars().count() > MAX_TEXT {
        return Err(bad(format!("a comment is at most {MAX_TEXT} characters")));
    }
    if p.element_ids.is_empty() && p.region.is_none() {
        return Err(bad(
            "a comment needs a target: elementIds (what was clicked) or region (a box, relative \
             to the frame's top-left)",
        ));
    }
    if let Some(r) = p.region {
        if !(r.width > 0.0 && r.height > 0.0) || !r.x.is_finite() || !r.y.is_finite() {
            return Err(bad("region needs a positive width and height"));
        }
    }
    let comment = Comment {
        schema: SCHEMA,
        id: new_id(),
        canvas: canvas.to_string(),
        frame_id: frame_id.to_string(),
        element_ids: p.element_ids,
        region: p.region,
        text,
        author: author.to_string(),
        created_at: now_rfc3339(),
        status: "open".into(),
        resolution: None,
    };
    save(root, &comment)?;
    Ok(comment)
}

/// Mark a comment resolved with a note saying what was done, or reopen it.
pub fn set_status(
    root: &Path,
    canvas: &str,
    id: &str,
    resolved: bool,
    note: Option<&str>,
    by: &str,
) -> Result<Comment, RpcError> {
    let mut comment = load_one(root, canvas, id)?;
    if resolved {
        let note = note.map(str::trim).unwrap_or("");
        if note.is_empty() {
            return Err(bad(
                "resolving needs a note saying what was changed, so the reviewer can check it",
            ));
        }
        comment.status = "resolved".into();
        comment.resolution = Some(Resolution {
            note: note.to_string(),
            by: by.to_string(),
            at: now_rfc3339(),
        });
    } else {
        comment.status = "open".into();
        comment.resolution = None;
    }
    save(root, &comment)?;
    Ok(comment)
}

/// The folder a sidecar belongs in exists only once the canvas does.
pub fn require_canvas(root: &Path, canvas: &str) -> Result<(), RpcError> {
    if file_for(root, canvas).is_file() {
        Ok(())
    } else {
        Err(RpcError::with_data(
            INVALID_PARAMS,
            format!("there is no canvas `{canvas}` in {DIR}/"),
            json!({ "kind": "missing" }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("canvas")).unwrap();
        std::fs::write(dir.path().join("canvas/game.json"), "{}").unwrap();
        dir
    }

    fn params(text: &str) -> CreateParams {
        CreateParams {
            diagram: "playfield".into(),
            element_ids: vec!["ball".into()],
            region: None,
            text: text.into(),
        }
    }

    #[test]
    fn a_comment_is_one_file_in_the_sidecar_and_lists_back() {
        let dir = setup();
        let c = create(dir.path(), "game", "playfield", params("ball too big"), "human").unwrap();
        let file = dir.path().join(format!("canvas/game.comments/{}.json", c.id));
        assert!(file.is_file());
        let (all, unreadable) = load_all(dir.path(), "game");
        assert!(unreadable.is_empty());
        assert_eq!(all, vec![c.clone()]);
        let json = to_json(dir.path(), &c);
        assert_eq!(json["frameId"], "playfield");
        assert_eq!(json["elementIds"], json!(["ball"]));
        assert_eq!(json["status"], "open");
    }

    #[test]
    fn a_comment_needs_text_and_a_target() {
        let dir = setup();
        assert!(create(dir.path(), "game", "p", params("  "), "human").is_err());
        let no_target = CreateParams {
            element_ids: vec![],
            ..params("x")
        };
        assert!(create(dir.path(), "game", "p", no_target, "human").is_err());
        let flat = CreateParams {
            element_ids: vec![],
            region: Some(Region {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 5.0,
            }),
            ..params("x")
        };
        assert!(create(dir.path(), "game", "p", flat, "human").is_err());
    }

    #[test]
    fn resolving_needs_a_note_and_records_who() {
        let dir = setup();
        let c = create(dir.path(), "game", "p", params("fix"), "human").unwrap();
        assert!(set_status(dir.path(), "game", &c.id, true, Some(" "), "agent").is_err());
        let done = set_status(dir.path(), "game", &c.id, true, Some("shrunk it"), "agent").unwrap();
        assert_eq!(done.status, "resolved");
        let r = done.resolution.unwrap();
        assert_eq!((r.note.as_str(), r.by.as_str()), ("shrunk it", "agent"));
        let open = set_status(dir.path(), "game", &c.id, false, None, "human").unwrap();
        assert_eq!(open.status, "open");
        assert!(open.resolution.is_none());
    }

    #[test]
    fn a_broken_file_is_reported_and_bad_ids_are_refused() {
        let dir = setup();
        let side = dir.path().join("canvas/game.comments");
        std::fs::create_dir_all(&side).unwrap();
        std::fs::write(side.join("c-bad.json"), "{").unwrap();
        let (all, unreadable) = load_all(dir.path(), "game");
        assert!(all.is_empty());
        assert_eq!(unreadable, vec!["canvas/game.comments/c-bad.json"]);
        assert!(load_one(dir.path(), "game", "../x").is_err());
        assert!(load_one(dir.path(), "game", "c-missing").is_err());
    }

    #[test]
    fn nested_canvases_keep_their_sidecar_beside_them() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            relative(dir.path(), &dir_for(dir.path(), "levels/ward-b")),
            "canvas/levels/ward-b.comments"
        );
    }
}
