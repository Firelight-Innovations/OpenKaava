//! A message's references as ACP content blocks, for `refs/prompt` and for
//! the agent tab to send after what the person typed.
//!
//! A `resource_link` is the one kind every ACP agent accepts, and an agent
//! with `kaava-context` reads it through that, so for `refs/prompt` any
//! reference can go as one. An agent that takes embedded context gets a
//! reference's text in a `resource` block instead, and one that takes images
//! gets its pictures as `image` blocks. What resolving withholds, a secret or
//! a gitignored file, is only ever linked. So is whatever would take the
//! message past its budget. The agent tab's agents have no `kaava-context`
//! yet, so for them nothing is only linked: see [`attachments`].

use super::fault::{Fault, Reason};
use super::live::{self, Actor};
use super::read;
use super::resolve::Resolved;
use super::uri::{self, Ref};
use crate::apps::CallContext;
use crate::mcp::Block;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::AppHandle;

/// Most references one message carries.
pub const MAX_URIS: usize = 16;
/// Most text embedded across one message, in bytes.
pub const MAX_TEXT_BYTES: usize = 256 * 1024;
/// Most pictures one message carries.
pub const MAX_IMAGES: usize = 4;
/// Most base64 across those pictures: two at the resolver's cap, or more
/// smaller ones.
pub const MAX_IMAGE_DATA: usize = 10 * 1024 * 1024;

/// What the agent takes beyond text and links: its ACP `promptCapabilities`,
/// passed as they came. Whatever it did not say is a no.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Accepts {
    pub image: bool,
    pub embedded_context: bool,
}

/// Whether the agent can `read` a `kaava://` link itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reach {
    /// Through `kaava-context`, as a `refs/prompt` caller can.
    Links,
    /// The agent tab's: what is not in the message, the agent never sees.
    Inline,
}

/// A message's references, resolved before anyone knows what the agent takes.
pub struct Resolution<'a>(Vec<(&'a str, Result<Resolved, Fault>)>);

impl Resolution<'_> {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// What is left of one message's budget.
#[derive(Debug)]
struct Budget {
    text: usize,
    images: usize,
    image_data: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Budget {
            text: MAX_TEXT_BYTES,
            images: MAX_IMAGES,
            image_data: MAX_IMAGE_DATA,
        }
    }
}

impl Budget {
    fn take_text(&mut self, bytes: usize) -> bool {
        let fits = bytes <= self.text;
        if fits {
            self.text -= bytes;
        }
        fits
    }

    fn take_image(&mut self, bytes: usize) -> bool {
        let fits = self.images > 0 && bytes <= self.image_data;
        if fits {
            self.images -= 1;
            self.image_data -= bytes;
        }
        fits
    }
}

/// `{blocks, failed?}` for `uris`: each reference once, in the order given.
pub fn run(app: &AppHandle, ctx: &CallContext, uris: &[String], accepts: Accepts) -> Value {
    answer(resolve_all(app, ctx, uris), accepts)
}

/// `uris`, the references a message's chips name, resolved. Resolving needs
/// no harness, so the agent tab does it before it holds its turn.
pub fn resolve<'a>(app: &AppHandle, ctx: &CallContext, uris: &'a [String]) -> Resolution<'a> {
    Resolution(resolve_all(app, ctx, uris))
}

/// The blocks the agent tab sends after a prompt's text: each reference's,
/// in order, and in place of one that failed a note saying which and why.
/// The prompt goes whatever becomes of its references. The tab's agents
/// have no `kaava-context` to `read` a link through, so nothing is only
/// linked: text goes in a `resource` to an agent that takes one and as text
/// to any other, and what cannot go at all is a note.
pub fn attachments(resolved: Resolution<'_>, accepts: Accepts) -> Vec<Value> {
    in_order(resolved.0, accepts)
}

/// The `kaava://` references a message's chips name, as the agent tab writes
/// them (`[@label](<kaava://…>)`, `withChips` in mentions.ts): each once, in
/// order, and no more than [`MAX_URIS`]. Any past that are not attached,
/// though the text still names them.
pub fn named_in(text: &str) -> Vec<String> {
    let mut uris: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("[@") {
        rest = &rest[at + 2..];
        let Some(close) = rest.find("](<") else { break };
        let label = &rest[..close];
        // A `[@` with no chip after it: the next one may still be. A chip's
        // label never holds a bracket or a line break (`mentions.ts`).
        if label.is_empty() || label.contains(['[', ']', '\n']) {
            continue;
        }
        let tail = &rest[close + 3..];
        let Some(end) = tail.find(">)") else { break };
        let uri = &tail[..end];
        if uri.starts_with("kaava://") && !uri.contains('>') && !uris.iter().any(|u| u == uri) {
            uris.push(uri.to_string());
        }
        rest = &tail[end + 2..];
    }
    uris.truncate(MAX_URIS);
    uris
}

/// `uris` resolved as the person, who attached them: each once, in order.
fn resolve_all<'a>(
    app: &AppHandle,
    ctx: &CallContext,
    uris: &'a [String],
) -> Vec<(&'a str, Result<Resolved, Fault>)> {
    wanted(uris)
        .into_iter()
        .map(|(given, r)| {
            let found = r.and_then(|r| live::resolve(app, ctx, Actor::Human, &r));
            (given, found)
        })
        .collect()
}

/// `uris` parsed, a reference written twice kept the first time.
fn wanted(uris: &[String]) -> Vec<(&str, Result<Ref, Fault>)> {
    let mut seen = HashSet::new();
    uris.iter()
        .filter_map(|given| match uri::parse(given) {
            Ok(r) => seen
                .insert(r.to_string())
                .then_some((given.as_str(), Ok(r))),
            Err(why) => Some((given.as_str(), Err(Fault::new(Reason::BadUri, why)))),
        })
        .collect()
}

/// The answer once each reference is resolved: the blocks, and the ones that
/// failed as `{uri, reason, message}`.
fn answer(resolved: Vec<(&str, Result<Resolved, Fault>)>, accepts: Accepts) -> Value {
    let mut budget = Budget::default();
    let mut blocks = Vec::new();
    let mut failed = Vec::new();
    for (given, found) in resolved {
        match found {
            Ok(r) => blocks.extend(blocks_for(&r, accepts, Reach::Links, &mut budget)),
            Err(why) => failed.push(json!({
                "uri": given,
                "reason": why.reason,
                "message": why.message,
            })),
        }
    }
    let mut out = json!({ "blocks": blocks });
    if !failed.is_empty() {
        out["failed"] = json!(failed);
    }
    out
}

/// [`attachments`] once each reference is resolved, sharing one budget.
fn in_order(resolved: Vec<(&str, Result<Resolved, Fault>)>, accepts: Accepts) -> Vec<Value> {
    let mut budget = Budget::default();
    resolved
        .into_iter()
        .flat_map(|(given, found)| match found {
            Ok(r) => blocks_for(&r, accepts, Reach::Inline, &mut budget),
            Err(why) => vec![note(given, &why.message)],
        })
        .collect()
}

/// One reference: its text in a `resource`, as text, or a link to it, then
/// each picture the agent takes and the budget allows. A picture left out
/// is named, so the agent knows there is more.
fn blocks_for(r: &Resolved, accepts: Accepts, reach: Reach, budget: &mut Budget) -> Vec<Value> {
    if let Some(why) = &r.withheld {
        return vec![match reach {
            Reach::Links => link(r, &[why]),
            Reach::Inline => note(&r.uri, why),
        }];
    }
    let mut texts = Vec::new();
    let mut pictures = Vec::new();
    let mut left_out = 0;
    for block in read::blocks(r) {
        match block {
            Block::Text(text) => texts.push(text),
            Block::Image { mime, data } if accepts.image && budget.take_image(data.len()) => {
                pictures.push(json!({
                    "type": "image",
                    "mimeType": mime,
                    "data": data,
                    "uri": r.uri,
                }));
            }
            Block::Image { .. } => left_out += 1,
        }
    }
    let unseen = unseen(left_out, &r.uri, reach);
    let head = if reach == Reach::Links && !accepts.embedded_context {
        link(r, &unseen.as_deref().into_iter().collect::<Vec<_>>())
    } else {
        let text = texts.into_iter().chain(unseen.clone()).collect::<Vec<_>>();
        let text = text.join("\n\n");
        if !budget.take_text(text.len()) {
            no_room(r, reach, unseen.as_deref())
        } else if accepts.embedded_context {
            json!({
                "type": "resource",
                "resource": { "uri": r.uri, "mimeType": "text/plain", "text": text },
            })
        } else {
            json!({ "type": "text", "text": text })
        }
    };
    std::iter::once(head).chain(pictures).collect()
}

/// Names the `n` pictures of `uri` a message leaves out, and how to see them
/// for an agent that can.
fn unseen(n: usize, uri: &str, reach: Reach) -> Option<String> {
    let (what, them) = match n {
        0 => return None,
        1 => ("A picture is not attached".to_string(), "it"),
        n => (format!("{n} pictures are not attached"), "them"),
    };
    Some(match reach {
        Reach::Links => format!("{what}: `read` {uri} to see {them}."),
        Reach::Inline => format!("{what}."),
    })
}

/// What goes in place of a reference's text once the message has no room left.
fn no_room(r: &Resolved, reach: Reach, unseen: Option<&str>) -> Value {
    if reach == Reach::Links {
        let spent = "Not embedded: this message has no room left for attached text. \
                     `read` it through kaava-context.";
        return link(
            r,
            &[Some(spent), unseen]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>(),
        );
    }
    let why = "this message has no room left for attached text";
    match unseen {
        Some(unseen) => note(&r.uri, &format!("{why}. {unseen}")),
        None => note(&r.uri, why),
    }
}

/// A text block in a reference's place, saying why it is not attached.
fn note(uri: &str, why: &str) -> Value {
    json!({ "type": "text", "text": format!("[{uri} is not attached: {why}]") })
}

/// A `resource_link`: what it is called, where, and the `notes` that say
/// what the agent should know before reading it.
fn link(r: &Resolved, notes: &[&str]) -> Value {
    let name = if r.title.is_empty() { &r.uri } else { &r.title };
    let mut block = json!({ "type": "resource_link", "uri": r.uri, "name": name });
    let about: Vec<&str> = r
        .detail
        .as_deref()
        .into_iter()
        .chain(notes.iter().copied())
        .collect();
    if !about.is_empty() {
        block["description"] = json!(about.join("\n"));
    }
    for (key, field) in [("mime", "mimeType"), ("size", "size")] {
        if let Some(value) = r.meta.get(key) {
            block[field] = value.clone();
        }
    }
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::resolve::Part;
    use serde_json::Map;

    fn text_ref(uri: &str, title: &str, text: &str) -> Resolved {
        let mut meta = Map::new();
        meta.insert("mime".into(), json!("text/x-gdscript"));
        meta.insert("size".into(), json!(text.len()));
        Resolved {
            uri: uri.into(),
            kind: "text".into(),
            title: title.into(),
            detail: Some(format!("{title} · lines 1–2")),
            meta,
            parts: vec![Part::Text {
                text: text.into(),
                language: None,
                start_line: 1,
                truncated: false,
            }],
            withheld: None,
        }
    }

    fn with_pictures(mut r: Resolved, n: usize, bytes: usize) -> Resolved {
        for _ in 0..n {
            r.parts.push(Part::Image {
                mime: "image/png".into(),
                data_base64: "A".repeat(bytes),
                width: 1,
                height: 1,
            });
        }
        r
    }

    const NONE: Accepts = Accepts {
        image: false,
        embedded_context: false,
    };
    const ALL: Accepts = Accepts {
        image: true,
        embedded_context: true,
    };

    fn blocks(resolved: Vec<Resolved>, accepts: Accepts) -> Vec<Value> {
        let given: Vec<_> = resolved.into_iter().map(|r| ("given", Ok(r))).collect();
        answer(given, accepts)["blocks"].as_array().unwrap().clone()
    }

    #[test]
    fn an_agent_that_takes_nothing_more_gets_links_it_can_read() {
        let r = with_pictures(text_ref("kaava://file/a.gd", "a.gd", "x\ny"), 1, 8);
        let out = blocks(vec![r], NONE);
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0],
            json!({
                "type": "resource_link",
                "uri": "kaava://file/a.gd",
                "name": "a.gd",
                "description": "a.gd · lines 1–2\nA picture is not attached: `read` kaava://file/a.gd to see it.",
                "mimeType": "text/x-gdscript",
                "size": 3,
            })
        );
    }

    #[test]
    fn an_agent_that_takes_everything_gets_the_text_then_the_pictures() {
        let r = with_pictures(text_ref("kaava://file/a.gd", "a.gd", "x\ny"), 2, 8);
        let out = blocks(vec![r], ALL);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["type"], "resource");
        assert_eq!(out[0]["resource"]["uri"], "kaava://file/a.gd");
        let text = out[0]["resource"]["text"].as_str().unwrap();
        assert!(text.starts_with("kaava://file/a.gd (text): a.gd"), "{text}");
        assert!(text.ends_with("x\ny"), "{text}");
        assert_eq!(out[1]["type"], "image");
        assert_eq!(out[1]["mimeType"], "image/png");
        assert_eq!(out[2]["uri"], "kaava://file/a.gd");
    }

    #[test]
    fn a_withheld_reference_is_only_ever_linked() {
        let mut r = text_ref("kaava://file/.env", ".env", "");
        r.parts.clear();
        r.withheld = Some("withheld: environment files are never read".into());
        let out = blocks(vec![r], ALL);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], "resource_link");
        let about = out[0]["description"].as_str().unwrap();
        assert!(
            about.ends_with("withheld: environment files are never read"),
            "{about}"
        );
    }

    #[test]
    fn text_past_the_budget_is_linked_and_says_why_and_later_text_still_fits() {
        let big = "x".repeat(MAX_TEXT_BYTES);
        let out = blocks(
            vec![
                text_ref("kaava://file/big.txt", "big.txt", &big),
                text_ref("kaava://file/small.gd", "small.gd", "y"),
            ],
            ALL,
        );
        assert_eq!(out[0]["type"], "resource_link");
        let about = out[0]["description"].as_str().unwrap();
        assert!(about.contains("no room left"), "{about}");
        assert_eq!(out[1]["type"], "resource");
    }

    #[test]
    fn a_link_for_text_past_the_budget_still_names_the_pictures_left_out() {
        let big = "x".repeat(MAX_TEXT_BYTES);
        let r = with_pictures(text_ref("kaava://file/big.svg", "big.svg", &big), 1, 8);
        let text_only = Accepts {
            image: false,
            embedded_context: true,
        };
        let out = blocks(vec![r], text_only);
        let about = out[0]["description"].as_str().unwrap();
        assert!(about.contains("no room left"), "{about}");
        assert!(
            about.ends_with("`read` kaava://file/big.svg to see it."),
            "{about}"
        );
    }

    #[test]
    fn pictures_stop_at_the_count_and_the_rest_are_named() {
        let r = with_pictures(
            text_ref("kaava://file/a.png", "a.png", ""),
            MAX_IMAGES + 2,
            8,
        );
        let out = blocks(vec![r], ALL);
        assert_eq!(out.len(), 1 + MAX_IMAGES);
        let text = out[0]["resource"]["text"].as_str().unwrap();
        assert!(
            text.ends_with("2 pictures are not attached: `read` kaava://file/a.png to see them.")
        );
        let mut budget = Budget::default();
        assert!(
            !budget.take_image(MAX_IMAGE_DATA + 1),
            "one picture over the data cap"
        );
        assert!(budget.take_image(MAX_IMAGE_DATA));
        assert!(!budget.take_image(1), "the data is spent");
    }

    #[test]
    fn a_reference_given_twice_goes_once_and_a_bad_one_says_why() {
        let given = [
            "kaava://file/a.gd".to_string(),
            "kaava://file/../x".to_string(),
            "kaava://file/a.gd".to_string(),
        ];
        let parsed = wanted(&given);
        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].1.is_ok());
        let missing = Fault::new(Reason::Missing, "there is no `gone.gd` in this project");
        let out = answer(
            vec![
                ("kaava://file/gone.gd", Err(missing)),
                (parsed[1].0, Err(parsed[1].1.clone().unwrap_err())),
            ],
            ALL,
        );
        assert_eq!(out["blocks"], json!([]));
        assert_eq!(
            out["failed"][0],
            json!({
                "uri": "kaava://file/gone.gd",
                "reason": "missing",
                "message": "there is no `gone.gd` in this project",
            })
        );
        assert_eq!(out["failed"][1]["reason"], "bad-uri");
    }

    #[test]
    fn a_file_chip_is_a_resource_and_one_that_failed_is_a_note_in_its_place() {
        let text = "[@gone.gd](<kaava://file/gone.gd>) [@a.gd](<kaava://file/a.gd>) look";
        let uris = named_in(text);
        assert_eq!(uris, ["kaava://file/gone.gd", "kaava://file/a.gd"]);
        let missing = Fault::new(Reason::Missing, "there is no `gone.gd` in this project");
        let a = text_ref("kaava://file/a.gd", "a.gd", "x\ny");
        let out = in_order(
            vec![(uris[0].as_str(), Err(missing)), (uris[1].as_str(), Ok(a))],
            ALL,
        );
        assert_eq!(
            out[0],
            json!({
                "type": "text",
                "text": "[kaava://file/gone.gd is not attached: there is no `gone.gd` in this project]",
            })
        );
        assert_eq!(out[1]["type"], "resource");
        assert_eq!(out[1]["resource"]["uri"], "kaava://file/a.gd");
        assert_eq!(out.len(), 2);
    }

    /// As the agent tab attaches them.
    fn inline(resolved: Vec<Resolved>, accepts: Accepts) -> Vec<Value> {
        in_order(
            resolved.into_iter().map(|r| ("given", Ok(r))).collect(),
            accepts,
        )
    }

    #[test]
    fn the_agent_tab_sends_text_its_agent_cannot_take_embedded_as_text() {
        let r = with_pictures(text_ref("kaava://file/a.gd", "a.gd", "x\ny"), 1, 8);
        let out = inline(vec![r], NONE);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], "text");
        let text = out[0]["text"].as_str().unwrap();
        assert!(text.starts_with("kaava://file/a.gd (text): a.gd"), "{text}");
        assert!(text.contains("x\ny"), "{text}");
        assert!(text.ends_with("A picture is not attached."), "{text}");
    }

    /// Its agents have no `kaava-context`, so a link would lead nowhere.
    #[test]
    fn the_agent_tab_never_sends_a_link_and_says_what_it_left_out() {
        let mut env = text_ref("kaava://file/.env", ".env", "");
        env.parts.clear();
        env.withheld = Some("withheld: environment files are never read".into());
        let big = "x".repeat(MAX_TEXT_BYTES);
        for accepts in [NONE, ALL] {
            let out = inline(
                vec![
                    env.clone(),
                    text_ref("kaava://file/big.txt", "big.txt", &big),
                    text_ref("kaava://file/small.gd", "small.gd", "y"),
                ],
                accepts,
            );
            assert!(out.iter().all(|b| b["type"] != "resource_link"), "{out:?}");
            assert_eq!(
                out[0]["text"],
                "[kaava://file/.env is not attached: withheld: environment files are never read]"
            );
            assert_eq!(
                out[1]["text"],
                "[kaava://file/big.txt is not attached: this message has no room left for attached text]"
            );
            let fits = if accepts.embedded_context {
                "resource"
            } else {
                "text"
            };
            assert_eq!(out[2]["type"], fits, "later text still fits");
        }
    }

    #[test]
    fn only_chips_name_references_and_each_goes_once() {
        let text = "see [@a](<kaava://file/a.gd>), [x](<kaava://file/b.gd>), \
                    [@](<kaava://file/c.gd>), [@PROJ-1](<https://jira.example/PROJ-1>), \
                    [@ a ] b [@a again](<kaava://file/a.gd>) [@d](<kaava://file/d.gd>)";
        assert_eq!(named_in(text), ["kaava://file/a.gd", "kaava://file/d.gd"]);
        assert_eq!(
            named_in("[@unclosed](<kaava://file/a.gd"),
            Vec::<String>::new()
        );
        // A stray `[@` before a plain link does not make the link a chip.
        for text in [
            "a [@ note [y](<kaava://file/y.gd>)",
            "a [@ note\nthen](<kaava://file/y.gd>)",
        ] {
            assert_eq!(named_in(text), Vec::<String>::new(), "{text}");
        }
        let many: String = (0..MAX_URIS + 3)
            .map(|i| format!("[@f{i}](<kaava://file/f{i}.gd>) "))
            .collect();
        assert_eq!(named_in(&many).len(), MAX_URIS);
    }

    #[test]
    fn capabilities_are_read_as_acp_writes_them_and_a_missing_one_is_no() {
        let given = json!({ "image": true, "audio": true, "embeddedContext": false });
        let accepts: Accepts = serde_json::from_value(given).unwrap();
        assert_eq!(
            accepts,
            Accepts {
                image: true,
                embedded_context: false
            }
        );
        let accepts: Accepts = serde_json::from_value(json!({})).unwrap();
        assert_eq!(accepts, NONE);
        assert!(serde_json::from_value::<Accepts>(json!({ "image": "yes" })).is_err());
    }
}
