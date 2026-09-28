//! Play's Rust half.
//!
//! `docs/KAAVA-UX-REWORK.md` §3.3 and §9.2: Play runs the environment's debug
//! build in a pane — pause, restart, stop, and Capture & comment. §9.2 leaves
//! *how* an open question (a web export in the pane versus a native run whose
//! frames stream in), so nothing here starts a build or streams a frame; that
//! is a decision for whoever answers it, not a default this module should pick
//! on its own. `play/state` says there is no build running, honestly, rather
//! than guessing at one of the two designs.
//!
//! Comments anchored to a scene, a time and a screenshot
//! (`docs/KAAVA-UX-REWORK.md` §3.4) go through [`crate::comments`], shared with
//! every other viewer — the one part of Play that is real today.

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
        "play/state" => Ok(state()),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

/// Nothing is running today: there is no debug-build runner behind this build
/// (see the module doc), so `build` is `null` rather than a guess at what one
/// would look like.
fn state() -> Value {
    json!({
        "running": false,
        "build": Value::Null,
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
    fn state_reports_nothing_running_until_a_debug_build_runner_exists() {
        let env = TempDir::new().expect("tempdir");
        let value = dispatch(&context(env.path()), "play/state", None).expect("state");

        assert_eq!(value["running"], false);
        assert_eq!(value["build"], Value::Null);
    }

    #[test]
    fn an_unknown_method_is_method_not_found() {
        let env = TempDir::new().expect("tempdir");
        let err = dispatch(&context(env.path()), "play/nope", None).expect_err("unknown method");
        assert_eq!(err.code, kaava_rpc::METHOD_NOT_FOUND);
    }

    #[test]
    fn comment_methods_are_answered_by_the_shared_comments_store() {
        let env = TempDir::new().expect("tempdir");
        let params = json!({
            "anchor": { "kind": "scene", "scene": "hospital_wing", "time": 42.8 },
            "body": "why is the light flickering here?",
        });
        let created = dispatch(&context(env.path()), "comments/create", Some(params))
            .expect("create");
        assert_eq!(created["anchor"]["kind"], "scene");
        assert_eq!(created["anchor"]["screenshot"], false);

        let listed = dispatch(&context(env.path()), "comments/list", None).expect("list");
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
    }
}
