//! Comments left on a viewer, kept where an agent working in that environment
//! can read them.
//!
//! `docs/KAAVA-UX-REWORK.md` §3.4 sets the shape: a comment anchors to a node
//! path in the Godot viewer, a mesh part and material in the Blender viewer, or
//! a scene, a playhead time and a screenshot in Play — then it is a file in
//! `.kaava/comments/` *inside the environment*, one file per comment rather
//! than one shared book, so it travels with that environment's branch and
//! merges the way git already merges text. [`new_id`] is why an id never has
//! to be reserved from a shared counter first.
//!
//! `docs/design-notes/viewer-comments.md` has the full rationale: why one file
//! per comment beats an array plus a counter, why there is no in-memory cache
//! the way [`crate::design_comments`] keeps one, and what still doesn't read
//! these comments back.

use crate::apps::CallContext;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Where a comment points. Exactly the three anchors
/// `docs/KAAVA-UX-REWORK.md` §3.4 names — one enum rather than three optional
/// fields on [`Comment`], so a comment can never be read back pointing at two
/// things at once or at nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Anchor {
    /// The Godot viewer: a node's path in the scene tree, e.g.
    /// `"Player/Flashlight"`.
    Node { path: String },
    /// The Blender viewer: a mesh part and the material selected on it.
    Mesh { part: String, material: String },
    /// Play: the scene the build was in, the playhead time in seconds, and
    /// whether a screenshot was captured alongside the comment. `screenshot`
    /// is set by [`create`] from whether a picture was actually written, on
    /// the same reasoning as `design_comments::Comment::has_shot` — a caller
    /// does not get to assert a picture exists before the write is known to
    /// have worked.
    Scene {
        scene: String,
        time: f64,
        #[serde(default)]
        screenshot: bool,
    },
}

/// Whose turn a comment reports, and who wrote a [`Resolution`].
///
/// Only [`Author::User`] is reachable today — nothing yet reads
/// `.kaava/comments/` into an agent's turn (see the open button in every
/// viewer's comment panel), so every comment and every resolution this build
/// writes is the user's. The variant is here anyway because the file format
/// is the one thing that must not need to change shape the day that reading
/// does exist, the same argument `design_comments::Author` was written under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Author {
    User,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Open,
    Resolved,
}

/// What closed a comment: the note whoever resolved it left, and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub note: String,
    pub by: Author,
    pub at: u64,
}

/// One comment, and the whole of one `.kaava/comments/<id>.json` file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub anchor: Anchor,
    pub author: Author,
    pub body: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
    pub created: u64,
    pub updated: u64,
}

/// A comment before it has an id or a clock reading. What a viewer's `create`
/// method builds from its params.
#[derive(Debug, Clone)]
pub struct Draft {
    pub anchor: Anchor,
    pub body: String,
    /// Raw PNG bytes, when the caller captured one. Only meaningful on an
    /// [`Anchor::Scene`] — see the type's own doc — and ignored on the other
    /// two, silently rather than as a refusal, because a draft is assembled by
    /// this module's callers from whatever a viewer's own capture path handed
    /// them, and only Play's has one.
    pub screenshot_png: Option<Vec<u8>>,
}

/// Every comment in this environment, oldest first.
///
/// Written order, not display order — the same choice `design_comments::all`
/// makes and for the same reason: an agent works a list from the top, and
/// should meet the oldest open request first. A viewer's own list panel sorts
/// for display however it wants to.
///
/// An environment that has never had a comment written to it — no
/// `.kaava/comments/` directory at all — is an empty list, not an error.
pub fn list(context: &CallContext) -> Result<Vec<Comment>, RpcError> {
    let dir = comments_dir(context)?;

    let reader = match std::fs::read_dir(&dir) {
        Ok(reader) => reader,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(RpcError::new(
                INTERNAL_ERROR,
                format!("could not read {}: {e}", dir.display()),
            ))
        }
    };

    let mut comments = Vec::new();
    for entry in reader.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match read_comment_file(&path) {
            Ok(comment) => comments.push(comment),
            // One unreadable comment — hand-edited, half-written by a crash —
            // is not a failed list. The rest of the environment's comments
            // still deserve to be shown.
            Err(e) => crate::kaava_log!("skipping unreadable comment {}: {e}", path.display()),
        }
    }
    comments.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    Ok(comments)
}

/// Write a new comment down and return it.
pub fn create(context: &CallContext, draft: Draft) -> Result<Comment, RpcError> {
    let dir = comments_dir(context)?;
    std::fs::create_dir_all(&dir).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not create {}: {e}", dir.display()),
        )
    })?;

    let at = monotonic_ms();
    let id = new_id(at);
    let anchor = match draft.anchor {
        Anchor::Scene { scene, time, .. } => {
            let screenshot = draft
                .screenshot_png
                .as_deref()
                .is_some_and(|png| save_shot(&dir, &id, png));
            Anchor::Scene {
                scene,
                time,
                screenshot,
            }
        }
        other => other,
    };

    let comment = Comment {
        id: id.clone(),
        anchor,
        author: Author::User,
        body: draft.body,
        status: Status::Open,
        resolution: None,
        created: at,
        updated: at,
    };
    write_comment_file(&comment_file(&dir, &id), &comment)?;
    Ok(comment)
}

/// Close a comment with a note. `INVALID_PARAMS` when `id` names nothing in
/// this environment, which is the caller's mistake to see and fix rather than
/// a server error.
pub fn resolve(context: &CallContext, id: &str, note: String) -> Result<Comment, RpcError> {
    let dir = comments_dir(context)?;
    let path = comment_file(&dir, id);
    let mut comment = read_comment_file(&path).map_err(|_| {
        RpcError::new(
            INVALID_PARAMS,
            format!("no comment `{id}` in this environment"),
        )
    })?;

    let at = monotonic_ms();
    comment.status = Status::Resolved;
    comment.resolution = Some(Resolution {
        note,
        by: Author::User,
        at,
    });
    comment.updated = at;

    write_comment_file(&path, &comment)?;
    Ok(comment)
}

// --- the RPC surface --------------------------------------------------------

/// The three methods every viewer app shares: `comments/list`,
/// `comments/create`, `comments/resolve`. Every one of `godot_viewer::call`,
/// `blender_viewer::call` and `play::call` tries this first, on the same
/// prefix-dispatch shape `files::call` uses for `trash::call` — one comment
/// store, reached identically from whichever viewer's frame the request came
/// from, because a comment belongs to the *environment* the call resolved to
/// ([`CallContext::project`]), not to which viewer happened to be open when it
/// was written. `None` when `method` is not one of the three, so a viewer's own
/// `call` falls through to its own methods.
pub fn call(
    context: &CallContext,
    method: &str,
    params: Option<&Value>,
) -> Option<Result<Value, RpcError>> {
    Some(match method {
        "comments/list" => list(context).and_then(|comments| to_value(&comments)),
        "comments/create" => create_from_params(context, params).and_then(|c| to_value(&c)),
        "comments/resolve" => resolve_from_params(context, params).and_then(|c| to_value(&c)),
        _ => return None,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    anchor: Anchor,
    body: String,
    /// Standard base64, no data-URI prefix — the same convention
    /// `files::readBytes` hands the frontend a `FileBytes::base64` in. Ignored
    /// by [`create`] on anything but an [`Anchor::Scene`].
    #[serde(default)]
    screenshot_base64: Option<String>,
}

fn create_from_params(context: &CallContext, params: Option<&Value>) -> Result<Comment, RpcError> {
    let params: CreateParams = parse_params(params)?;
    let screenshot_png = match params.screenshot_base64 {
        Some(b64) => Some(BASE64.decode(b64).map_err(|e| {
            RpcError::new(
                INVALID_PARAMS,
                format!("screenshotBase64 is not valid base64: {e}"),
            )
        })?),
        None => None,
    };
    create(
        context,
        Draft {
            anchor: params.anchor,
            body: params.body,
            screenshot_png,
        },
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveParams {
    id: String,
    note: String,
}

fn resolve_from_params(context: &CallContext, params: Option<&Value>) -> Result<Comment, RpcError> {
    let params: ResolveParams = parse_params(params)?;
    resolve(context, &params.id, params.note)
}

fn parse_params<T: serde::de::DeserializeOwned>(params: Option<&Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.cloned().unwrap_or(Value::Null))
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("bad params: {e}")))
}

fn to_value<T: Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not serialize response: {e}")))
}

// --- storage --------------------------------------------------------------

/// `<environment>/.kaava/comments`. `INTERNAL_ERROR` rather than a fallback
/// directory when the calling surface is in no cluster or the cluster has no
/// project: a comment anchors to *this environment's* branch, and writing one
/// somewhere else — the orchestrator's own working directory, say — would be a
/// file that silently never travels with anything.
fn comments_dir(context: &CallContext) -> Result<PathBuf, RpcError> {
    context
        .project
        .clone()
        .map(|project| project.join(".kaava").join("comments"))
        .ok_or_else(|| {
            RpcError::new(
                INTERNAL_ERROR,
                "this cluster has no environment to keep comments in — open a project first",
            )
        })
}

fn comment_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn shot_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.png"))
}

fn read_comment_file(path: &Path) -> Result<Comment, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Atomic write — temp file then rename, so a `git status` or another reader
/// never sees a half-written comment. The same shape `files::write` and
/// `design_comments::save` use.
fn write_comment_file(path: &Path, comment: &Comment) -> Result<(), RpcError> {
    let json = serde_json::to_string_pretty(comment).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not serialize comment {}: {e}", comment.id),
        )
    })?;

    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not write {}: {e}", temp.display()),
        )
    })?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not replace {}: {e}", path.display()),
        )
    })
}

/// Best-effort: a screenshot that fails to write leaves a comment with
/// `screenshot: false` rather than failing the whole comment, the same
/// trade-off `design_comments::save_shot` makes.
fn save_shot(dir: &Path, id: &str, png: &[u8]) -> bool {
    std::fs::write(shot_file(dir, id), png).is_ok()
}

/// A sortable, collision-resistant id with nothing to reserve first: hex
/// milliseconds since the epoch, so ids sort the way comments were written,
/// plus two random bytes so two comments from two clones of one worktree in
/// the same millisecond never fight over a filename. `millis` comes from
/// [`monotonic_ms`], so within one process the prefix never repeats either.
/// Twelve hex digits of millis is good past the year 10889, which is the only
/// property this format needs from the width.
fn new_id(millis: u64) -> String {
    let mut suffix = [0u8; 2];
    rand::rng().fill_bytes(&mut suffix);
    format!("{millis:012x}-{:02x}{:02x}", suffix[0], suffix[1])
}

/// The last stamp [`monotonic_ms`] handed out.
static LAST_STAMP: AtomicU64 = AtomicU64::new(0);

/// Milliseconds since the epoch, but strictly increasing within this process:
/// two calls in the same millisecond get consecutive values rather than a
/// tie. Ties are what made `list` fall back to `read_dir` order, which is
/// arbitrary. The stamp can run a few milliseconds ahead of the wall clock
/// under a burst; that is the price of a total order.
pub(crate) fn monotonic_ms() -> u64 {
    stamp_after(&LAST_STAMP, now())
}

fn stamp_after(last: &AtomicU64, wall_ms: u64) -> u64 {
    let mut prev = last.load(Ordering::Relaxed);
    loop {
        let next = wall_ms.max(prev.saturating_add(1));
        match last.compare_exchange_weak(prev, next, Ordering::SeqCst, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(seen) => prev = seen,
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn context(root: &Path) -> CallContext {
        CallContext {
            cluster_id: Some("c1".to_string()),
            project: Some(root.to_path_buf()),
        }
    }

    fn node_draft(body: &str) -> Draft {
        Draft {
            anchor: Anchor::Node {
                path: "Player/Flashlight".to_string(),
            },
            body: body.to_string(),
            screenshot_png: None,
        }
    }

    #[test]
    fn an_environment_with_no_comments_directory_lists_empty_rather_than_erroring() {
        let env = TempDir::new().expect("tempdir");
        assert_eq!(list(&context(env.path())).expect("list"), Vec::new());
    }

    #[test]
    fn a_call_with_no_project_is_refused_rather_than_writing_somewhere_unexpected() {
        let context = CallContext {
            cluster_id: None,
            project: None,
        };
        let err = create(&context, node_draft("hi")).expect_err("no environment");
        assert_eq!(err.code, INTERNAL_ERROR);
    }

    #[test]
    fn a_new_comment_is_open_and_carries_what_was_drafted() {
        let env = TempDir::new().expect("tempdir");
        let comment = create(&context(env.path()), node_draft("brighten this")).expect("create");

        assert_eq!(comment.status, Status::Open);
        assert_eq!(comment.body, "brighten this");
        assert_eq!(comment.author, Author::User);
        assert!(comment.resolution.is_none());
        assert_eq!(
            comment.anchor,
            Anchor::Node {
                path: "Player/Flashlight".to_string()
            }
        );

        let path = env
            .path()
            .join(".kaava")
            .join("comments")
            .join(format!("{}.json", comment.id));
        assert!(path.exists(), "the comment lands under .kaava/comments/");
    }

    #[test]
    fn two_comments_get_different_ids_even_written_back_to_back() {
        let env = TempDir::new().expect("tempdir");
        let first = create(&context(env.path()), node_draft("one")).expect("create");
        let second = create(&context(env.path()), node_draft("two")).expect("create");
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn list_returns_every_written_comment_oldest_first() {
        let env = TempDir::new().expect("tempdir");
        let first = create(&context(env.path()), node_draft("one")).expect("create");
        let second = create(&context(env.path()), node_draft("two")).expect("create");

        let all = list(&context(env.path())).expect("list");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, first.id);
        assert_eq!(all[1].id, second.id);
    }

    #[test]
    fn resolving_closes_a_comment_with_a_note_and_persists_it() {
        let env = TempDir::new().expect("tempdir");
        let comment = create(&context(env.path()), node_draft("tighten this")).expect("create");

        let resolved = resolve(
            &context(env.path()),
            &comment.id,
            "done — tightened".to_string(),
        )
        .expect("resolve");
        assert_eq!(resolved.status, Status::Resolved);
        assert_eq!(
            resolved.resolution.as_ref().map(|r| r.note.as_str()),
            Some("done — tightened")
        );

        let reread = list(&context(env.path())).expect("list");
        assert_eq!(reread[0].status, Status::Resolved);
    }

    #[test]
    fn resolving_an_unknown_id_says_so_rather_than_creating_one() {
        let env = TempDir::new().expect("tempdir");
        let err =
            resolve(&context(env.path()), "nonesuch", "note".to_string()).expect_err("unknown id");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn a_scene_anchor_records_whether_a_screenshot_was_actually_written() {
        let env = TempDir::new().expect("tempdir");
        let draft = Draft {
            anchor: Anchor::Scene {
                scene: "hospital_wing".to_string(),
                time: 42.8,
                screenshot: false,
            },
            body: "why is the light flickering here?".to_string(),
            screenshot_png: Some(vec![0x89, b'P', b'N', b'G']),
        };
        let comment = create(&context(env.path()), draft).expect("create");
        match comment.anchor {
            Anchor::Scene { screenshot, .. } => assert!(screenshot, "the png did write"),
            other => panic!("expected a Scene anchor, got {other:?}"),
        }

        let shot = env
            .path()
            .join(".kaava")
            .join("comments")
            .join(format!("{}.png", comment.id));
        assert!(shot.exists());
    }

    #[test]
    fn a_scene_draft_with_no_screenshot_bytes_records_no_screenshot() {
        let env = TempDir::new().expect("tempdir");
        let draft = Draft {
            anchor: Anchor::Scene {
                scene: "hospital_wing".to_string(),
                time: 1.0,
                screenshot: false,
            },
            body: "note".to_string(),
            screenshot_png: None,
        };
        let comment = create(&context(env.path()), draft).expect("create");
        match comment.anchor {
            Anchor::Scene { screenshot, .. } => assert!(!screenshot),
            other => panic!("expected a Scene anchor, got {other:?}"),
        }
    }

    #[test]
    fn a_node_or_mesh_draft_ignores_any_screenshot_bytes_handed_to_it() {
        let env = TempDir::new().expect("tempdir");
        let draft = Draft {
            anchor: Anchor::Mesh {
                part: "headboard".to_string(),
                material: "oak".to_string(),
            },
            body: "note".to_string(),
            screenshot_png: Some(vec![1, 2, 3]),
        };
        let comment = create(&context(env.path()), draft).expect("create");
        let shot = env
            .path()
            .join(".kaava")
            .join("comments")
            .join(format!("{}.png", comment.id));
        assert!(
            !shot.exists(),
            "a mesh anchor has nowhere in its shape for a screenshot flag, so none is written"
        );
    }

    #[test]
    fn statuses_and_anchor_kinds_serialize_as_the_words_the_frontend_expects() {
        assert_eq!(
            serde_json::to_string(&Status::Resolved).ok(),
            Some("\"resolved\"".to_string())
        );
        assert_eq!(
            serde_json::to_value(Anchor::Node {
                path: "A/B".to_string()
            })
            .ok()
            .and_then(|v| v.get("kind").cloned()),
            Some(serde_json::Value::String("node".to_string()))
        );
        assert_eq!(
            serde_json::to_value(Anchor::Mesh {
                part: "p".to_string(),
                material: "m".to_string()
            })
            .ok()
            .and_then(|v| v.get("kind").cloned()),
            Some(serde_json::Value::String("mesh".to_string()))
        );
        assert_eq!(
            serde_json::to_value(Anchor::Scene {
                scene: "s".to_string(),
                time: 0.0,
                screenshot: false
            })
            .ok()
            .and_then(|v| v.get("kind").cloned()),
            Some(serde_json::Value::String("scene".to_string()))
        );
    }

    #[test]
    fn a_comment_survives_a_round_trip_through_the_file_format() {
        let env = TempDir::new().expect("tempdir");
        let comment = create(&context(env.path()), node_draft("round trip")).expect("create");
        let reread = list(&context(env.path())).expect("list");
        assert_eq!(reread[0], comment);
    }

    // --- the shared `call` dispatcher, as every viewer app reaches it ------

    #[test]
    fn an_unrelated_method_is_not_claimed_by_the_comments_dispatcher() {
        let env = TempDir::new().expect("tempdir");
        assert!(call(&context(env.path()), "godot-viewer/state", None).is_none());
    }

    #[test]
    fn create_over_the_dispatcher_round_trips_an_anchor_and_body() {
        use serde_json::json;

        let env = TempDir::new().expect("tempdir");
        let params = json!({
            "anchor": { "kind": "mesh", "part": "headboard", "material": "oak" },
            "body": "make this thinner",
        });
        let result = call(&context(env.path()), "comments/create", Some(&params))
            .expect("comments/create is claimed")
            .expect("create succeeds");

        assert_eq!(result["body"], "make this thinner");
        assert_eq!(result["status"], "open");
        assert_eq!(result["anchor"]["kind"], "mesh");
        assert_eq!(result["anchor"]["part"], "headboard");

        let listed = call(&context(env.path()), "comments/list", None)
            .expect("comments/list is claimed")
            .expect("list succeeds");
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn resolve_over_the_dispatcher_needs_an_id_and_a_note() {
        use serde_json::json;

        let env = TempDir::new().expect("tempdir");
        let params = json!({ "note": "missing id" });
        let err = call(&context(env.path()), "comments/resolve", Some(&params))
            .expect("comments/resolve is claimed")
            .expect_err("id is required");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn malformed_base64_on_a_scene_screenshot_is_refused_before_anything_is_written() {
        use serde_json::json;

        let env = TempDir::new().expect("tempdir");
        let params = json!({
            "anchor": { "kind": "scene", "scene": "hospital_wing", "time": 1.0 },
            "body": "note",
            "screenshotBase64": "not valid base64 !!",
        });
        let err = call(&context(env.path()), "comments/create", Some(&params))
            .expect("comments/create is claimed")
            .expect_err("bad base64 is refused");
        assert_eq!(err.code, INVALID_PARAMS);
        assert!(list(&context(env.path())).expect("list").is_empty());
    }

    #[test]
    fn stamps_never_repeat_even_when_the_clock_stands_still_or_steps_back() {
        let last = AtomicU64::new(0);
        assert_eq!(stamp_after(&last, 100), 100);
        assert_eq!(stamp_after(&last, 100), 101);
        assert_eq!(stamp_after(&last, 90), 102);
        assert_eq!(stamp_after(&last, 500), 500);
    }

    #[test]
    fn monotonic_ms_strictly_increases() {
        let stamps: Vec<u64> = (0..1000).map(|_| monotonic_ms()).collect();
        assert!(stamps.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn fifty_back_to_back_comments_list_in_creation_order() {
        let env = TempDir::new().expect("tempdir");
        let ctx = context(env.path());
        let made: Vec<String> = (0..50)
            .map(|i| {
                create(&ctx, node_draft(&format!("c{i}")))
                    .expect("create")
                    .id
            })
            .collect();
        let listed: Vec<String> = list(&ctx)
            .expect("list")
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(listed, made);
        assert!(
            made.windows(2).all(|w| w[0] < w[1]),
            "ids sort like creation"
        );
    }
}
