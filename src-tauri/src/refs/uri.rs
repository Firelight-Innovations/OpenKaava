//! The `kaava://` grammar: parsing a reference and writing its one canonical form.
//!
//! Pure string work. Nothing here touches the disk, so a reference that parses
//! may still name a file that does not exist; [`super::resolve`] decides that.

use super::policy;
use std::fmt;

/// The scheme every reference starts with.
pub const SCHEME: &str = "kaava://";
/// A reference longer than this is refused before it is looked at.
pub const MAX_URI_CHARS: usize = 2048;
/// Longest id accepted for a comment, a design comment or a context item.
const MAX_ID_CHARS: usize = 64;

/// One thing a person or an agent can point at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ref {
    /// A file or asset, relative to the cluster's root, `/`-separated.
    File { path: String, lines: Option<Lines> },
    /// A canvas (its id may nest, `levels/hospital`), or one frame or comment on it.
    Canvas {
        id: String,
        part: Option<CanvasPart>,
    },
    /// A viewer comment in `.kaava/comments/`, with its screenshot.
    Comment { id: String },
    /// A Design Mode comment and its screenshot.
    DesignComment { id: String },
    /// An item in the context store, `.kaava/context/`.
    Context { id: String },
    /// Whatever the person has selected in the focused pane, read when resolved.
    Selection,
}

/// An inclusive, 1-based line range. `end` is `None` for a single line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lines {
    pub start: u32,
    pub end: Option<u32>,
}

impl Lines {
    /// The last line asked for.
    pub fn last(self) -> u32 {
        self.end.unwrap_or(self.start)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanvasPart {
    /// A frame, by element id or by its exact name.
    Frame(String),
    Comment(String),
}

impl Ref {
    /// The short kind name the wire uses (`file`, `canvas`, …).
    pub fn scheme_kind(&self) -> &'static str {
        match self {
            Ref::File { .. } => "file",
            Ref::Canvas { .. } => "canvas",
            Ref::Comment { .. } => "comment",
            Ref::DesignComment { .. } => "design-comment",
            Ref::Context { .. } => "context",
            Ref::Selection => "selection",
        }
    }
}

/// Parse a reference. The error is one sentence an agent can act on.
pub fn parse(raw: &str) -> Result<Ref, String> {
    let raw = raw.trim();
    if raw.chars().count() > MAX_URI_CHARS {
        return Err(format!("a reference is at most {MAX_URI_CHARS} characters"));
    }
    let rest = strip_scheme(raw)
        .ok_or_else(|| format!("`{raw}` is not a reference; references start with `{SCHEME}`"))?;
    if rest.contains('?') {
        return Err("references take no query string".into());
    }
    let (body, fragment) = match rest.split_once('#') {
        Some((body, fragment)) => (body, Some(fragment)),
        None => (rest, None),
    };
    let (kind, tail) = body.split_once('/').unwrap_or((body, ""));
    match kind {
        "file" => {
            let path = decode_path(tail)?;
            policy::check_relative(&path)?;
            let lines = fragment.map(parse_lines).transpose()?;
            Ok(Ref::File { path, lines })
        }
        "canvas" => {
            let id = decode_path(tail)?;
            policy::check_relative(&id)?;
            own_canvas_id(&id)?;
            let part = fragment.map(parse_canvas_part).transpose()?;
            Ok(Ref::Canvas { id, part })
        }
        "comment" | "design-comment" | "context" => {
            no_fragment(fragment, kind)?;
            let id = parse_id(tail, kind)?;
            Ok(match kind {
                "comment" => Ref::Comment { id },
                "design-comment" => Ref::DesignComment { id },
                _ => Ref::Context { id },
            })
        }
        "selection" => {
            no_fragment(fragment, kind)?;
            if !tail.is_empty() {
                return Err("`kaava://selection` takes no path".into());
            }
            Ok(Ref::Selection)
        }
        "" => Err("the reference names no kind after `kaava://`".into()),
        other => Err(format!(
            "`{other}` is not a reference kind; use file, canvas, comment, design-comment, \
             context or selection"
        )),
    }
}

/// The scheme is case-insensitive, as URI schemes are; everything after is not.
fn strip_scheme(raw: &str) -> Option<&str> {
    let head = raw.get(..SCHEME.len())?;
    head.eq_ignore_ascii_case(SCHEME)
        .then(|| &raw[SCHEME.len()..])
}

fn no_fragment(fragment: Option<&str>, kind: &str) -> Result<(), String> {
    match fragment {
        Some(_) => Err(format!("a `{kind}` reference takes no `#` part")),
        None => Ok(()),
    }
}

/// Ids Kaava minted itself: letters, digits, `-` and `_`, nothing that could
/// become a path separator once joined.
fn parse_id(tail: &str, kind: &str) -> Result<String, String> {
    let id = decode(tail)?;
    let ok = !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id)
    } else {
        Err(format!("`{tail}` is not a {kind} id"))
    }
}

/// `L10`, `L10-L20` or `L10-20`.
fn parse_lines(fragment: &str) -> Result<Lines, String> {
    let bad = || format!("`#{fragment}` is not a line range; write `#L10` or `#L10-L20`");
    let body = fragment.strip_prefix('L').ok_or_else(bad)?;
    let number = |s: &str| -> Result<u32, String> {
        let s = s.strip_prefix('L').unwrap_or(s);
        match s.parse::<u32>() {
            Ok(n) if n >= 1 && s.bytes().all(|b| b.is_ascii_digit()) => Ok(n),
            _ => Err(bad()),
        }
    };
    match body.split_once('-') {
        None => Ok(Lines {
            start: number(body)?,
            end: None,
        }),
        Some((a, b)) => {
            let (start, end) = (number(a)?, number(b)?);
            if end < start {
                return Err(format!("`#{fragment}` ends before it starts"));
            }
            Ok(Lines {
                start,
                end: (end != start).then_some(end),
            })
        }
    }
}

/// A canvas is named by the id the Canvas app makes of it, which drops a
/// leading `canvas/` and a `.json`. Any other spelling would have `live` test
/// one file and the app open another.
fn own_canvas_id(id: &str) -> Result<(), String> {
    match crate::apps::canvas::canvas_id(id) {
        Ok(own) if own == id => Ok(()),
        Ok(own) => Err(format!(
            "`{id}` is spelt as a path; name the canvas `kaava://canvas/{own}`"
        )),
        Err(e) => Err(e.message),
    }
}

/// `frame=<id or name>` or `comment=<id>`.
fn parse_canvas_part(fragment: &str) -> Result<CanvasPart, String> {
    let (key, value) = fragment
        .split_once('=')
        .ok_or_else(|| format!("`#{fragment}` should be `#frame=<id>` or `#comment=<id>`"))?;
    let value = decode(value)?;
    if value.is_empty() || value.chars().count() > 256 {
        return Err(format!("`#{fragment}` names nothing"));
    }
    match key {
        "frame" => Ok(CanvasPart::Frame(value)),
        "comment" => match crate::apps::canvas::comments::validate_comment_id(&value) {
            Ok(()) => Ok(CanvasPart::Comment(value)),
            Err(_) => Err(format!(
                "`{value}` is not a comment id: those are lowercase letters, digits and -"
            )),
        },
        _ => Err(format!(
            "`#{fragment}` should be `#frame=<id>` or `#comment=<id>`"
        )),
    }
}

/// Percent-decode one path, keeping its `/` separators as they were written.
fn decode_path(tail: &str) -> Result<String, String> {
    tail.split('/')
        .map(decode)
        .collect::<Result<Vec<_>, _>>()
        .map(|segments| segments.join("/"))
}

/// Percent-decode, refusing invalid escapes, invalid UTF-8 and control characters.
fn decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| format!("`{s}` has a broken `%` escape"))?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let text = String::from_utf8(out).map_err(|_| format!("`{s}` is not valid UTF-8"))?;
    if text.chars().any(char::is_control) {
        return Err("a reference may not contain control characters".into());
    }
    Ok(text)
}

/// Percent-encode everything but unreserved characters, plus `/` when `keep_slash`.
fn encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let plain = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
        if plain || (keep_slash && b == b'/') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl fmt::Display for Ref {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{SCHEME}{}", self.scheme_kind())?;
        match self {
            Ref::File { path, lines } => {
                write!(f, "/{}", encode(path, true))?;
                if let Some(l) = lines {
                    write!(f, "#L{}", l.start)?;
                    if let Some(end) = l.end {
                        write!(f, "-L{end}")?;
                    }
                }
                Ok(())
            }
            Ref::Canvas { id, part } => {
                write!(f, "/{}", encode(id, true))?;
                match part {
                    Some(CanvasPart::Frame(frame)) => write!(f, "#frame={}", encode(frame, false)),
                    Some(CanvasPart::Comment(c)) => write!(f, "#comment={}", encode(c, false)),
                    None => Ok(()),
                }
            }
            Ref::Comment { id } | Ref::DesignComment { id } | Ref::Context { id } => {
                write!(f, "/{id}")
            }
            Ref::Selection => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, lines: Option<Lines>) -> Ref {
        Ref::File {
            path: path.into(),
            lines,
        }
    }

    #[test]
    fn every_kind_round_trips_through_its_canonical_form() {
        let cases = [
            "kaava://file/scripts/player.gd",
            "kaava://file/scripts/player.gd#L10",
            "kaava://file/scripts/player.gd#L10-L20",
            "kaava://file/art/hero%20sheet.png",
            "kaava://canvas/levels/hospital",
            "kaava://canvas/levels/hospital#frame=f_12",
            "kaava://canvas/world#frame=Main%20Menu",
            "kaava://canvas/world#comment=c-1",
            "kaava://comment/0190af3c2b1e-a1b2",
            "kaava://design-comment/dc_7",
            "kaava://context/ctx_0123abcd",
            "kaava://selection",
        ];
        for case in cases {
            let parsed = parse(case).unwrap_or_else(|e| panic!("{case}: {e}"));
            assert_eq!(parsed.to_string(), case);
        }
    }

    #[test]
    fn a_line_range_is_accepted_in_both_spellings_and_written_in_one() {
        let expected = file(
            "a.rs",
            Some(Lines {
                start: 3,
                end: Some(9),
            }),
        );
        assert_eq!(parse("kaava://file/a.rs#L3-9").unwrap(), expected);
        assert_eq!(parse("kaava://file/a.rs#L3-L9").unwrap(), expected);
        assert_eq!(expected.to_string(), "kaava://file/a.rs#L3-L9");
        let single = parse("kaava://file/a.rs#L4-L4").unwrap();
        assert_eq!(single.to_string(), "kaava://file/a.rs#L4");
    }

    #[test]
    fn a_backwards_or_zero_range_is_refused() {
        assert!(parse("kaava://file/a.rs#L9-L3").is_err());
        assert!(parse("kaava://file/a.rs#L0").is_err());
        assert!(parse("kaava://file/a.rs#L+3").is_err());
        assert!(parse("kaava://file/a.rs#10").is_err());
    }

    #[test]
    fn the_scheme_is_case_insensitive_and_nothing_else_is() {
        assert_eq!(parse("KAAVA://file/a.rs").unwrap(), file("a.rs", None));
        assert!(parse("kaava://File/a.rs").is_err());
    }

    #[test]
    fn a_path_that_could_leave_the_root_never_parses() {
        for bad in [
            "kaava://file/../secret.txt",
            "kaava://file/a/../../b",
            "kaava://file/%2e%2e/b",
            "kaava://file/C:/Windows/win.ini",
            "kaava://file//etc/passwd",
            "kaava://file/a%5Cb",
            "kaava://file/a%00b",
            "kaava://file/",
            "kaava://canvas/../x",
        ] {
            assert!(parse(bad).is_err(), "{bad} parsed");
        }
    }

    #[test]
    fn ids_are_single_safe_segments() {
        assert!(parse("kaava://comment/a/b").is_err());
        assert!(parse("kaava://context/ctx_1%2F2").is_err());
        assert!(parse("kaava://design-comment/").is_err());
        assert!(parse("kaava://comment/x#L1").is_err());
    }

    #[test]
    fn junk_is_refused_with_a_sentence() {
        assert!(parse("file:///a.rs").unwrap_err().contains("kaava://"));
        assert!(parse("kaava://").is_err());
        assert!(parse("kaava://shell/x")
            .unwrap_err()
            .contains("not a reference kind"));
        assert!(parse("kaava://file/a.rs?raw=1").is_err());
        assert!(parse("kaava://file/a%zz").is_err());
        assert!(parse("kaava://selection/x").is_err());
        let long = format!("kaava://file/{}", "a".repeat(MAX_URI_CHARS));
        assert!(parse(&long).is_err());
    }

    #[test]
    fn a_canvas_fragment_must_name_its_part() {
        assert!(parse("kaava://canvas/w#frame=").is_err());
        assert!(parse("kaava://canvas/w#shape=x").is_err());
        assert!(parse("kaava://canvas/w#L3").is_err());
    }

    #[test]
    fn a_canvas_is_named_only_by_the_id_the_canvas_app_opens() {
        for (spelt, own) in [
            ("kaava://canvas/canvas/evil", "kaava://canvas/evil"),
            ("kaava://canvas/world.json", "kaava://canvas/world"),
            ("kaava://canvas/world.canvas.json", "kaava://canvas/world"),
        ] {
            let why = parse(spelt).unwrap_err();
            assert!(why.contains(own), "{spelt}: {why}");
        }
        for bad in ["kaava://canvas/World", "kaava://canvas/a%20b", "kaava://canvas/-x"] {
            assert!(parse(bad).unwrap_err().contains("not a slug"), "{bad}");
        }
        assert!(parse("kaava://canvas/levels/ward-b_2").is_ok());
    }

    #[test]
    fn a_comment_id_is_one_the_canvas_app_could_have_made() {
        let ok = parse("kaava://canvas/w#comment=c-18f2a-0a1b2c").unwrap();
        assert!(matches!(ok, Ref::Canvas { part: Some(CanvasPart::Comment(_)), .. }));
        for bad in ["..%2Fx", "a%2Fb", "C-1", "c_1", &"c".repeat(65)] {
            let uri = format!("kaava://canvas/w#comment={bad}");
            assert!(parse(&uri).unwrap_err().contains("not a comment id"), "{uri}");
        }
        assert!(parse("kaava://canvas/w#frame=Ward%20B").is_ok(), "a frame may be a name");
    }
}
