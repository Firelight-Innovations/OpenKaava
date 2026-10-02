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

    /// Run a pure operation (render, layout, Mermaid) on the scene of canvas
    /// `canvas`, which travels in `payload`. The Rust side owns that file, so the
    /// frontend is only an engine for fonts and Excalidraw: any canvas pane gives the
    /// same answer. A pane showing `canvas` is preferred, since its fonts and theme
    /// are the ones a person sees for it; with several canvases open the call never
    /// lands on a different canvas's *file*, only possibly on its pane. If no
    /// canvas pane is open anywhere the error names `canvas` and says to open it.
    fn run_for(&self, op: &str, payload: &Value, canvas: &str) -> Result<Value, RpcError> {
        self.run(op, payload, None)
            .map_err(|e| name_canvas(e, canvas))
    }

    /// A setting's current text, or `None` where there is no registry to ask (the
    /// tests). A canvas with no override draws with the settings, so this is how
    /// the methods reach them without holding an app handle of their own.
    fn setting(&self, _key: &str) -> Option<String> {
        None
    }
}

/// `err`, when it is "no canvas is open", rewritten to name the canvas that was asked for.
pub fn name_canvas(err: RpcError, canvas: &str) -> RpcError {
    if err
        .data
        .as_ref()
        .is_none_or(|d| d["kind"] != "canvas-not-open")
    {
        return err;
    }
    RpcError::with_data(
        INTERNAL_ERROR,
        format!(
            "canvas `{canvas}` cannot be drawn: no Canvas pane is open in OpenKaava, and \
             rendering and text measurement run inside one. Open a Canvas pane (the agent \
             server's open_app {{\"appId\":\"canvas\"}}, or ask the person to), ideally showing \
             `{canvas}`, then call this again."
        ),
        json!({ "kind": "canvas-not-open", "canvas": canvas,
                "openWith": { "tool": "open_app", "appId": "canvas" } }),
    )
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
#[cfg(test)]
pub struct Absent;

#[cfg(test)]
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
    fn setting(&self, key: &str) -> Option<String> {
        Some(crate::settings::text(self.app, key)).filter(|s| !s.is_empty())
    }

    fn run(&self, op: &str, payload: &Value, canvas: Option<&str>) -> Result<Value, RpcError> {
        self.evaluate(op, payload, canvas, true)
    }

    fn run_for(&self, op: &str, payload: &Value, canvas: &str) -> Result<Value, RpcError> {
        // Two passes over every window: first the pane showing `canvas`, wherever it
        // is, then any canvas pane.
        let own = self.evaluate(op, payload, Some(canvas), true);
        let missing = own.as_ref().is_err_and(|e| {
            e.data
                .as_ref()
                .is_some_and(|d| d["kind"] == "canvas-not-open")
        });
        if !missing {
            return own;
        }
        self.evaluate(op, payload, Some(canvas), false)
            .map_err(|e| name_canvas(e, canvas))
    }
}

impl Live<'_> {
    /// Ask each window in turn. `strict` insists on a pane showing `canvas`;
    /// otherwise that pane is preferred and any canvas pane will do.
    fn evaluate(
        &self,
        op: &str,
        payload: &Value,
        canvas: Option<&str>,
        strict: bool,
    ) -> Result<Value, RpcError> {
        let expression = script_with(op, payload, canvas, strict);
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
#[cfg(test)]
pub fn script(op: &str, payload: &Value, canvas: Option<&str>) -> String {
    script_with(op, payload, canvas, true)
}

/// [`script`], where `strict: false` falls back to the first canvas pane when none
/// shows `canvas`, instead of reporting "not here".
pub fn script_with(op: &str, payload: &Value, canvas: Option<&str>, strict: bool) -> String {
    let argument = json!({ "op": op, "payload": payload, "canvas": canvas, "strict": strict });
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
  const own = hosts.find((h) => {{ try {{ return h.currentId() === argument.canvas; }} catch (e) {{ return false; }} }});
  host = argument.strict ? own : (own || hosts[0]);
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
        let err =
            interpret(json!({ "found": true, "ok": false, "error": "no frame" })).unwrap_err();
        assert!(err.message.contains("no frame"));
    }

    #[test]
    fn the_absent_webview_says_how_to_open_a_canvas() {
        let err = Absent.run("render", &json!({}), None).unwrap_err();
        assert_eq!(err.data.as_ref().unwrap()["kind"], "canvas-not-open");
        assert!(err.message.contains("open_app"));
    }

    #[test]
    fn a_preferred_canvas_falls_back_to_any_pane_only_when_not_strict() {
        let strict = script_with("render", &json!({}), Some("x"), true);
        let loose = script_with("render", &json!({}), Some("x"), false);
        assert!(strict.contains(r#""strict":true"#));
        assert!(loose.contains(r#""strict":false"#));
        assert!(loose.contains("own || hosts[0]"));
    }

    #[test]
    fn the_no_pane_error_names_the_canvas_and_leaves_other_errors_alone() {
        let named = name_canvas(not_open(), "levels/one");
        assert!(named.message.contains("`levels/one`"), "{}", named.message);
        assert_eq!(named.data.as_ref().unwrap()["canvas"], "levels/one");
        let other = RpcError::new(INTERNAL_ERROR, "canvas frontend: boom");
        assert_eq!(name_canvas(other, "x").message, "canvas frontend: boom");
    }

    #[test]
    fn the_script_carries_arguments_as_json_not_code() {
        let js = script(
            "render",
            &json!({ "title": "a\"); alert(1); //" }),
            Some("x"),
        );
        assert!(js.contains(r#"\"); alert(1); //"#));
        assert!(js.contains(r#""canvas":"x""#));
    }
}
