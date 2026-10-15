//! A message's references as ACP content blocks, for the agent tab to send
//! after what the person typed (`refs/prompt`).
//!
//! A `resource_link` is the one kind every ACP agent accepts, and the agent
//! reads it through `kaava-context`, so any reference can go as one. An agent
//! that takes embedded context gets a reference's text in a `resource` block
//! instead, and one that takes images gets its pictures as `image` blocks.
//! What resolving withholds, a secret or a gitignored file, is only ever
//! linked. So is whatever would take the message past its budget.

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
    let resolved = wanted(uris)
        .into_iter()
        .map(|(given, r)| {
            let found = r.and_then(|r| live::resolve(app, ctx, Actor::Human, &r));
            (given, found)
        })
        .collect();
    answer(resolved, accepts)
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
            Ok(r) => blocks.extend(blocks_for(&r, accepts, &mut budget)),
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

/// One reference: its text in a `resource`, or a link to it, then each
/// picture the agent takes and the budget allows. A picture left out is
/// named, so the agent knows there is more to `read`.
fn blocks_for(r: &Resolved, accepts: Accepts, budget: &mut Budget) -> Vec<Value> {
    if let Some(why) = &r.withheld {
        return vec![link(r, &[why])];
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
    let unseen = match left_out {
        0 => None,
        1 => Some(format!(
            "A picture is not attached: `read` {} to see it.",
            r.uri
        )),
        n => Some(format!(
            "{n} pictures are not attached: `read` {} to see them.",
            r.uri
        )),
    };
    let head = if !accepts.embedded_context {
        link(r, &unseen.as_deref().into_iter().collect::<Vec<_>>())
    } else {
        let text = texts.into_iter().chain(unseen.clone()).collect::<Vec<_>>();
        let text = text.join("\n\n");
        if budget.take_text(text.len()) {
            json!({
                "type": "resource",
                "resource": { "uri": r.uri, "mimeType": "text/plain", "text": text },
            })
        } else {
            let spent = "Not embedded: this message has no room left for attached text. \
                         `read` it through kaava-context.";
            link(r, &[spent])
        }
    };
    std::iter::once(head).chain(pictures).collect()
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
                width: Some(1),
                height: Some(1),
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
