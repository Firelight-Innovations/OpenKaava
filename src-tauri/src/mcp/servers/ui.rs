//! Seeing and driving the running interface, for the agent working on it.
//!
//! The debug server next door answers what OpenKaava *believes* — its layout tree,
//! its failures, how boot went. This one answers what is actually on screen, and
//! can act on it: a screenshot, a list of what can be clicked, and real mouse
//! and keyboard input into the window.
//!
//! **This is the one server that writes.** Everything else OpenKaava hosts is a
//! read, deliberately, so that a leaked token costs knowledge and not control.
//! A tool that clicks cannot be that, which is why this server is `dev_only`,
//! starts switched off even once developer mode reveals it, and says so on the
//! row that draws it.
//!
//! Why the protocol reaches the webview through COM rather than a debug port,
//! and what that buys: `docs/design-notes/agent-ui-driving.md`.
//!
//! **Prefer [`super::agent`]**, which hosts these eight by delegation next to the
//! shell reads and a line into any app's Rust half. This module stays
//! registered because the capability is its, its tests are what hold this code
//! to account, and a client wanting only input needs no fourteen tools.

use crate::devtools;
use crate::mcp::{McpServer, McpTool, ToolAnswer};
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};
use serde_json::{json, Value};
use tauri::AppHandle;

pub static SERVER: McpServer = McpServer {
    id: "ui",
    name: "UI",
    description: "See and drive the running window: screenshots, a list of what can be clicked, \
                  and real mouse and keyboard input.",
    tools: TOOLS,
    call,
    dev_only: true,
};

/// Up to this many characters, `type_text` sends real keystrokes.
///
/// Each character is a pair of protocol round trips, so a model pasting a file
/// would sit through thousands of them. Past this, the whole text goes in one
/// `Input.insertText`, which fires `input` events but no per-key ones.
const KEYSTROKE_LIMIT: usize = 500;

/// The most characters one `type_text` will send; anything past it is dropped
/// and the answer says how much.
const MAX_TEXT: usize = 200_000;

/// What `snapshot` looks at when it is not told otherwise.
const INTERACTIVE: &str = "button,a,input,textarea,select,[role=button],[role=menuitem],\
                           [role=tab],[contenteditable=true],[tabindex]";

/// Named keys, and the virtual key code each needs to register.
///
/// A printable character travels as `text` alone. These do not: the page reads
/// them from the key code, and one dispatched without it arrives as nothing at
/// all — no error, no keystroke, which is the worst of both.
const KEYS: &[(&str, u32, &str)] = &[
    ("Enter", 13, "\r"),
    ("Tab", 9, ""),
    ("Escape", 27, ""),
    ("Backspace", 8, ""),
    ("Delete", 46, ""),
    ("ArrowUp", 38, ""),
    ("ArrowDown", 40, ""),
    ("ArrowLeft", 37, ""),
    ("ArrowRight", 39, ""),
];

static TOOLS: &[McpTool] = &TOOL_LIST;

/// The same eight tools, as a const array the `agent` server can index.
///
/// A `const` beside the `static` rather than instead of it: `McpServer.tools`
/// needs a `&'static [McpTool]`, and a const array cannot be borrowed for one
/// without a static to anchor it. Naming the array is what lets
/// [`super::agent`] build its tool list out of these and `debug`'s three
/// without a second copy of any description.
pub(super) const TOOL_LIST: [McpTool; 8] = [
    McpTool {
        name: "screenshot",
        description: "A PNG of the OpenKaava window as it is drawn right now, app content \
                      included. This is how to see OpenKaava: it is a desktop app, not a web \
                      page, so a browser tool cannot reach it.",
        schema: window_only,
    },
    McpTool {
        name: "snapshot",
        description: "Every visible interactive element, each with a ref (`e0`, `e1`), a label \
                      and a position. Walks into app iframes, so app content is listed too. Refs \
                      are renumbered every call — take a fresh snapshot before clicking.",
        schema: snapshot_schema,
    },
    McpTool {
        name: "click",
        description: "Click a ref from the last snapshot, or any CSS selector. Dispatches real \
                      pointer events at the element's centre. Refuses a stale ref, an element \
                      with no size, or one covered by something else, and reports what has \
                      focus afterwards.",
        schema: target_schema,
    },
    McpTool {
        name: "type_text",
        description: "Type into the focused field inside OpenKaava's window. Refuses when \
                      nothing has focus, when focus is on something that takes no text, or \
                      when it is in a terminal. To set a field without clicking it first, use \
                      fill_field.",
        schema: text_schema,
    },
    McpTool {
        name: "fill_field",
        description: "Set a text field, text area, select or checkbox by its label or by a \
                      snapshot ref, in the shell or inside an app. Fires the input and change \
                      events a person's typing would, so React state follows.",
        schema: fill_schema,
    },
    McpTool {
        name: "context",
        description: "What the person (or the last click) is pointed at: the focused element, \
                      the pane instance holding it, the app's own report of its open file and \
                      selection, and any selected text.",
        schema: window_only,
    },
    McpTool {
        name: "press_key",
        description: "Press one named key: Enter, Tab, Escape, Backspace, Delete, or an arrow.",
        schema: key_schema,
    },
    McpTool {
        name: "eval",
        description: "Run JavaScript in the shell and return its result. The escape hatch for \
                      what the tools above do not cover. Note this reaches the whole backend \
                      through window.__TAURI__, so it can do considerably more than click.",
        schema: eval_schema,
    },
];

/// Every tool takes an optional window, and most take nothing else.
fn window_only() -> Value {
    json!({
        "type": "object",
        "properties": { "window": window_property() },
        "additionalProperties": false,
    })
}

fn window_property() -> Value {
    json!({
        "type": "string",
        "description": "Which window, by label. Defaults to the focused one. `shell_snapshot` \
                        on the debug server lists them.",
    })
}

fn snapshot_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "window": window_property(),
            "selector": {
                "type": "string",
                "description": "A CSS selector to list instead of the interactive default. Use \
                                it to narrow a long list, not to find one element.",
            },
        },
        "additionalProperties": false,
    })
}

fn target_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "window": window_property(),
            "target": {
                "type": "string",
                "description": "A ref from the last snapshot, like `e12`, or a CSS selector.",
            },
        },
        "required": ["target"],
        "additionalProperties": false,
    })
}

fn text_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "window": window_property(),
            "text": { "type": "string", "description": "What to type." },
        },
        "required": ["text"],
        "additionalProperties": false,
    })
}

fn fill_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "window": window_property(),
            "field": {
                "type": "string",
                "description": "A ref from the last snapshot, like `e12`, or the field's label: \
                                its aria-label, <label>, placeholder or name. An exact match \
                                wins over a partial one.",
            },
            "value": {
                "type": "string",
                "description": "The new value. For a select, an option's value or text; for a \
                                checkbox, `true` or `false`.",
            },
        },
        "required": ["field", "value"],
        "additionalProperties": false,
    })
}

fn key_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "window": window_property(),
            "key": {
                "type": "string",
                "enum": KEYS.iter().map(|(name, _, _)| *name).collect::<Vec<&str>>(),
            },
        },
        "required": ["key"],
        "additionalProperties": false,
    })
}

fn eval_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "window": window_property(),
            "expression": {
                "type": "string",
                "description": "A JavaScript expression. A promise is awaited before the result \
                                is returned.",
            },
        },
        "required": ["expression"],
        "additionalProperties": false,
    })
}

/// An unknown tool cannot arrive here — `Registry::call` checks the name against
/// `TOOLS` first — so the final arm is a genuine impossibility.
///
/// `pub(super)` so [`super::agent`] can hand its six borrowed tool names
/// straight through. Delegating rather than moving these handlers into the
/// unified server keeps this module's own tests testing the code that runs.
pub(super) fn call(
    app: &AppHandle,
    tool: &str,
    params: Option<Value>,
) -> Result<ToolAnswer, RpcError> {
    let params = params.unwrap_or(Value::Null);
    let window = params.get("window").and_then(Value::as_str);

    match tool {
        "screenshot" => screenshot(app, window),
        "snapshot" => {
            snapshot(app, window, params.get("selector").and_then(Value::as_str)).map(Into::into)
        }
        "click" => click(app, window, required(&params, "target")?).map(Into::into),
        "type_text" => type_text(app, window, required(&params, "text")?).map(Into::into),
        "fill_field" => fill_field(
            app,
            window,
            required(&params, "field")?,
            required(&params, "value")?,
        )
        .map(Into::into),
        "context" => in_page(app, window, CONTEXT_BODY, &Value::Null).map(Into::into),
        "press_key" => press_key(app, window, required(&params, "key")?).map(Into::into),
        "eval" => evaluate(app, window, required(&params, "expression")?).map(Into::into),
        other => Err(RpcError::new(
            kaava_rpc::METHOD_NOT_FOUND,
            format!("the UI server has no tool named `{other}`"),
        )),
    }
}

/// A string parameter the schema marks required, refused by name if it is not
/// there. The schema should have caught it; not every client enforces one.
fn required<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("`{name}` is required, as a string")))
}

fn screenshot(app: &AppHandle, window: Option<&str>) -> Result<ToolAnswer, RpcError> {
    let shot = protocol(
        app,
        window,
        "Page.captureScreenshot",
        &json!({ "format": "png" }),
    )?;

    let data = shot
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(INTERNAL_ERROR, "the capture came back with no image"))?;

    Ok(ToolAnswer::Image {
        mime: "image/png".to_string(),
        data: data.to_string(),
    })
}

/// What can be clicked, and where each thing is.
///
/// The positions are in the top-level window's coordinates, iframe offsets
/// already added, so a row can be handed to `click` without any further
/// arithmetic — and so `click` and `snapshot` cannot disagree about where
/// something is.
fn snapshot(
    app: &AppHandle,
    window: Option<&str>,
    selector: Option<&str>,
) -> Result<Value, RpcError> {
    let argument = selector.map_or(Value::Null, |s| Value::String(s.to_string()));
    let rows = in_page(app, window, SNAPSHOT_BODY, &argument)?;
    let count = rows.as_array().map_or(0, Vec::len);

    Ok(json!({
        "elements": rows,
        "count": count,
        "selector": selector.unwrap_or(INTERACTIVE),
        // Said out loud because refs look stable and are not. A model that keeps
        // one across two snapshots clicks whatever now holds that index.
        "note": "Refs are renumbered by every snapshot. Take a fresh one before clicking.",
    }))
}

/// Why the page's answer to `LOCATE_BODY` is not something to click, or `None`
/// when it is. Split out so every refusal is tested without a window.
///
/// Every input tool checks where it is about to land before it acts: `click`
/// refuses a stale ref, a zero-size box or an element something else covers,
/// and `type_text` refuses when focus is nowhere, on something that takes no
/// text, or in a terminal (most likely the agent's own). An agent that typed a
/// prompt into its own shell is the failure these checks were written after.
/// Rejected: trusting the caller to click first. The caller cannot see focus.
fn click_refusal(target: &str, found: &Value) -> Option<String> {
    let label = found.get("label").and_then(Value::as_str).unwrap_or("");
    match found.get("problem").and_then(Value::as_str) {
        Some("stale") => Some(format!(
            "`{target}` is a ref to an element that is no longer on the page. Refs go stale \
             when the page re-renders; take a fresh snapshot."
        )),
        Some("zero-size") => Some(format!(
            "`{target}` ({label}) has no size, so there is nothing to click. It is probably \
             hidden or collapsed; take a screenshot to see what is showing."
        )),
        Some("covered") => {
            let by = found
                .get("coveredBy")
                .and_then(Value::as_str)
                .unwrap_or("?");
            Some(format!(
                "`{target}` ({label}) is covered by {by} at its centre, so a click would land \
                 there instead. Close or move what is on top, then snapshot again."
            ))
        }
        Some(other) => Some(format!("`{target}` cannot be clicked: {other}")),
        None if found.get("x").and_then(Value::as_i64).is_none() => Some(format!(
            "nothing matched `{target}`. Refs go stale on every snapshot — take a fresh one, \
             or pass a CSS selector."
        )),
        None => None,
    }
}

fn click(app: &AppHandle, window: Option<&str>, target: &str) -> Result<Value, RpcError> {
    let found = in_page(app, window, LOCATE_BODY, &Value::String(target.to_string()))?;

    if let Some(why) = click_refusal(target, &found) {
        return Err(RpcError::new(INVALID_PARAMS, why));
    }
    let (Some(x), Some(y)) = (
        found.get("x").and_then(Value::as_i64),
        found.get("y").and_then(Value::as_i64),
    ) else {
        return Err(RpcError::new(INTERNAL_ERROR, "the page gave no position"));
    };

    // Move, press, release. `el.click()` would be one call instead of three and
    // would skip both the pointer events OpenKaava's menus and drag handles listen
    // for and the focus change a real press causes.
    protocol(
        app,
        window,
        "Input.dispatchMouseEvent",
        &json!({ "type": "mouseMoved", "x": x, "y": y }),
    )?;

    for phase in ["mousePressed", "mouseReleased"] {
        protocol(
            app,
            window,
            "Input.dispatchMouseEvent",
            &json!({
                "type": phase,
                "x": x,
                "y": y,
                "button": "left",
                "buttons": 1,
                "clickCount": 1,
            }),
        )?;
    }

    // A press on a focusable element should leave focus on it; one that did
    // not (a pointer-events trick, a handler calling blur) is focused here and
    // reported, so a `type_text` after it lands where the caller meant.
    let focus = in_page(app, window, FOCUS_BODY, &Value::Null)?;

    Ok(json!({
        "clicked": target,
        "label": found.get("label").cloned().unwrap_or(Value::Null),
        "at": { "x": x, "y": y },
        "focus": focus,
    }))
}

/// Why typing into the focused element would be wrong, or `None` when it is a
/// text field. Split out so every refusal is tested without a window.
fn type_refusal(focus: &Value) -> Option<String> {
    let what = focus
        .pointer("/target/label")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| focus.pointer("/target/tag").and_then(Value::as_str))
        .unwrap_or("it");
    match focus.get("problem").and_then(Value::as_str) {
        None => None,
        Some("nothing") => Some(
            "nothing in the OpenKaava window has focus, so there is nowhere to type. Click the \
             field first, or use fill_field to set it by label."
                .to_string(),
        ),
        Some("terminal") => Some(
            "focus is in a terminal, most likely the one running you. Typing there would run \
             as a command. Click the field you meant first, or use fill_field."
                .to_string(),
        ),
        Some("not-editable") => Some(format!(
            "focus is on {what}, which takes no text. Click a text field first, use fill_field, \
             or use press_key for a shortcut."
        )),
        Some(other) => Some(format!("cannot type here: {other}")),
    }
}

fn type_text(app: &AppHandle, window: Option<&str>, text: &str) -> Result<Value, RpcError> {
    let focus = in_page(app, window, TYPE_TARGET_BODY, &Value::Null)?;
    if let Some(why) = type_refusal(&focus) {
        return Err(RpcError::new(INVALID_PARAMS, why));
    }

    let total = text.chars().count();
    let sent: String = text.chars().take(MAX_TEXT).collect();
    let count = sent.chars().count();

    let method = if count <= KEYSTROKE_LIMIT {
        for character in sent.chars() {
            let text = character.to_string();
            for phase in ["keyDown", "keyUp"] {
                protocol(
                    app,
                    window,
                    "Input.dispatchKeyEvent",
                    &json!({ "type": phase, "text": text }),
                )?;
            }
        }
        "keystrokes"
    } else {
        protocol(app, window, "Input.insertText", &json!({ "text": sent }))?;
        "insertText"
    };

    Ok(json!({
        "typed": count,
        "method": method,
        "into": focus.get("target").cloned().unwrap_or(Value::Null),
        "truncated": total > count,
        "dropped": total - count,
    }))
}

/// Why the page's answer to `FILL_BODY` is a failure, or `None` on success.
fn fill_refusal(field: &str, answer: &Value) -> Option<String> {
    let list = |key: &str| {
        answer
            .get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default()
    };
    match answer.get("problem").and_then(Value::as_str) {
        None => None,
        Some("stale") => Some(format!(
            "`{field}` is a ref to an element that is no longer on the page; take a fresh \
             snapshot."
        )),
        Some("none") => Some(format!(
            "no visible field is labelled `{field}`. Fields on screen: {}",
            list("fields")
        )),
        Some("ambiguous") => Some(format!(
            "more than one field matches `{field}`: {}. Pass a snapshot ref instead.",
            list("matches")
        )),
        Some("not-a-field") => Some(format!("`{field}` is not a text field, select or checkbox")),
        Some("read-only") => Some(format!("`{field}` is disabled or read-only")),
        Some("terminal") => Some(format!(
            "`{field}` is inside a terminal; fill_field does not type into terminals"
        )),
        Some("no-option") => Some(format!(
            "that select has no such option. Options: {}",
            list("options")
        )),
        Some(other) => Some(format!("could not fill `{field}`: {other}")),
    }
}

fn fill_field(
    app: &AppHandle,
    window: Option<&str>,
    field: &str,
    value: &str,
) -> Result<Value, RpcError> {
    let answer = in_page(
        app,
        window,
        FILL_BODY,
        &json!({ "field": field, "value": value }),
    )?;
    if let Some(why) = fill_refusal(field, &answer) {
        return Err(RpcError::new(INVALID_PARAMS, why));
    }
    Ok(answer)
}

fn press_key(app: &AppHandle, window: Option<&str>, name: &str) -> Result<Value, RpcError> {
    let Some((key, code, text)) = KEYS.iter().find(|(known, _, _)| *known == name) else {
        let known: Vec<&str> = KEYS.iter().map(|(name, _, _)| *name).collect();
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("no key named `{name}`. Known: {}", known.join(", ")),
        ));
    };

    for phase in ["keyDown", "keyUp"] {
        let mut event = json!({
            "type": phase,
            "key": key,
            "windowsVirtualKeyCode": code,
            "nativeVirtualKeyCode": code,
        });

        // Only on the way down, and only for a key that produces a character.
        // Enter with `text` on the way up types a second newline.
        if !text.is_empty() && phase == "keyDown" {
            event["text"] = Value::String((*text).to_string());
        }

        protocol(app, window, "Input.dispatchKeyEvent", &event)?;
    }

    Ok(json!({ "pressed": key }))
}

/// Run an expression in the page and hand back what it produced.
pub(super) fn evaluate(
    app: &AppHandle,
    window: Option<&str>,
    expression: &str,
) -> Result<Value, RpcError> {
    let answered = protocol(
        app,
        window,
        "Runtime.evaluate",
        &json!({
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": true,
        }),
    )?;

    if let Some(thrown) = answered.get("exceptionDetails") {
        let text = thrown
            .pointer("/exception/description")
            .or_else(|| thrown.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("the page threw, without saying what");
        return Err(RpcError::new(INTERNAL_ERROR, text.to_string()));
    }

    Ok(answered
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null))
}

/// Run one of the bodies below in the page and parse the JSON it returns.
///
/// The scripts hand back a string rather than an object because CDP's own
/// serialisation of a deep object is lossy in ways that are hard to see — a
/// `JSON.stringify` on the page's side is one format both ends already agree
/// about.
fn in_page(
    app: &AppHandle,
    window: Option<&str>,
    body: &str,
    argument: &Value,
) -> Result<Value, RpcError> {
    let produced = evaluate(app, window, &script(body, argument))?;

    let Some(text) = produced.as_str() else {
        return Err(RpcError::new(
            INTERNAL_ERROR,
            "the page did not answer with JSON",
        ));
    };

    serde_json::from_str(text).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("the page's answer was not JSON: {e}"),
        )
    })
}

/// One protocol call, with its failure turned into something a model can act on.
fn protocol(
    app: &AppHandle,
    window: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    devtools::call(app, window, method, params)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e.message()))
}

/// Wrap a body in the helpers it needs and the argument it was given.
///
/// The argument is JSON-encoded rather than pasted in, so a selector containing
/// a quote is a selector rather than a syntax error.
pub(super) fn script(body: &str, argument: &Value) -> String {
    let mut js = String::from("(() => {\n");
    js.push_str(HELPERS);
    js.push_str("const argument = ");
    js.push_str(&argument.to_string());
    js.push_str(";\n");
    js.push_str(body);
    js.push_str("\n})()");
    js
}

/// Three things every body needs: reaching into app iframes, deciding what
/// counts as visible, and naming an element.
///
/// Apps mount as iframes on `tauri.localhost`, the same origin as the shell, so
/// `contentDocument` reads straight through and an agent sees app content rather
/// than the frame around it. The `try` is for a frame that is not ours.
const HELPERS: &str = r#"
const docs = () => {
  const out = [{ doc: document, dx: 0, dy: 0 }];
  for (const frame of document.querySelectorAll('iframe')) {
    let inner = null;
    try { inner = frame.contentDocument; } catch { inner = null; }
    if (!inner) continue;
    const box = frame.getBoundingClientRect();
    out.push({ doc: inner, dx: box.x, dy: box.y });
  }
  return out;
};
const shown = (el, doc) => {
  const style = (doc.defaultView || window).getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
};
const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || '')
  .replace(/\s+/g, ' ').trim().slice(0, 80);
const middle = (el, dx, dy) => {
  const box = el.getBoundingClientRect();
  return { x: Math.round(dx + box.x + box.width / 2), y: Math.round(dy + box.y + box.height / 2) };
};
const deepActive = () => {
  let doc = document, frame = null, el = document.activeElement;
  while (el && el.tagName === 'IFRAME') {
    let inner = null;
    try { inner = el.contentDocument; } catch { inner = null; }
    if (!inner) break;
    frame = el; doc = inner; el = inner.activeElement;
  }
  if (el === doc.body || el === doc.documentElement) el = null;
  return { el, doc, frame };
};
const editable = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' ||
  el.getAttribute('role') === 'textbox' || (el.tagName === 'INPUT' &&
  !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/i.test(el.type)));
const terminal = (el) => !!(el && el.closest && el.closest('.xterm'));
const describe = (el) => el ? { tag: el.tagName.toLowerCase(), label: name(el), id: el.id || null } : null;
const instanceOf = (el) => {
  const host = el && el.closest ? el.closest('[data-instance]') : null;
  return host ? host.getAttribute('data-instance') : null;
};
"#;

/// Refs are kept in an array on `window`, never as attributes on the elements.
///
/// A tool that marks up the DOM changes the thing it is there to observe, and a
/// stray `data-` attribute surviving into a screenshot or somebody's CSS selector
/// sends them chasing a bug that belongs to the tooling.
const SNAPSHOT_BODY: &str = r#"
const chosen = argument || 'button,a,input,textarea,select,[role=button],[role=menuitem],[role=tab],[contenteditable=true],[tabindex]';
const refs = [];
const rows = [];
for (const { doc, dx, dy } of docs()) {
  let matched = [];
  try { matched = doc.querySelectorAll(chosen); } catch { matched = []; }
  for (const el of matched) {
    if (!shown(el, doc)) continue;
    const at = middle(el, dx, dy);
    rows.push({
      ref: 'e' + refs.length,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      label: name(el),
      frame: (dx === 0 && dy === 0) ? 'shell' : 'app',
      x: at.x,
      y: at.y,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    });
    refs.push(el);
  }
}
window.__kaavaDebugRefs = refs;
return JSON.stringify(rows);
"#;

/// A ref, else a CSS selector, and the element is scrolled into view before its
/// position is read — a click at the coordinates of something off screen lands
/// on whatever is there instead. Then the element must be attached, have a
/// size, and be what is actually under its centre, in its own document and in
/// the shell's (an overlay can sit over a whole app frame).
const LOCATE_BODY: &str = r#"
const kept = window.__kaavaDebugRefs || [];
const isRef = /^e\d+$/.test(argument);
let el = isRef ? kept[Number(argument.slice(1))] : null;
if (isRef && el && !el.isConnected) return JSON.stringify({ problem: 'stale' });
let dx = 0, dy = 0, home = document;
if (el) {
  for (const entry of docs()) {
    if (entry.doc.contains(el)) { dx = entry.dx; dy = entry.dy; home = entry.doc; break; }
  }
} else {
  for (const entry of docs()) {
    let found = null;
    try { found = entry.doc.querySelector(argument); } catch { found = null; }
    if (found) { el = found; dx = entry.dx; dy = entry.dy; home = entry.doc; break; }
  }
}
if (!el) return JSON.stringify({});
el.scrollIntoView({ block: 'center', inline: 'center' });
const box = el.getBoundingClientRect();
if (box.width === 0 || box.height === 0) return JSON.stringify({ problem: 'zero-size', label: name(el) });
const at = middle(el, dx, dy);
const hits = (hit, own) => !hit || hit === own || own.contains(hit) || hit.contains(own);
const local = home.elementFromPoint(at.x - dx, at.y - dy);
const frameEl = home === document ? el : [...document.querySelectorAll('iframe')].find((f) => {
  try { return f.contentDocument === home; } catch { return false; }
});
const top = document.elementFromPoint(at.x, at.y);
const cover = !hits(local, el) ? local : (frameEl && !hits(top, frameEl) ? top : null);
if (cover) return JSON.stringify({ problem: 'covered', label: name(el),
  coveredBy: cover.tagName.toLowerCase() + (cover.className && typeof cover.className === 'string' ? '.' + cover.className.split(' ')[0] : '') + (name(cover) ? ' "' + name(cover) + '"' : '') });
window.__kaavaClickTarget = el;
return JSON.stringify({ x: at.x, y: at.y, label: name(el) });
"#;

/// After a click: what has focus, and focus moved onto the target when the
/// press left it elsewhere and the target can take it.
const FOCUS_BODY: &str = r#"
const el = window.__kaavaClickTarget;
window.__kaavaClickTarget = null;
if (!el || !el.isConnected) return JSON.stringify(describe(deepActive().el));
let now = deepActive();
const onIt = () => now.el === el || (now.el && el.contains(now.el));
const focusable = el.matches('input,textarea,select,button,a[href],[tabindex],[contenteditable=true]');
let moved = false;
if (focusable && !onIt()) { try { el.focus(); moved = true; } catch { moved = false; } now = deepActive(); }
return JSON.stringify({ element: describe(now.el), onTarget: onIt(), movedByTool: moved,
  instance: instanceOf(now.frame || now.el) });
"#;

/// What `type_text` would type into, or why not.
const TYPE_TARGET_BODY: &str = r#"
const a = deepActive();
if (!a.el) return JSON.stringify({ problem: 'nothing' });
if (terminal(a.el)) return JSON.stringify({ problem: 'terminal', target: describe(a.el) });
if (!editable(a.el)) return JSON.stringify({ problem: 'not-editable', target: describe(a.el) });
return JSON.stringify({ target: describe(a.el), frame: a.frame ? 'app' : 'shell',
  instance: instanceOf(a.frame || a.el) });
"#;

/// Find a field by ref or label in any document and set it the way React
/// notices: through the prototype's value setter, then `input` and `change`
/// built from the field's own window, since an app frame has its own classes.
const FILL_BODY: &str = r#"
const { field, value } = argument;
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const FIELDS = 'input,textarea,select,[contenteditable=true],[role=textbox]';
let el = null;
if (/^e\d+$/.test(field)) {
  el = (window.__kaavaDebugRefs || [])[Number(field.slice(1))] || null;
  if (el && !el.isConnected) return JSON.stringify({ problem: 'stale' });
}
if (!el) {
  const want = norm(field), exact = [], partial = [], seen = [];
  for (const { doc } of docs()) {
    for (const f of doc.querySelectorAll(FIELDS)) {
      if (!shown(f, doc) || f.type === 'hidden') continue;
      const by = f.getAttribute('aria-labelledby');
      const names = [f.getAttribute('aria-label'), f.getAttribute('placeholder'), f.getAttribute('name'),
        f.id ? (doc.querySelector('label[for="' + CSS.escape(f.id) + '"]') || {}).innerText : '',
        (f.closest('label') || {}).innerText, by ? (doc.getElementById(by) || {}).innerText : '']
        .map(norm).filter(Boolean);
      seen.push(names[0] || f.tagName.toLowerCase());
      if (names.includes(want)) exact.push(f);
      else if (want && names.some((n) => n.includes(want))) partial.push(f);
    }
  }
  const pick = exact.length ? exact : partial;
  if (pick.length === 0) return JSON.stringify({ problem: 'none', fields: seen.slice(0, 40) });
  if (pick.length > 1) return JSON.stringify({ problem: 'ambiguous', matches: pick.map(name).slice(0, 10) });
  el = pick[0];
}
if (!el.matches(FIELDS)) return JSON.stringify({ problem: 'not-a-field' });
if (terminal(el)) return JSON.stringify({ problem: 'terminal' });
if (el.disabled || el.readOnly) return JSON.stringify({ problem: 'read-only' });
const view = el.ownerDocument.defaultView || window;
const fire = (type) => el.dispatchEvent(new view.Event(type, { bubbles: true }));
el.focus();
if (el.type === 'checkbox' || el.type === 'radio') {
  const want = /^(true|on|1|yes|checked)$/i.test(value);
  if (el.checked !== want) el.click();
} else if (el.tagName === 'SELECT') {
  const opt = [...el.options].find((o) => o.value === value || norm(o.text) === norm(value));
  if (!opt) return JSON.stringify({ problem: 'no-option', options: [...el.options].map((o) => o.text).slice(0, 40) });
  Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
  fire('input'); fire('change');
} else if (el.isContentEditable || el.getAttribute('role') === 'textbox' && !('value' in el)) {
  el.textContent = value;
  el.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
} else {
  const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  fire('input'); fire('change');
}
const frame = el.ownerDocument === document ? null : [...document.querySelectorAll('iframe')]
  .find((f) => { try { return f.contentDocument === el.ownerDocument; } catch { return false; } });
return JSON.stringify({ filled: describe(el), frame: frame ? 'app' : 'shell',
  instance: instanceOf(frame || el),
  value: 'value' in el && el.tagName !== 'DIV' ? (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value) : el.textContent });
"#;

/// Focus, the pane instance it is in, each visible app's own report through
/// `window.__kaavaContext` (the canvas answers with its open file and
/// selection), and any selected text.
const CONTEXT_BODY: &str = r#"
const a = deepActive();
const apps = [];
for (const f of document.querySelectorAll('iframe')) {
  if (!shown(f, document)) continue;
  let report = null;
  try { const fn = f.contentWindow.__kaavaContext; report = typeof fn === 'function' ? fn() : null; } catch { report = null; }
  apps.push({ instance: instanceOf(f), title: f.getAttribute('title'), focused: f === a.frame, report });
}
let text = '';
try { text = String(a.doc.getSelection ? a.doc.getSelection() : ''); } catch { text = ''; }
return JSON.stringify({
  focus: describe(a.el),
  focusIn: a.frame ? 'app' : (terminal(a.el) ? 'terminal' : (a.el ? 'shell' : 'nothing')),
  instance: instanceOf(a.frame || a.el),
  windowHasFocus: document.hasFocus(),
  apps,
  selectedText: text.slice(0, 4000),
  selectedTextLength: text.length,
});
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_is_developer_only_and_says_what_it_does() {
        assert!(
            SERVER.dev_only,
            "the one server that can click must not be visible by default"
        );
        assert!(!SERVER.description.trim().is_empty());
    }

    #[test]
    fn the_server_declares_exactly_the_eight_tools() {
        let names: Vec<&str> = SERVER.tools.iter().map(|t| t.name).collect();
        assert_eq!(
            names,
            vec![
                "screenshot",
                "snapshot",
                "click",
                "type_text",
                "fill_field",
                "context",
                "press_key",
                "eval"
            ]
        );
    }

    /// An agent reached for a browser to look at OpenKaava and found nothing.
    /// The descriptions are what it reads first, so they say where to look.
    #[test]
    fn the_screenshot_tool_says_a_browser_cannot_reach_the_app() {
        let shot = SERVER.tools[0].description;
        assert!(shot.contains("not a web"), "{shot}");
        assert!(shot.contains("browser"), "{shot}");
    }

    #[test]
    fn click_refuses_a_stale_ref_a_zero_box_and_a_covered_element() {
        let stale = click_refusal("e3", &json!({ "problem": "stale" })).expect("refused");
        assert!(stale.contains("fresh snapshot"), "{stale}");

        let flat = click_refusal("e4", &json!({ "problem": "zero-size", "label": "Save" }))
            .expect("refused");
        assert!(flat.contains("no size") && flat.contains("Save"), "{flat}");

        let covered = click_refusal(
            "#go",
            &json!({ "problem": "covered", "label": "Go", "coveredBy": "div.boot-overlay" }),
        )
        .expect("refused");
        assert!(covered.contains("div.boot-overlay"), "{covered}");

        let missing = click_refusal("e9", &json!({})).expect("refused");
        assert!(missing.contains("nothing matched"), "{missing}");

        assert_eq!(click_refusal("e1", &json!({ "x": 10, "y": 20 })), None);
    }

    #[test]
    fn type_text_refuses_no_focus_a_terminal_and_a_non_field() {
        let nothing = type_refusal(&json!({ "problem": "nothing" })).expect("refused");
        assert!(nothing.contains("fill_field"), "{nothing}");

        let term = type_refusal(&json!({ "problem": "terminal" })).expect("refused");
        assert!(
            term.contains("terminal") && term.contains("command"),
            "{term}"
        );

        let button = type_refusal(&json!({
            "problem": "not-editable",
            "target": { "tag": "button", "label": "New canvas" }
        }))
        .expect("refused");
        assert!(button.contains("New canvas"), "{button}");

        assert_eq!(
            type_refusal(&json!({ "target": { "tag": "input", "label": "Name" } })),
            None
        );
    }

    #[test]
    fn fill_field_names_what_it_could_have_meant() {
        let none = fill_refusal(
            "Title",
            &json!({ "problem": "none", "fields": ["name", "size"] }),
        )
        .expect("refused");
        assert!(none.contains("name, size"), "{none}");

        let two = fill_refusal(
            "n",
            &json!({ "problem": "ambiguous", "matches": ["Name", "Note"] }),
        )
        .expect("refused");
        assert!(two.contains("Name, Note") && two.contains("ref"), "{two}");

        let opt = fill_refusal(
            "Level",
            &json!({ "problem": "no-option", "options": ["a", "b"] }),
        )
        .expect("refused");
        assert!(opt.contains("a, b"), "{opt}");

        assert_eq!(fill_refusal("Name", &json!({ "filled": {} })), None);
    }

    /// The cap is a report, not a silent cut: well past the old 2,000, and the
    /// keystroke path stays below it so a long paste is one protocol call.
    #[test]
    fn long_text_is_inserted_whole_rather_than_cut_at_two_thousand() {
        const { assert!(MAX_TEXT >= 100_000) };
        const { assert!(KEYSTROKE_LIMIT < MAX_TEXT) };
    }

    /// Every body is wrapped in the helpers, and every helper a body calls is
    /// defined there. A typo here is a `ReferenceError` only a live window sees.
    #[test]
    fn every_body_uses_only_helpers_that_exist() {
        for (body, uses) in [
            (FOCUS_BODY, &["deepActive", "describe", "instanceOf"][..]),
            (
                TYPE_TARGET_BODY,
                &["deepActive", "terminal", "editable"][..],
            ),
            (FILL_BODY, &["docs", "shown", "terminal", "describe"][..]),
            (CONTEXT_BODY, &["deepActive", "instanceOf", "shown"][..]),
            (LOCATE_BODY, &["docs", "middle", "name"][..]),
        ] {
            let js = script(body, &Value::Null);
            for helper in uses {
                assert!(body.contains(helper), "{helper}");
                assert!(
                    HELPERS.contains(&format!("const {helper} = ")),
                    "{helper} is not defined"
                );
            }
            assert!(js.starts_with("(() => {"));
        }
    }

    /// The listener hands `rmcp` a map for `inputSchema`, so a schema that were
    /// an array or a string would have nowhere to go.
    #[test]
    fn every_schema_is_an_object() {
        for tool in SERVER.tools {
            assert!(
                (tool.schema)().is_object(),
                "schema for {:?} must be a JSON object",
                tool.name
            );
        }
    }

    /// Every tool acts on a window, and every one of them has to accept the same
    /// way of naming it — a tool that quietly ignored `window` would act on the
    /// wrong one and report success.
    #[test]
    fn every_tool_accepts_a_window() {
        for tool in SERVER.tools {
            let schema = (tool.schema)();
            assert!(
                schema.pointer("/properties/window").is_some(),
                "{:?} does not take a window",
                tool.name
            );
        }
    }

    /// The enum is what a client draws its choices from, so it has to be the
    /// same list `press_key` will actually accept.
    #[test]
    fn the_key_schema_offers_exactly_the_keys_that_work() {
        let schema = key_schema();
        let offered: Vec<&str> = schema
            .pointer("/properties/key/enum")
            .and_then(Value::as_array)
            .expect("the key parameter offers an enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();

        let known: Vec<&str> = KEYS.iter().map(|(name, _, _)| *name).collect();
        assert_eq!(offered, known);
    }

    /// Enter is the one key that carries text, and it must carry it only on the
    /// way down — dispatched on both edges it types two newlines.
    #[test]
    fn only_enter_carries_text() {
        for (name, _, text) in KEYS {
            let carries = !text.is_empty();
            assert_eq!(carries, *name == "Enter", "{name} disagrees about text");
        }
    }

    /// A missing required parameter is refused by name. The schema should have
    /// caught it, but not every client enforces one, and "`target` is required"
    /// is a fixable message where a panic is not.
    #[test]
    fn a_missing_required_parameter_is_named_rather_than_guessed() {
        let error = required(&json!({}), "target").expect_err("this must fail");
        assert_eq!(error.code, INVALID_PARAMS);
        assert!(error.message.contains("target"), "{}", error.message);

        let numeric = json!({ "target": 12 });
        assert!(
            required(&numeric, "target").is_err(),
            "a number is not a target"
        );
    }

    /// The argument is encoded, not pasted. A selector holding a quote has to
    /// arrive as a selector rather than as a syntax error halfway down a script.
    #[test]
    fn a_hostile_argument_is_encoded_rather_than_interpolated() {
        let nasty = Value::String("input[value='\"]; alert(1); //']".to_string());
        let js = script(LOCATE_BODY, &nasty);

        assert!(js.contains("const argument = \""), "{js}");
        assert!(
            !js.contains("; alert(1); //']\n"),
            "the argument escaped its literal"
        );
        assert!(js.contains("window.__kaavaDebugRefs"));
    }

    /// `null` is what "no selector" becomes, and the body has to read it as
    /// falsy so the default list is used. Any other encoding silently matches
    /// nothing.
    #[test]
    fn an_absent_selector_becomes_a_falsy_argument() {
        let js = script(SNAPSHOT_BODY, &Value::Null);
        assert!(js.contains("const argument = null;"), "{js}");
    }

    /// The default list lives in two places by necessity: the JS that applies it
    /// and the Rust that reports which one was used. This is what keeps the
    /// answer honest about what was actually looked at.
    #[test]
    fn the_reported_default_selector_is_the_one_the_page_applies() {
        assert!(SNAPSHOT_BODY.contains(INTERACTIVE), "{INTERACTIVE}");
    }
}
