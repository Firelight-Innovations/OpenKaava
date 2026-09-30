//! The Godot Viewer's Rust half.
//!
//! `docs/KAAVA-UX-REWORK.md` §3.1 is the rule this app honours: Godot is never
//! embedded. Refreshing runs `godot --headless` as a child process, reads the
//! scene tree it dumps, optionally renders one frame, and caches both under
//! `.kaava/` stamped with their age. The work lives in [`crate::godot`]; this
//! module routes `godot-viewer/*` and `godot/*` there and hands node-anchored
//! comments (`docs/KAAVA-UX-REWORK.md` §3.4) to [`crate::comments`].

use crate::apps::CallContext;
use kaava_rpc::{RpcError, METHOD_NOT_FOUND};
use serde_json::Value;
use tauri::AppHandle;

pub fn call(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    if let Some(result) = crate::comments::call(context, method, params.as_ref()) {
        return result;
    }
    crate::godot::rpc::with_live(app, context, |ctx| {
        crate::godot::rpc::viewer(ctx, method, params.as_ref())
    })
    .unwrap_or_else(|| {
        Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn context(root: &std::path::Path) -> CallContext {
        CallContext {
            cluster_id: Some("c1".to_string()),
            project: Some(root.to_path_buf()),
        }
    }

    /// Comments need no `AppHandle`, so they are testable here; the Godot
    /// methods are tested in `godot::rpc` against a fake executable.
    #[test]
    fn comment_methods_are_answered_by_the_shared_comments_store() {
        let env = TempDir::new().expect("tempdir");
        let params = json!({
            "anchor": { "kind": "node", "path": "Player/Flashlight" },
            "body": "brighten this",
        });
        let created = crate::comments::call(&context(env.path()), "comments/create", Some(&params))
            .expect("handled")
            .expect("create");
        assert_eq!(created["anchor"]["kind"], "node");

        let listed = crate::comments::call(&context(env.path()), "comments/list", None)
            .expect("handled")
            .expect("list");
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
    }
}
