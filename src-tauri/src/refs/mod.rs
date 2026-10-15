//! `kaava://` references: one way for a person and an agent to point at the
//! same file, asset, canvas frame, comment or context item.
//!
//! `docs/design/KAAVA-CONTEXT-REFS.md` is the long form. In short:
//!
//! ```text
//! kaava://file/<path>[#L10-L20]        a file or asset, relative to the cluster's root
//! kaava://canvas/<id>[#frame=<id>]     a canvas, or one frame on it
//! kaava://canvas/<id>#comment=<id>     a comment on a canvas
//! kaava://comment/<id>                 a viewer comment and its screenshot
//! kaava://design-comment/<id>          a Design Mode comment and its screenshot
//! kaava://context/<id>                 an item in the context store
//! kaava://selection                    what is selected in the cluster's panes
//! ```
//!
//! A reference resolves inside the cluster it is resolved for. Design Mode
//! comments are the one exception: they belong to the running app.

pub mod assets;
pub mod comments;
pub mod live;
pub mod policy;
pub mod resolve;
pub mod search;
pub mod uri;

use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};
use serde_json::Value;
use tauri::AppHandle;

/// `refs/resolve {uri}` → [`resolve::Resolved`]: what the agent tab draws for
/// a reference chip or a `show` card. Answered as the person, who is the one
/// looking.
pub const RESOLVE_METHOD: &str = "refs/resolve";

/// Whether the host answers `method` here rather than an app.
pub fn is_method(method: &str) -> bool {
    method.starts_with("refs/")
}

/// Answer a `refs/*` method from app `caller` for the cluster in `ctx`.
pub fn call(
    app: &AppHandle,
    ctx: &crate::apps::CallContext,
    caller: &str,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    admit(caller)?;
    match method {
        RESOLVE_METHOD => {
            let r = uri_param(params.as_ref())?;
            let resolved = live::resolve(app, ctx, live::Actor::Human, &r)
                .map_err(|e| RpcError::new(INVALID_PARAMS, e))?;
            serde_json::to_value(resolved).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
        }
        other => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("there is no reference method `{other}`"),
        )),
    }
}

/// Only Kaava's own apps resolve references. A plugin is someone else's code,
/// and a reference reads the project.
fn admit(caller: &str) -> Result<(), RpcError> {
    if crate::apps::is_app(caller) {
        return Ok(());
    }
    Err(RpcError::new(
        METHOD_NOT_FOUND,
        format!("`refs/*` answers Kaava's own apps only, not `{caller}`"),
    ))
}

/// The `uri` parameter, parsed.
fn uri_param(params: Option<&Value>) -> Result<uri::Ref, RpcError> {
    let raw = params
        .and_then(|p| p.get("uri"))
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "`uri` is required"))?;
    uri::parse(raw).map_err(|e| RpcError::new(INVALID_PARAMS, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_refs_methods_are_answered_here() {
        assert!(is_method(RESOLVE_METHOD));
        assert!(!is_method("context/get"));
        assert!(!is_method("refsx/resolve"));
    }

    #[test]
    fn only_kaavas_own_apps_are_answered() {
        assert!(admit("agent-tab").is_ok());
        assert!(admit("canvas").is_ok());
        for stranger in ["acme.tools/panel", "", "agent-tab "] {
            assert_eq!(
                admit(stranger).unwrap_err().code,
                METHOD_NOT_FOUND,
                "{stranger:?}"
            );
        }
    }

    #[test]
    fn a_resolve_call_needs_a_uri_that_parses() {
        assert!(uri_param(None).is_err());
        assert!(uri_param(Some(&json!({ "uri": 7 }))).is_err());
        let escape = uri_param(Some(&json!({ "uri": "kaava://file/../secrets" })));
        assert_eq!(escape.unwrap_err().code, INVALID_PARAMS);
        let ok = uri_param(Some(&json!({ "uri": "kaava://selection" })));
        assert_eq!(ok.unwrap(), uri::Ref::Selection);
    }
}
