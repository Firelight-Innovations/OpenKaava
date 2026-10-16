//! A resolved reference as an agent reads it: a header that says what it is,
//! then each part, pictures as pictures. The context server's `read` answers
//! with these, and `refs/prompt` embeds them in a message.

use super::resolve::{Part, Resolved};
use crate::mcp::Block;
use serde_json::Value;

/// `r` as content blocks, the header first.
pub fn blocks(r: &Resolved) -> Vec<Block> {
    let mut head = format!("{} ({}): {}", r.uri, r.kind, r.title);
    for line in [&r.detail, &r.withheld].into_iter().flatten() {
        head.push('\n');
        head.push_str(line);
    }
    if !r.meta.is_empty() {
        head.push('\n');
        head.push_str(&Value::Object(r.meta.clone()).to_string());
    }
    let mut out = vec![Block::Text(head)];
    out.extend(r.parts.iter().map(|part| match part {
        Part::Text {
            text,
            start_line,
            truncated,
            ..
        } => {
            let mut t = String::new();
            if *start_line > 1 {
                t.push_str(&format!("(from line {start_line})\n"));
            }
            t.push_str(text);
            if *truncated {
                t.push_str("\n(cut short; ask for a line range to read further)");
            }
            Block::Text(t)
        }
        Part::Image {
            mime, data_base64, ..
        } => Block::Image {
            mime: mime.clone(),
            data: data_base64.clone(),
        },
        Part::Json { value } => {
            Block::Text(serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()))
        }
        Part::Note { text } => Block::Text(text.clone()),
    }));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map};

    fn resolved(uri: &str, title: &str) -> Resolved {
        Resolved {
            uri: uri.into(),
            kind: "text".into(),
            title: title.into(),
            detail: None,
            meta: Map::new(),
            parts: Vec::new(),
            withheld: None,
        }
    }

    #[test]
    fn a_resolved_reference_reads_as_a_header_then_its_parts() {
        let mut r = resolved("kaava://file/a.gd", "a.gd");
        r.detail = Some("a.gd · lines 3–4".into());
        r.meta.insert("lines".into(), json!(40));
        r.parts.push(Part::Text {
            text: "x\ny".into(),
            language: Some("gdscript".into()),
            start_line: 3,
            truncated: true,
        });
        r.parts.push(Part::Image {
            mime: "image/png".into(),
            data_base64: "AA==".into(),
            width: 1,
            height: 1,
        });
        let out = blocks(&r);
        assert_eq!(
            out[0],
            Block::Text("kaava://file/a.gd (text): a.gd\na.gd · lines 3–4\n{\"lines\":40}".into())
        );
        let Block::Text(body) = &out[1] else {
            panic!("{:?}", out[1])
        };
        assert!(
            body.starts_with("(from line 3)\nx\ny\n(cut short"),
            "{body}"
        );
        assert!(matches!(&out[2], Block::Image { mime, .. } if mime == "image/png"));
    }

    #[test]
    fn a_withheld_reference_says_why_in_its_header() {
        let mut r = resolved("kaava://file/.env", ".env");
        r.withheld = Some("withheld: secrets".into());
        assert_eq!(
            blocks(&r),
            vec![Block::Text(
                "kaava://file/.env (text): .env\nwithheld: secrets".into()
            )]
        );
    }
}
