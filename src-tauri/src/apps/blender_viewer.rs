//! The Blender Viewer's Rust half.
//!
//! `docs/KAAVA-UX-REWORK.md` §3.1-3.2: Blender is never embedded either. An
//! agent runs it headless (`blender -b`), exports a `.glb`, and this viewer
//! loads *that export* — orbit it, select a part, look at its renders — never
//! the live `.blend`. There is no exporter and no render pipeline behind this
//! build, so `blender-viewer/state` reports no model and no renders until one
//! actually exists, and the frontend draws an honest empty viewport rather than
//! a placeholder mesh.
//!
//! Comments anchored to a mesh part and its material (`docs/KAAVA-UX-REWORK.md`
//! §3.4) go through [`crate::comments`], shared with every other viewer.

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

/// [`call`] minus the unused `AppHandle` — see `godot_viewer::dispatch` for why
/// this split exists.
fn dispatch(context: &CallContext, method: &str, params: Option<Value>) -> Result<Value, RpcError> {
    if let Some(result) = crate::comments::call(context, method, params.as_ref()) {
        return result;
    }

    match method {
        "blender-viewer/state" => Ok(state()),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

/// No `.glb` has ever been exported into this environment, so there is no
/// model, no part list and no render strip to report — `null`/`[]` rather than
/// a placeholder, on the same reasoning `godot_viewer::state` documents.
fn state() -> Value {
    json!({
        "model": Value::Null,
        "parts": Vec::<Value>::new(),
        "renders": Vec::<Value>::new(),
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
    fn state_reports_no_model_until_an_export_exists() {
        let env = TempDir::new().expect("tempdir");
        let value = dispatch(&context(env.path()), "blender-viewer/state", None).expect("state");

        assert_eq!(value["model"], Value::Null);
        assert_eq!(value["parts"], json!([]));
        assert_eq!(value["renders"], json!([]));
    }

    #[test]
    fn an_unknown_method_is_method_not_found() {
        let env = TempDir::new().expect("tempdir");
        let err = dispatch(&context(env.path()), "blender-viewer/nope", None)
            .expect_err("unknown method");
        assert_eq!(err.code, kaava_rpc::METHOD_NOT_FOUND);
    }

    #[test]
    fn comment_methods_are_answered_by_the_shared_comments_store() {
        let env = TempDir::new().expect("tempdir");
        let params = json!({
            "anchor": { "kind": "mesh", "part": "headboard", "material": "oak" },
            "body": "make this thinner",
        });
        let created = dispatch(&context(env.path()), "comments/create", Some(params))
            .expect("create");
        assert_eq!(created["anchor"]["kind"], "mesh");

        let listed = dispatch(&context(env.path()), "comments/list", None).expect("list");
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
    }
}
