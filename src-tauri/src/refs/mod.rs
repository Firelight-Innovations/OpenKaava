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
pub mod fault;
#[cfg(test)]
pub mod links;
pub mod live;
pub mod policy;
pub mod prompt;
pub mod read;
pub mod resolve;
pub mod search;
pub mod uri;

use fault::{Fault, Reason};
use kaava_rpc::{RpcError, INTERNAL_ERROR, METHOD_NOT_FOUND};
use live::Actor;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

/// `refs/resolve` `{uri}` → [`resolve::Resolved`]: what the agent tab draws for
/// a reference chip or a `show` card. Answered as the person, who is the one
/// looking, as every `refs/*` method is.
pub const RESOLVE_METHOD: &str = "refs/resolve";
/// `refs/search` `{query?, kinds?, limit?}` → `{items}`: the @-mention
/// picker's matches, as `search_context` finds them.
pub const SEARCH_METHOD: &str = "refs/search";
/// `refs/prompt` `{uris, accepts?}` → `{blocks, failed?}`: a message's
/// references as the ACP content blocks to send after its text.
pub const PROMPT_METHOD: &str = "refs/prompt";

/// Every optional field is an `Option`, so `null` reads as absent.
#[derive(Debug, Deserialize)]
struct SearchParams {
    query: Option<String>,
    kinds: Option<Vec<String>>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct PromptParams {
    uris: Vec<String>,
    accepts: Option<prompt::Accepts>,
}

/// Whether the host answers `method` here rather than an app. Only the names
/// it implements: any other `refs/` method is the calling plugin's own.
pub fn is_method(method: &str) -> bool {
    matches!(method, RESOLVE_METHOD | SEARCH_METHOD | PROMPT_METHOD)
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
    // Spelt out, not the consts, so the MCP panel's method catalogue finds the
    // arms.
    match method {
        "refs/resolve" => {
            let r = uri_param(params.as_ref())?;
            let resolved = live::resolve(app, ctx, Actor::Human, &r).map_err(Fault::rpc)?;
            serde_json::to_value(resolved).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
        }
        "refs/search" => {
            let asked: SearchParams = parse_params(params)?;
            live::root_of(ctx).map_err(Fault::rpc)?;
            let query = asked.query.unwrap_or_default();
            let q = search::Query::new(&query, asked.kinds, asked.limit)
                .map_err(|why| Fault::new(Reason::BadParams, why).rpc())?;
            Ok(json!({ "items": search::run(app, ctx, Actor::Human, &q) }))
        }
        "refs/prompt" => {
            let asked: PromptParams = parse_params(params)?;
            check_count(asked.uris.len())?;
            live::root_of(ctx).map_err(Fault::rpc)?;
            let accepts = asked.accepts.unwrap_or_default();
            Ok(prompt::run(app, ctx, &asked.uris, accepts))
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

/// The `uri` parameter, parsed: `bad-params` when it is absent or not a
/// string, `bad-uri` when it does not parse.
fn uri_param(params: Option<&Value>) -> Result<uri::Ref, RpcError> {
    let raw = params
        .and_then(|p| p.get("uri"))
        .and_then(Value::as_str)
        .ok_or_else(|| Fault::new(Reason::BadParams, "`uri` is required").rpc())?;
    uri::parse(raw).map_err(|why| Fault::new(Reason::BadUri, why).rpc())
}

/// One to [`prompt::MAX_URIS`] references in a message.
fn check_count(n: usize) -> Result<(), RpcError> {
    if (1..=prompt::MAX_URIS).contains(&n) {
        return Ok(());
    }
    let why = format!("`uris` holds 1 to {} references, not {n}", prompt::MAX_URIS);
    Err(Fault::new(Reason::BadParams, why).rpc())
}

/// A method's parameters, an absent one read as `{}`. A missing or mistyped
/// field is `bad-params`, with serde's account of which.
fn parse_params<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    let given = params.unwrap_or_else(|| json!({}));
    serde_json::from_value(given).map_err(|e| Fault::new(Reason::BadParams, e.to_string()).rpc())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaava_rpc::INVALID_PARAMS;
    use serde_json::json;

    #[test]
    fn only_refs_methods_are_answered_here() {
        assert!(is_method(RESOLVE_METHOD));
        assert!(is_method(SEARCH_METHOD));
        assert!(is_method(PROMPT_METHOD));
        assert!(!is_method("context/get"));
        assert!(!is_method("refsx/resolve"));
        assert!(
            !is_method("refs/sync"),
            "a plugin's own refs/ method is its own"
        );
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
        let reason = |e: RpcError| e.data.unwrap()["reason"].clone();
        assert_eq!(reason(uri_param(None).unwrap_err()), "bad-params");
        assert_eq!(
            reason(uri_param(Some(&json!({ "uri": 7 }))).unwrap_err()),
            "bad-params"
        );
        let escape = uri_param(Some(&json!({ "uri": "kaava://file/../secrets" }))).unwrap_err();
        assert_eq!(escape.code, INVALID_PARAMS);
        assert_eq!(escape.data, Some(json!({ "reason": "bad-uri" })));
        let ok = uri_param(Some(&json!({ "uri": "kaava://selection" })));
        assert_eq!(ok.unwrap(), uri::Ref::Selection);
    }

    #[test]
    fn search_params_are_typed_and_default_to_everything() {
        let asked: SearchParams = parse_params(None).unwrap();
        assert_eq!((asked.query, asked.kinds, asked.limit), (None, None, None));
        let nulls = json!({ "query": null, "kinds": null, "limit": null });
        let asked: SearchParams = parse_params(Some(nulls)).unwrap();
        assert_eq!((asked.query, asked.kinds, asked.limit), (None, None, None));
        let asked: SearchParams = parse_params(Some(
            json!({ "query": "player", "kinds": ["file"], "limit": 5 }),
        ))
        .unwrap();
        assert_eq!(asked.query.as_deref(), Some("player"));
        assert_eq!(asked.kinds, Some(vec!["file".to_string()]));
        assert_eq!(asked.limit, Some(5));
        for bad in [
            json!({ "query": 7 }),
            json!({ "kinds": "file" }),
            json!({ "limit": -1 }),
        ] {
            let e = parse_params::<SearchParams>(Some(bad.clone())).unwrap_err();
            assert_eq!(e.code, INVALID_PARAMS, "{bad}");
            assert_eq!(e.data, Some(json!({ "reason": "bad-params" })), "{bad}");
        }
    }

    #[test]
    fn a_prompt_carries_one_to_sixteen_references_and_says_what_the_agent_takes() {
        assert!(
            parse_params::<PromptParams>(None).is_err(),
            "`uris` is required"
        );
        let asked: PromptParams =
            parse_params(Some(json!({ "uris": ["kaava://selection"] }))).unwrap();
        assert_eq!(asked.accepts, None);
        let asked: PromptParams = parse_params(Some(
            json!({ "uris": ["kaava://selection"], "accepts": null }),
        ))
        .unwrap();
        assert_eq!(asked.accepts, None);
        let asked: PromptParams = parse_params(Some(json!({
            "uris": [],
            "accepts": { "image": true, "embeddedContext": true },
        })))
        .unwrap();
        let accepts = asked.accepts.unwrap();
        assert!(accepts.image && accepts.embedded_context);
        assert!(check_count(1).is_ok() && check_count(prompt::MAX_URIS).is_ok());
        for n in [0, prompt::MAX_URIS + 1] {
            let e = check_count(n).unwrap_err();
            assert_eq!(e.data, Some(json!({ "reason": "bad-params" })), "{n}");
        }
    }
}
