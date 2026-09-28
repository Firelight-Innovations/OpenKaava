//! The Godot Viewer's Rust half.
//!
//! `docs/KAAVA-UX-REWORK.md` §3.1 is the rule this app exists to honour: Godot
//! is never embedded, an agent runs it headless (`godot --headless`) in a
//! terminal tab, and this viewer only ever shows what that run last produced —
//! the scene tree plus a viewport render, both read-only, both stamped with how
//! old they are. Nothing on this side of the bridge runs Godot or watches a
//! terminal for one finishing; that runner does not exist yet. `godot-viewer/state`
//! is honest about that rather than inventing a scene: it answers with no
//! render and an empty tree until something real writes one, and the frontend
//! draws that as "No headless render yet" rather than as a failure.
//!
//! Comments anchored to a node (`docs/KAAVA-UX-REWORK.md` §3.4) are the one
//! real, working part of this module — see [`crate::comments`], which every
//! viewer app shares.

use crate::apps::CallContext;
use kaava_rpc::{RpcError, METHOD_NOT_FOUND};
use serde_json::{json, Value};
use tauri::AppHandle;

pub fn call(
    _app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    dispatch(context, method, params)
}

/// [`call`] minus the `AppHandle` it never uses — split out so the tests below
/// can exercise the real dispatch without needing a live Tauri app, the same
/// reason `trash.rs`'s tests only ever reach for its `AppHandle`-free helpers.
fn dispatch(context: &CallContext, method: &str, params: Option<Value>) -> Result<Value, RpcError> {
    if let Some(result) = crate::comments::call(context, method, params.as_ref()) {
        return result;
    }

    match method {
        "godot-viewer/state" => Ok(state()),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

/// Always the same honest-empty answer today: no headless run has ever
/// written a render into this environment, so there is no age to report and no
/// tree to draw. `renderedAt` and `scenePath` are `null`, not omitted, so the
/// frontend's type does not have to distinguish "absent" from "not yet known" —
/// there is only one reason either field would ever be missing.
fn state() -> Value {
    json!({
        "renderedAt": Value::Null,
        "scenePath": Value::Null,
        "nodes": Vec::<Value>::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn context(root: &std::path::Path) -> CallContext {
        CallContext {
            cluster_id: Some("c1".to_string()),
            project: Some(root.to_path_buf()),
        }
    }

    #[test]
    fn state_reports_no_render_and_no_nodes_until_a_headless_run_exists() {
        let env = TempDir::new().expect("tempdir");
        let value = dispatch(&context(env.path()), "godot-viewer/state", None).expect("state");

        assert_eq!(value["renderedAt"], Value::Null);
        assert_eq!(value["scenePath"], Value::Null);
        assert_eq!(value["nodes"], json!([]));
    }

    #[test]
    fn an_unknown_method_is_method_not_found() {
        let env = TempDir::new().expect("tempdir");
        let err =
            dispatch(&context(env.path()), "godot-viewer/nope", None).expect_err("unknown method");
        assert_eq!(err.code, kaava_rpc::METHOD_NOT_FOUND);
    }

    /// The one method this app does not answer itself: it falls through to the
    /// comments store every other viewer shares, proving the two modules are
    /// wired together rather than each holding its own copy.
    #[test]
    fn comment_methods_are_answered_by_the_shared_comments_store() {
        let env = TempDir::new().expect("tempdir");
        let params = json!({
            "anchor": { "kind": "node", "path": "Player/Flashlight" },
            "body": "brighten this",
        });
        let created =
            dispatch(&context(env.path()), "comments/create", Some(params)).expect("create");
        assert_eq!(created["anchor"]["kind"], "node");

        let listed = dispatch(&context(env.path()), "comments/list", None).expect("list");
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
    }
}
