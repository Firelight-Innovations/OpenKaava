//! Seeing what was deleted, and pulling it back out.
//!
//! `files/delete` moves things to the Recycle Bin, which is what makes deleting
//! from Veistra recoverable. This module is the other half of that promise: the
//! deleted things are listable, restorable and — deliberately last — permanently
//! purgeable, by a person through the Files app and by an agent through the same
//! three methods.
//!
//! The scoping rule is the whole design: every method here filters to items
//! whose original location was inside the current project root, and the filter
//! is applied before the lookup rather than after it. `platform::scoped` and
//! `platform::find` carry the account of why, each beside the half it enforces.
//!
//! This is a real boundary in a way the note at the top of `files.rs` explains
//! its own path checks are not. That module argues, correctly, that a path check
//! defending against the user's own file browser is a fence with no field behind
//! it. This one is different: it is not defending the filesystem from the user,
//! it is keeping a tool's blast radius inside the project it was pointed at,
//! which is a scope decision rather than a security theatre one.

use crate::apps::CallContext;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

pub fn call(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    match method {
        "trash/list" => list(app, context),
        "trash/restore" => restore(app, context, params.as_ref()),
        "trash/purge" => purge(app, context, params.as_ref()),

        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

/// The `id` param every method but `list` needs.
///
/// A `TrashItem`'s id is an `OsString` — on Windows the shell's absolute parsing
/// name for the item in the bin. It crosses the wire as a lossy `String`, which
/// is worth being explicit about: a name containing unpaired surrogates would
/// not round-trip. The failure mode is the safe one, because the id is only ever
/// *matched against* a freshly listed set — a mangled id matches nothing and the
/// call reports the item as gone rather than acting on the wrong one.
fn required_id(params: Option<&Value>) -> Result<String, RpcError> {
    match params.and_then(|p| p.get("id")) {
        Some(Value::String(raw)) => Ok(raw.clone()),
        Some(other) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("id must be a string, got {other}"),
        )),
        None => Err(RpcError::new(INVALID_PARAMS, "id is required")),
    }
}

/// Where the scope is drawn: the same root the Files tree is showing.
///
/// Deliberately `files::default_root` and not a second opinion — "the trash for
/// this project" has to mean the trash for the tree beside it, or the two panes
/// would disagree about what project the user is in. Now that a project is the
/// cluster's, that agreement is bought by passing the *same* [`CallContext`]
/// down: the trash pane and the tree beside it are the same Files surface, so
/// they resolve the same cluster and cannot come apart.
fn scope_root(app: &AppHandle, context: &CallContext) -> Result<PathBuf, RpcError> {
    super::files::default_root(app, context)
}

/// Whether `path` is inside `root` — the scoping predicate, used everywhere.
///
/// A prefix test with a separator check, for the same reason the frontend's
/// `isAtOrUnder` has one: without it a project at `C:\games\aurora` would claim
/// deleted files from `C:\games\aurora-old`, and a purge could then reach
/// outside the project the user is actually in.
fn is_inside(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).is_ok()
}

/// The three entry points, on a platform whose trash can be enumerated.
///
/// `trash::os_limited` is on Windows and on Freedesktop-compliant Unix, and
/// **not on macOS** — the crate cfg-gates the whole module, because macOS offers
/// no API to enumerate or restore from its Trash. Veistra runs on Windows, so this
/// is not a live gap, but the code is gated to match rather than failing to
/// compile there.
#[cfg(any(
    target_os = "windows",
    all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    )
))]
mod platform {
    use super::*;
    use trash::os_limited;

    /// Every trashed item that came from inside `root`.
    ///
    /// The one function that reads the system bin. Everything else in this
    /// module goes through it, which is what guarantees no code path here ever
    /// holds a `TrashItem` from outside the project.
    ///
    /// `os_limited::list()` returns **the entire system Recycle Bin**. Every
    /// file the user has deleted anywhere on this machine, from any application,
    /// going back as far as Windows has kept it. Holiday photos, tax returns, a
    /// half-finished CV.
    ///
    /// Handing that to a project tool would be wrong twice over. It would show a
    /// game developer their unrelated personal files inside their game editor,
    /// and it would let an *agent* — which is the point of the RPC surface —
    /// restore or permanently destroy arbitrary items anywhere on the disk.
    /// Neither is reach a project tool has any business having.
    pub fn scoped(root: &Path) -> Result<Vec<trash::TrashItem>, RpcError> {
        let all = os_limited::list().map_err(|e| {
            RpcError::new(
                INTERNAL_ERROR,
                format!("could not read the Recycle Bin: {e}"),
            )
        })?;

        Ok(all
            .into_iter()
            .filter(|item| is_inside(&item.original_path(), root))
            .collect())
    }

    /// One scoped item by id, or a refusal that does not distinguish "outside
    /// the project" from "not there".
    ///
    /// **The filter is applied before the lookup rather than after it.**
    /// `restore` and `purge` do not take an item and check it; they search the
    /// *already scoped* list — this function — for the id they were given. An id
    /// belonging to something outside the project is simply not found, which is
    /// what makes the scoping a boundary rather than a suggestion.
    ///
    /// That conflation is deliberate. Saying "that item exists but is out of
    /// scope" would confirm the existence of a file outside the project to a
    /// caller that is not allowed to touch it, and there is nothing useful it
    /// could do with the answer.
    pub fn find(root: &Path, id: &str) -> Result<trash::TrashItem, RpcError> {
        scoped(root)?
            .into_iter()
            .find(|item| item.id.to_string_lossy() == id)
            .ok_or_else(|| {
                RpcError::new(
                    INVALID_PARAMS,
                    "that item is not in this project's Recycle Bin — it may have been restored, \
                     purged, or emptied since the list was read",
                )
            })
    }

    /// What one item looks like on the wire.
    ///
    /// `size` is `null` for a directory: the crate reports a folder's size as an
    /// entry count rather than bytes, and squeezing both into one number would
    /// make "size" mean two things. `entries` carries the other case.
    pub fn describe(item: &trash::TrashItem) -> Value {
        let (size, entries) = match os_limited::metadata(item).map(|m| m.size) {
            Ok(trash::TrashItemSize::Bytes(bytes)) => (Some(bytes), None),
            Ok(trash::TrashItemSize::Entries(count)) => (None, Some(count)),
            // Metadata is a second call into the shell and can fail on its own.
            // An item that cannot be measured is still an item worth listing and
            // still restorable, so this reports the fact rather than the failure.
            Err(_) => (None, None),
        };

        json!({
            "id": item.id.to_string_lossy(),
            "name": item.name.to_string_lossy(),
            "originalPath": item.original_path().display().to_string(),
            "originalParent": item.original_parent.display().to_string(),
            // Seconds from the crate, milliseconds on the wire — every other
            // time in this app's protocol is epoch milliseconds, and one field
            // in different units is the kind of thing nobody notices until a
            // date renders in 1970.
            "deletedUnixMs": item.time_deleted.saturating_mul(1000),
            "size": size,
            "entries": entries,
        })
    }

    pub fn restore_one(root: &Path, id: &str) -> Result<Value, RpcError> {
        let item = find(root, id)?;
        let target = item.original_path();

        // Checked before asking the shell, so the message is ours and precise.
        // The crate refuses a collision on its own — `Error::RestoreCollision` —
        // and this only exists so the reason reads like a sentence rather than
        // like a COM error.
        if target.exists() {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!(
                    "{} already exists, so restoring would overwrite it",
                    target.display()
                ),
            ));
        }

        // A restore into a folder that has since been deleted is **refused**,
        // not silently recreated. Recreating the parent would invent directories
        // the user never asked for, and it would do so on the path where they
        // are least expecting side effects; a refusal that names the missing
        // folder lets them recreate it deliberately and try again.
        if let Some(parent) = target.parent() {
            if !parent.is_dir() {
                return Err(RpcError::new(
                    INVALID_PARAMS,
                    format!(
                        "{} no longer exists, so there is nowhere to restore {} to — recreate the \
                         folder first",
                        parent.display(),
                        item.name.to_string_lossy()
                    ),
                ));
            }
        }

        let name = item.name.to_string_lossy().into_owned();
        os_limited::restore_all([item])
            .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not restore {name}: {e}")))?;

        Ok(json!({
            "path": target.display().to_string(),
            "name": name,
        }))
    }

    pub fn purge_one(root: &Path, id: &str) -> Result<Value, RpcError> {
        let item = find(root, id)?;
        let name = item.name.to_string_lossy().into_owned();
        let path = item.original_path().display().to_string();

        os_limited::purge_all([item])
            .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not purge {name}: {e}")))?;

        Ok(json!({ "name": name, "originalPath": path }))
    }
}

/// The same three entry points on a platform with no enumerable trash.
///
/// macOS has no API to list or restore from its Trash, so the honest answer is a
/// refusal that says why rather than an empty list — an empty list would claim
/// the project has nothing deleted, which is a different and false statement.
#[cfg(not(any(
    target_os = "windows",
    all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    )
)))]
mod platform {
    use super::*;

    fn unsupported<T>() -> Result<T, RpcError> {
        Err(RpcError::new(
            INTERNAL_ERROR,
            "this platform provides no way to list or restore items from the trash",
        ))
    }

    pub fn scoped(_root: &Path) -> Result<Vec<()>, RpcError> {
        unsupported()
    }
    pub fn restore_one(_root: &Path, _id: &str) -> Result<Value, RpcError> {
        unsupported()
    }
    pub fn purge_one(_root: &Path, _id: &str) -> Result<Value, RpcError> {
        unsupported()
    }
}

/// Everything this project has deleted, newest first.
///
/// Sorted here rather than in the frontend for the reason `files/list` gives
/// about its own ordering: the crate documents its result as unordered, every
/// caller wants the same order, and a second sort in another language is a
/// second thing that can disagree.
#[cfg(any(
    target_os = "windows",
    all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    )
))]
fn list(app: &AppHandle, context: &CallContext) -> Result<Value, RpcError> {
    let root = scope_root(app, context)?;
    let mut items = platform::scoped(&root)?;
    items.sort_by_key(|item| std::cmp::Reverse(item.time_deleted));

    Ok(json!({
        "root": root.display().to_string(),
        "items": items.iter().map(platform::describe).collect::<Vec<_>>(),
    }))
}

#[cfg(not(any(
    target_os = "windows",
    all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    )
)))]
fn list(_app: &AppHandle, _context: &CallContext) -> Result<Value, RpcError> {
    Err(RpcError::new(
        INTERNAL_ERROR,
        "this platform provides no way to list or restore items from the trash",
    ))
}

/// Put one item back where it came from. Refuses rather than overwriting.
fn restore(
    app: &AppHandle,
    context: &CallContext,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    let root = scope_root(app, context)?;
    platform::restore_one(&root, &required_id(params)?)
}

/// Destroy one item for good. There is no recovering from this one.
fn purge(
    app: &AppHandle,
    context: &CallContext,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    let root = scope_root(app, context)?;
    platform::purge_one(&root, &required_id(params)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scoping predicate, which is the security-relevant line in this
    /// module. Everything else is plumbing around it.
    #[test]
    fn scoping_accepts_only_paths_inside_the_project() {
        let root = Path::new(r"C:\games\aurora");

        assert!(is_inside(Path::new(r"C:\games\aurora\src\main.rs"), root));
        assert!(is_inside(Path::new(r"C:\games\aurora\notes.md"), root));

        assert!(
            !is_inside(Path::new(r"C:\games\other\notes.md"), root),
            "a different project is out of scope"
        );
        assert!(
            !is_inside(Path::new(r"C:\Users\bjsea\taxes.pdf"), root),
            "the user's personal files are the whole reason this filter exists"
        );
    }

    /// The near-miss that a plain `starts_with` on strings would get wrong, and
    /// the reason this uses `Path::strip_prefix` rather than string matching:
    /// `aurora-old` shares a textual prefix with `aurora` but is a different
    /// directory, and a purge reaching into it would be this tool destroying
    /// files from a project the user is not in.
    #[test]
    fn scoping_does_not_match_a_sibling_with_a_shared_prefix() {
        let root = Path::new(r"C:\games\aurora");

        assert!(!is_inside(Path::new(r"C:\games\aurora-old\notes.md"), root));
        assert!(!is_inside(Path::new(r"C:\games\aurora2\notes.md"), root));
    }

    #[test]
    fn the_root_itself_is_inside_the_root() {
        let root = Path::new(r"C:\games\aurora");
        assert!(is_inside(root, root));
    }
}
