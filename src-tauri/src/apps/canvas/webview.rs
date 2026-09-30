//! The work only the canvas frontend can do: drawing a frame to pixels,
//! measuring text in the real fonts, and turning Mermaid into shapes.
//!
//! Each of those needs Excalidraw and its fonts, which live in the webview.
//! Rust owns the file, so it sends the scene *to* an open canvas frontend
//! (whichever one answers, since the scene travels with the request), takes the
//! answer back and does the writing itself. The frontend never writes on an
//! agent's behalf, so a save is always the same atomic, stale-checked write.
//!
//! Rejected: rendering in Rust (resvg over an SVG export). Excalidraw's SVG
//! export is itself a frontend function, the hand-drawn strokes come from
//! rough.js, and a second renderer would draw a picture that differs from the
//! one a person sees, which defeats the point of an agent looking at it.
//!
//! When no canvas frontend is loaded anywhere the call fails with
//! `kind: "canvas-not-open"` and says how to open one, rather than pretending.

use kaava_rpc::{RpcError, INTERNAL_ERROR};
use serde_json::{json, Value};

/// Something that can run one canvas frontend operation.
///
/// A trait so the methods that need a webview are tested with a fake one.
pub trait Webview {
    /// Run `op` with `payload` in a canvas frontend. `canvas` names the canvas
    /// that must be the open one, for operations about the editor's own state
    /// (`flush`); `None` accepts any canvas frontend.
    fn run(&self, op: &str, payload: &Value, canvas: Option<&str>) -> Result<Value, RpcError>;
}

/// The error every webview-backed method returns when nothing can answer.
pub fn not_open() -> RpcError {
    RpcError::with_data(
        INTERNAL_ERROR,
        "no Canvas app is open in OpenKaava, and rendering and text measurement run inside it. \
         Open one with the agent server's open_app {\"appId\":\"canvas\"} (or ask the person to \
         open Canvas), then call this again.",
        json!({ "kind": "canvas-not-open", "openWith": { "tool": "open_app", "appId": "canvas" } }),
    )
}

/// A webview that is never there: what the pure [`super::call`] uses.
pub struct Absent;

impl Webview for Absent {
    fn run(&self, _: &str, _: &Value, _: Option<&str>) -> Result<Value, RpcError> {
        Err(not_open())
    }
}

/// The real one: evaluates in every shell window until a canvas frontend
/// answers. Must not be called on the main thread (see `devtools::call`).
pub struct Live<'a> {
    pub app: &'a tauri::AppHandle,
}

impl Webview for Live<'_> {
    fn run(&self, op: &str, payload: &Value, canvas: Option<&str>) -> Result<Value, RpcError> {
        let expression = script(op, payload, canvas);
        let mut last_error = None;
        for label in crate::devtools::window_labels(self.app) {
            let answered = match crate::devtools::call(
                self.app,
                Some(&label),
                "Runtime.evaluate",
                &json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            ) {
                Ok(v) => v,
                Err(e) => {
                    last_error = Some(e.message());
                    continue;
                }
            };
            if let Some(thrown) = answered.get("exceptionDetails") {
                let text = thrown
                    .pointer("/exception/description")
                    .and_then(Value::as_str)
                    .unwrap_or("the page threw");
                return Err(RpcError::new(INTERNAL_ERROR, text.to_string()));
            }
            let text = answered
                .pointer("/result/value")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let reply: Value = serde_json::from_str(text).map_err(|e| {
                RpcError::new(INTERNAL_ERROR, format!("the canvas answered badly: {e}"))
            })?;
            if let Some(result) = interpret(reply)? {
                return Ok(result);
            }
        }
        match last_error {
            Some(why) if canvas.is_none() => Err(RpcError::with_data(
                INTERNAL_ERROR,
                format!("could not reach the window to look for a canvas: {why}"),
                json!({ "kind": "canvas-not-open" }),
            )),
            _ => Err(not_open()),
        }
    }
}

/// What one window's answer means: a result, "not here", or a failure.
pub fn interpret(reply: Value) -> Result<Option<Value>, RpcError> {
    if reply.get("found").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(Some(reply.get("value").cloned().unwrap_or(Value::Null)));
    }
    let error = reply
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("the canvas frontend failed without saying why");
    Err(RpcError::new(
        INTERNAL_ERROR,
        format!("canvas frontend: {error}"),
    ))
}

/// The page-side half. It looks for `__kaavaCanvas` in the window and every
/// same-origin iframe beneath it, prefers the one showing `canvas`, and runs
/// the operation there. Arguments are JSON-encoded, never spliced as code.
pub fn script(op: &str, payload: &Value, canvas: Option<&str>) -> String {
    let argument = json!({ "op": op, "payload": payload, "canvas": canvas });
    format!(
        r#"(async () => {{
const argument = {argument};
const hosts = [];
const visit = (w, depth) => {{
  try {{
    if (w.__kaavaCanvas) hosts.push(w.__kaavaCanvas);
    if (depth > 3) return;
    for (const f of w.document.querySelectorAll('iframe')) {{
      try {{ if (f.contentWindow) visit(f.contentWindow, depth + 1); }} catch (e) {{}}
    }}
  }} catch (e) {{}}
}};
visit(window, 0);
let host = hosts[0];
if (argument.canvas) {{
  host = hosts.find((h) => {{ try {{ return h.currentId() === argument.canvas; }} catch (e) {{ return false; }} }});
}}
if (!host) return JSON.stringify({{ found: false }});
try {{
  const value = await host.run(argument.op, argument.payload);
  return JSON.stringify({{ found: true, ok: true, value }});
}} catch (e) {{
  return JSON.stringify({{ found: true, ok: false, error: String((e && e.message) || e) }});
}}
}})()"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_found_is_not_an_answer() {
        assert_eq!(interpret(json!({ "found": false })).unwrap(), None);
        assert_eq!(interpret(json!({})).unwrap(), None);
    }

    #[test]
    fn a_found_host_answers_or_fails_with_its_reason() {
        let ok = interpret(json!({ "found": true, "ok": true, "value": { "a": 1 } })).unwrap();
        assert_eq!(ok, Some(json!({ "a": 1 })));
        let err = interpret(json!({ "found": true, "ok": false, "error": "no frame" })).unwrap_err();
        assert!(err.message.contains("no frame"));
    }

    #[test]
    fn the_absent_webview_says_how_to_open_a_canvas() {
        let err = Absent.run("render", &json!({}), None).unwrap_err();
        assert_eq!(err.data.as_ref().unwrap()["kind"], "canvas-not-open");
        assert!(err.message.contains("open_app"));
    }

    #[test]
    fn the_script_carries_arguments_as_json_not_code() {
        let js = script("render", &json!({ "title": "a\"); alert(1); //" }), Some("x"));
        assert!(js.contains(r#"\"); alert(1); //"#));
        assert!(js.contains(r#""canvas":"x""#));
    }
}
