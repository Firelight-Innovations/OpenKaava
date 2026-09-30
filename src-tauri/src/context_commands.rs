//! The shell's side of the context store: what happens when something is
//! dropped on, pasted into, or re-sent to a terminal.
//!
//! `context.rs` is the store and knows nothing of terminals; `harness.rs`
//! knows how to write a reference and nothing of files. This is the seam that
//! joins them, and the only place that both resolves a terminal's environment
//! and writes to its pty.

use crate::context::{self, ContextItem, Kind, Method, Payload, PutRequest};
use crate::error::{AppError, Result};
use crate::harness::{self, Harness};
use crate::project;
use crate::pty::PtySessions;
use crate::shell_state::ShellState;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// The id every terminal-originated item is stamped with as its source app.
const TERMINAL_APP_ID: &str = "terminal";

/// What an insertion did, so the frontend can report it without guessing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inserted {
    /// Exactly what was written at the prompt. Empty when nothing was.
    pub text: String,
    /// How many references `text` holds. Counted here because a quoted path can
    /// contain a space, so the frontend cannot count words.
    pub count: usize,
    pub harness: Harness,
    /// Items registered by this insertion, for the strip to show at once.
    pub items: Vec<ContextItem>,
    /// One sentence per path that was refused, for the user to read.
    pub refused: Vec<String>,
}

/// Which harness a terminal is aimed at, for the strip's label and override.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessInfo {
    pub effective: Harness,
    pub detected: Option<Harness>,
    pub overridden: Option<Harness>,
}

fn pty_err(id: &str, reason: impl Into<String>) -> AppError {
    AppError::Pty {
        id: id.to_string(),
        reason: reason.into(),
    }
}

/// The environment root a terminal's context lives in.
fn root_of(app: &AppHandle, id: &str) -> Result<PathBuf> {
    let shell = app.state::<ShellState>();
    let cluster = shell
        .cluster_of_terminal(id)
        .ok_or_else(|| pty_err(id, "no such terminal"))?;
    project::cluster_path(app, &cluster).ok_or_else(|| {
        pty_err(
            id,
            "this terminal's cluster has no environment to keep context in",
        )
    })
}

/// Pure core of a drop, split out so it is tested without a pty: which paths
/// end up in the reference, which items were registered, what was refused.
///
/// A plain shell is left alone entirely — a path dropped for `git add` must
/// stay the path the user meant. Only a coding harness gets files copied into
/// the store, because only there does "the agent's sandbox can read it" matter.
pub fn ingest_drop(
    root: Option<&Path>,
    harness: Harness,
    paths: &[String],
) -> (Vec<String>, Vec<ContextItem>, Vec<String>) {
    let mut out = Vec::new();
    let mut items = Vec::new();
    let mut refused = Vec::new();

    for raw in paths {
        let path = PathBuf::from(raw);
        let Some(root) = root.filter(|_| harness.is_agent() && path.is_file()) else {
            out.push(raw.clone());
            continue;
        };
        // Already in the store (a chip dragged out again): reference it, do not
        // register a second record for the same file.
        if context::inside(&context::store_dir(root), &path) {
            out.push(raw.clone());
            continue;
        }
        let too_big = !context::inside(root, &path)
            && std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > context::MAX_FILE_BYTES;
        if too_big {
            // Not copied, but still useful to the agent by its own path.
            out.push(raw.clone());
            continue;
        }
        let title = path.file_name().map(|n| n.to_string_lossy().into_owned());
        match context::put(
            root,
            PutRequest {
                kind: None,
                title,
                payload: Payload::Path(path.clone()),
                app_id: TERMINAL_APP_ID.into(),
                label: None,
                method: Method::Drop,
                reference_in_place: true,
            },
        ) {
            Ok(item) => {
                out.push(item.path.clone());
                items.push(item);
            }
            Err(e) => refused.push(format!(
                "{}: {}",
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                e.message
            )),
        }
    }
    (out, items, refused)
}

fn insert(
    ptys: &PtySessions,
    id: &str,
    target: &crate::pty::Target,
    paths: &[String],
    items: Vec<ContextItem>,
    refused: Vec<String>,
) -> Inserted {
    let text = harness::reference(target.harness, target.family, target.cwd.as_deref(), paths);
    if !text.is_empty() {
        // Same door as a keystroke: see `PtySessions::insert_paths`.
        ptys.write(id, &text);
    }
    let count = paths
        .iter()
        .filter(|p| !p.chars().any(char::is_control))
        .count();
    Inserted {
        text,
        count,
        harness: target.harness,
        items,
        refused,
    }
}

/// Files were dropped on a terminal, from Explorer or from a Kaava app.
#[tauri::command]
pub fn terminal_drop_paths(
    app: AppHandle,
    ptys: State<'_, PtySessions>,
    id: String,
    paths: Vec<String>,
) -> Result<Inserted> {
    let target = ptys
        .target(&id)
        .ok_or_else(|| pty_err(&id, "no such terminal session to insert into"))?;
    // No root is fine for a plain shell (there is nothing to store); a harness
    // without a root just gets its paths as dropped.
    let root = root_of(&app, &id).ok();
    let (out, items, refused) = ingest_drop(root.as_deref(), target.harness, &paths);
    if let (false, Some(root)) = (items.is_empty(), root.as_deref()) {
        context::notify(&app, root);
    }
    Ok(insert(&ptys, &id, &target, &out, items, refused))
}

/// An image was pasted into a terminal. Stored, then referenced at the prompt.
#[tauri::command]
pub fn terminal_paste_image(
    app: AppHandle,
    ptys: State<'_, PtySessions>,
    id: String,
    bytes_base64: String,
    name: Option<String>,
) -> Result<Inserted> {
    let target = ptys
        .target(&id)
        .ok_or_else(|| pty_err(&id, "no such terminal session to insert into"))?;
    let root = root_of(&app, &id)?;
    let bytes = BASE64
        .decode(bytes_base64)
        .map_err(|e| pty_err(&id, format!("the pasted image is not valid base64: {e}")))?;
    match context::put(
        &root,
        PutRequest {
            kind: Some(Kind::Image),
            title: Some(name.unwrap_or_else(|| "pasted image".into())),
            payload: Payload::Bytes(bytes),
            app_id: TERMINAL_APP_ID.into(),
            label: None,
            method: Method::Clipboard,
            reference_in_place: false,
        },
    ) {
        Ok(item) => {
            context::notify(&app, &root);
            let path = item.path.clone();
            Ok(insert(&ptys, &id, &target, &[path], vec![item], Vec::new()))
        }
        // A refused paste is a message for the user, not a crash.
        Err(e) => Ok(Inserted {
            text: String::new(),
            count: 0,
            harness: target.harness,
            items: Vec::new(),
            refused: vec![e.message],
        }),
    }
}

/// Send items already in the store to a terminal again (the strip's re-insert).
#[tauri::command]
pub fn terminal_insert_items(
    app: AppHandle,
    ptys: State<'_, PtySessions>,
    id: String,
    item_ids: Vec<String>,
) -> Result<Inserted> {
    let target = ptys
        .target(&id)
        .ok_or_else(|| pty_err(&id, "no such terminal session to insert into"))?;
    let root = root_of(&app, &id)?;
    let mut paths = Vec::new();
    let mut refused = Vec::new();
    for item_id in &item_ids {
        match context::get(&root, item_id) {
            Ok(item) if !item.missing => paths.push(item.path),
            Ok(item) => refused.push(format!("{}: the file is gone", item.title)),
            Err(e) => refused.push(e.message),
        }
    }
    Ok(insert(&ptys, &id, &target, &paths, Vec::new(), refused))
}

/// The absolute paths of items, for a drag that carries item ids. `instance` is
/// the frame that began the drag; its cluster decides which store the ids
/// belong to, so a frame cannot name another environment's items.
#[tauri::command]
pub fn context_item_paths(
    app: AppHandle,
    instance: String,
    item_ids: Vec<String>,
) -> Result<Vec<String>> {
    let ctx = crate::apps::CallContext::resolve(&app, Some(&instance), None);
    let root = ctx
        .project
        .ok_or_else(|| pty_err(&instance, "no environment for that frame"))?;
    Ok(item_ids
        .iter()
        .filter_map(|id| context::get(&root, id).ok())
        .filter(|i| !i.missing)
        .map(|i| i.path)
        .collect())
}

#[tauri::command]
pub fn terminal_harness(ptys: State<'_, PtySessions>, id: String) -> Option<HarnessInfo> {
    let t = ptys.target(&id)?;
    Some(HarnessInfo {
        effective: t.harness,
        detected: t.detected,
        overridden: t.overridden,
    })
}

/// `"auto"`, `"claude"`, `"codex"`, `"gemini"` or `"shell"`.
#[tauri::command]
pub fn terminal_set_harness(
    ptys: State<'_, PtySessions>,
    id: String,
    choice: String,
) -> Result<()> {
    let parsed = match choice.as_str() {
        "auto" => None,
        other => Some(
            Harness::parse(other)
                .ok_or_else(|| pty_err(&id, format!("unknown harness `{other}`")))?,
        ),
    };
    if ptys.set_harness_override(&id, parsed) {
        Ok(())
    } else {
        Err(pty_err(&id, "no such terminal session"))
    }
}

#[tauri::command]
pub fn context_list(app: AppHandle, terminal_id: String) -> Result<Vec<ContextItem>> {
    Ok(context::list(&root_of(&app, &terminal_id)?))
}

#[tauri::command]
pub fn context_remove(app: AppHandle, terminal_id: String, item_id: String) -> Result<()> {
    let root = root_of(&app, &terminal_id)?;
    context::remove(&root, &item_id).map_err(|e| pty_err(&terminal_id, e.message))?;
    context::notify(&app, &root);
    Ok(())
}

/// `(mime, base64)` of an image item, for its thumbnail.
#[tauri::command]
pub fn context_thumb(
    app: AppHandle,
    terminal_id: String,
    item_id: String,
) -> Result<(String, String)> {
    let root = root_of(&app, &terminal_id)?;
    context::read_image(&root, &item_id).map_err(|e| pty_err(&terminal_id, e.message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn png() -> Vec<u8> {
        let mut b = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        b.extend_from_slice(&[0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
        b
    }

    fn strings(p: &Path) -> Vec<String> {
        vec![p.to_string_lossy().into_owned()]
    }

    #[test]
    fn a_plain_shell_drop_is_untouched_and_stores_nothing() {
        let env = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let f = outside.path().join("a b.txt");
        std::fs::write(&f, "x").unwrap();
        let (out, items, refused) = ingest_drop(Some(env.path()), Harness::Shell, &strings(&f));
        assert_eq!(out, strings(&f));
        assert!(items.is_empty() && refused.is_empty());
        assert!(context::list(env.path()).is_empty());
    }

    #[test]
    fn a_harness_drop_copies_outside_files_in_and_references_the_copy() {
        let env = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let f = outside.path().join("Shot One.png");
        std::fs::write(&f, png()).unwrap();
        let (out, items, refused) = ingest_drop(Some(env.path()), Harness::Claude, &strings(&f));
        assert!(refused.is_empty());
        assert_eq!(items.len(), 1);
        assert_eq!(out, vec![items[0].path.clone()]);
        assert!(context::inside(
            &context::store_dir(env.path()),
            Path::new(&out[0])
        ));
        assert!(f.exists());
    }

    #[test]
    fn a_harness_drop_of_a_file_already_in_the_environment_is_referenced_in_place() {
        let env = TempDir::new().unwrap();
        let f = env.path().join("design.md");
        std::fs::write(&f, "# d").unwrap();
        let (out, items, _) = ingest_drop(Some(env.path()), Harness::Claude, &strings(&f));
        assert_eq!(out, strings(&f));
        assert!(!items[0].owned);
    }

    #[test]
    fn a_chip_dragged_back_out_of_the_store_is_not_registered_twice() {
        let env = TempDir::new().unwrap();
        let (out, _, _) = ingest_drop(
            Some(env.path()),
            Harness::Claude,
            &strings(&{
                let item = context::put(
                    env.path(),
                    PutRequest {
                        kind: None,
                        title: None,
                        payload: Payload::Bytes(png()),
                        app_id: "x".into(),
                        label: None,
                        method: Method::Put,
                        reference_in_place: false,
                    },
                )
                .unwrap();
                PathBuf::from(item.path)
            }),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(context::list(env.path()).len(), 1);
    }

    #[test]
    fn an_executable_is_refused_with_a_reason_and_left_out_of_the_reference() {
        let env = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let f = outside.path().join("setup.exe");
        std::fs::write(&f, b"MZ\0\0\0\0\0\0").unwrap();
        let (out, items, refused) = ingest_drop(Some(env.path()), Harness::Claude, &strings(&f));
        assert!(out.is_empty() && items.is_empty());
        assert_eq!(refused.len(), 1);
        assert!(refused[0].starts_with("setup.exe:"));
    }

    #[test]
    fn a_directory_is_referenced_as_itself_and_never_copied() {
        let env = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let (out, items, _) =
            ingest_drop(Some(env.path()), Harness::Claude, &strings(outside.path()));
        assert_eq!(out, strings(outside.path()));
        assert!(items.is_empty());
    }

    #[test]
    fn with_no_environment_a_harness_drop_still_passes_paths_through() {
        let outside = TempDir::new().unwrap();
        let f = outside.path().join("a.png");
        std::fs::write(&f, png()).unwrap();
        let (out, items, _) = ingest_drop(None, Harness::Claude, &strings(&f));
        assert_eq!(out, strings(&f));
        assert!(items.is_empty());
    }
}
