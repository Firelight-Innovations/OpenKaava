//! Turning a reference into something to show a person and something an agent
//! can read: the same [`Resolved`] serves both, as parts (text, image, JSON, a
//! note) plus the metadata a chip needs.
//!
//! Everything here is bounded. An excerpt stops at [`MAX_EXCERPT_LINES`] or
//! [`MAX_EXCERPT_BYTES`], and so does any prose an app holds, such as a
//! comment's text. A file is never scanned past [`MAX_SCAN_BYTES`]. An image
//! over [`MAX_IMAGE_BYTES`], or a JSON part over [`MAX_JSON_BYTES`] once
//! written out, is described rather than sent.

use super::assets::{self, Kind};
use super::policy;
use super::uri::{Lines, Ref};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

/// Most lines one excerpt carries.
pub const MAX_EXCERPT_LINES: u32 = 1000;
/// Most bytes one excerpt carries.
pub const MAX_EXCERPT_BYTES: usize = 64 * 1024;
/// A file is read no further than this looking for a line range.
pub const MAX_SCAN_BYTES: u64 = 16 * 1024 * 1024;
/// Largest image sent inline. Base64 makes it about 4.7 MB, under the 5 MB a
/// model provider accepts per image.
pub const MAX_IMAGE_BYTES: u64 = 3_500_000;
/// Largest JSON part sent, written out.
pub const MAX_JSON_BYTES: usize = 64 * 1024;
/// How much of a model file is read for its header facts.
const MAX_MODEL_HEAD: u64 = 4 * 1024 * 1024;
/// How much of any file is read to decide what it is.
const HEAD_BYTES: u64 = 64 * 1024;
/// Most entries a folder reference lists.
const MAX_FOLDER_ENTRIES: usize = 200;
/// Largest viewer comment record read. A real one is a few hundred bytes.
const MAX_COMMENT_BYTES: u64 = 1024 * 1024;

/// A reference, resolved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// The canonical form of the reference that was resolved.
    pub uri: String,
    /// `text`, `image`, `model`, `scene`, `audio`, `video`, `binary`, `folder`,
    /// `canvas`, `frame`, `comment`, `design-comment`, `context` or `selection`.
    pub kind: String,
    /// A short label: a file name, a frame name, a comment's first line.
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub meta: Map<String, Value>,
    pub parts: Vec<Part>,
    /// Why nothing (or less) was read. Set for secrets, gitignored files and
    /// anything over a cap; `parts` then carries no content from the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub withheld: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Part {
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        /// The file line `text` starts at, 1-based.
        start_line: u32,
        truncated: bool,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        mime: String,
        data_base64: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        width: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        height: Option<u32>,
    },
    Json {
        value: Value,
    },
    Note {
        text: String,
    },
}

impl Resolved {
    /// A result with no parts yet.
    pub(super) fn empty(r: &Ref, kind: &str, title: impl Into<String>) -> Self {
        Self {
            uri: r.to_string(),
            kind: kind.into(),
            title: title.into(),
            detail: None,
            meta: Map::new(),
            parts: Vec::new(),
            withheld: None,
        }
    }

    fn withhold(mut self, why: impl Into<String>) -> Self {
        self.parts.clear();
        self.withheld = Some(why.into());
        self
    }
}

/// Resolve a file or folder reference inside `root`.
pub fn file(root: &Path, r: &Ref) -> Result<Resolved, String> {
    let Ref::File { path, lines } = r else {
        return Err("not a file reference".into());
    };
    let found = policy::contain(root, path)?;
    let name = path.rsplit('/').next().unwrap_or(path);
    let mut out = Resolved::empty(r, "binary", name);
    out.detail = Some(detail_for(path, *lines));
    // A link inside the project that lands on a secret is still a secret.
    let rule = policy::secret_rule(path).or_else(|| policy::secret_rule(&found.rel));
    if let Some(rule) = rule {
        return Ok(out.withhold(secret_withheld(rule)));
    }
    if policy::ignored(&found.root, &found.abs) {
        return Ok(out.withhold(
            "withheld: this file is gitignored, so Kaava names it but does not read it",
        ));
    }
    if found.abs.is_dir() {
        return folder(out, &found.root, &found.abs);
    }
    describe(out, &found.abs, *lines)
}

fn secret_withheld(rule: &str) -> String {
    format!("withheld: {rule} are never read or shown through a reference")
}

fn detail_for(path: &str, lines: Option<Lines>) -> String {
    match lines {
        Some(Lines {
            start,
            end: Some(end),
        }) => format!("{path} · lines {start}–{end}"),
        Some(Lines { start, end: None }) => format!("{path} · line {start}"),
        None => path.to_string(),
    }
}

/// Fill in a file's kind, metadata and parts. Shared by file references and by
/// context items Kaava stored itself, which skip the gitignore screen.
pub(super) fn describe(
    mut out: Resolved,
    abs: &Path,
    lines: Option<Lines>,
) -> Result<Resolved, String> {
    let meta = std::fs::metadata(abs).map_err(|e| format!("cannot read that file: {e}"))?;
    let size = meta.len();
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let head = read_prefix(abs, HEAD_BYTES)?;
    let mut class = assets::classify(&name);
    let textual = assets::looks_textual(&head);
    if class.kind == Kind::Binary && textual {
        class = assets::classify("plain.txt");
    }
    out.kind = class.kind.name().into();
    out.meta.insert("size".into(), json!(size));
    out.meta.insert("mime".into(), json!(class.mime));
    if let Some(ms) = modified_ms(&meta) {
        out.meta.insert("modified".into(), json!(ms));
    }
    if let Some(rule) = policy::secret_content(&head) {
        return Ok(out.withhold(secret_withheld(rule)));
    }

    if class.kind == Kind::Image {
        out = image(out, abs, size, &head, &class)?;
        // An SVG is also text, but one withheld as too big stays withheld.
        if !class.textual || out.withheld.is_some() {
            return Ok(out);
        }
    }
    match class.kind {
        Kind::Model => {
            let bytes = read_prefix(abs, MAX_MODEL_HEAD)?;
            out.meta.extend(assets::model_facts(&ext, &bytes));
        }
        Kind::Audio if ext == "wav" => out.meta.extend(assets::wav_facts(&head, size)),
        _ => {}
    }
    if class.textual && textual {
        let ex = excerpt(abs, lines)?;
        if let Some(total) = ex.total_lines {
            out.meta.insert("lines".into(), json!(total));
        }
        out.parts.push(Part::Text {
            text: ex.text,
            language: class.language.map(str::to_owned),
            start_line: ex.start,
            truncated: ex.truncated,
        });
    } else if out.parts.is_empty() {
        out.parts.push(Part::Note {
            text: format!("{} file, {}; no preview", out.kind, human_size(size)),
        });
    }
    Ok(out)
}

/// An image part when the bytes are a raster format a model accepts and the
/// file is under the cap; anything else is a note. An SVG under the cap gets no
/// part here: it is text, which [`describe`] sends once as an excerpt, and no
/// model provider takes one as an image.
fn image(
    mut out: Resolved,
    abs: &Path,
    size: u64,
    head: &[u8],
    class: &assets::Class,
) -> Result<Resolved, String> {
    let sniffed = crate::context::sniff(head);
    if let Some(s) = &sniffed {
        if let Some((w, h)) = s.dims {
            out.meta.insert("width".into(), json!(w));
            out.meta.insert("height".into(), json!(h));
        }
    }
    let svg = class.mime == "image/svg+xml";
    if sniffed.is_none() && !svg {
        out.parts.push(Part::Note {
            text: format!("image, {}; this format has no preview", human_size(size)),
        });
        return Ok(out);
    }
    if size > MAX_IMAGE_BYTES {
        return Ok(out.withhold(format!(
            "withheld: the image is {}, over the {} that is sent inline",
            human_size(size),
            human_size(MAX_IMAGE_BYTES)
        )));
    }
    let Some(mime) = sniffed.as_ref().map(|s| s.mime) else {
        return Ok(out);
    };
    let bytes = read_prefix(abs, MAX_IMAGE_BYTES)?;
    out.parts.push(Part::Image {
        mime: mime.into(),
        data_base64: BASE64.encode(bytes),
        width: sniffed.as_ref().and_then(|s| s.dims).map(|d| d.0),
        height: sniffed.as_ref().and_then(|s| s.dims).map(|d| d.1),
    });
    Ok(out)
}

/// A folder's entries, folders first, secrets and gitignored entries left out.
fn folder(mut out: Resolved, root: &Path, abs: &Path) -> Result<Resolved, String> {
    out.kind = "folder".into();
    let reader = std::fs::read_dir(abs).map_err(|e| format!("cannot list that folder: {e}"))?;
    let mut entries: Vec<(bool, String)> = Vec::new();
    let mut hidden = 0usize;
    let rules = policy::Ignores::for_folder(root, abs);
    for entry in reader.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if policy::secret_rule(&rel).is_some() || rules.ignored(&path, path.is_dir()) {
            hidden += 1;
            continue;
        }
        entries.push((path.is_dir(), name));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let total = entries.len();
    let names: Vec<String> = entries
        .into_iter()
        .take(MAX_FOLDER_ENTRIES)
        .map(|(dir, name)| if dir { format!("{name}/") } else { name })
        .collect();
    out.meta.insert("entries".into(), json!(total));
    if hidden > 0 {
        out.meta.insert("hidden".into(), json!(hidden));
    }
    out.parts.push(Part::Text {
        text: names.join("\n"),
        language: None,
        start_line: 1,
        truncated: total > MAX_FOLDER_ENTRIES,
    });
    Ok(out)
}

struct Excerpt {
    text: String,
    start: u32,
    truncated: bool,
    /// Known only when the whole file was read.
    total_lines: Option<u32>,
}

/// Lines `lines` of a text file (or its start), within the caps.
fn excerpt(abs: &Path, lines: Option<Lines>) -> Result<Excerpt, String> {
    excerpt_within(abs, lines, MAX_SCAN_BYTES)
}

/// [`excerpt`], reading at most `scan` bytes of the file.
fn excerpt_within(abs: &Path, lines: Option<Lines>, scan: u64) -> Result<Excerpt, String> {
    let file = std::fs::File::open(abs).map_err(|e| format!("cannot open that file: {e}"))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = BufReader::new(file).take(scan);
    let start = lines.map_or(1, |l| l.start);
    let last = lines.map(Lines::last);
    let (mut text, mut buf) = (String::new(), Vec::new());
    let (mut line_no, mut taken) = (0u32, 0u32);
    let (mut truncated, mut eof) = (false, false);
    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("cannot read that file: {e}"))?;
        if n == 0 {
            eof = true;
            break;
        }
        line_no += 1;
        if line_no < start {
            continue;
        }
        if last.is_some_and(|last| line_no > last) {
            break;
        }
        let line = String::from_utf8_lossy(&buf);
        if taken >= MAX_EXCERPT_LINES || text.len() + line.len() > MAX_EXCERPT_BYTES {
            if text.is_empty() {
                text.push_str(cut(&line, MAX_EXCERPT_BYTES));
            }
            truncated = true;
            break;
        }
        text.push_str(&line);
        taken += 1;
    }
    // The scan limit looks like the end of the file to the reader, so it is
    // told apart here: a file longer than the limit was cut, not finished.
    let capped = eof && reader.limit() == 0 && size > scan;
    if lines.is_some() && line_no < start && eof {
        return Err(if capped {
            format!(
                "line {start} is past the first {} of the file, which is as far as a reference reads",
                human_size(scan)
            )
        } else {
            format!("the file has {line_no} lines, so line {start} does not exist")
        });
    }
    let complete = eof && !capped;
    if capped || (!complete && last.is_none()) {
        truncated = true;
    }
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    Ok(Excerpt {
        text,
        start,
        truncated,
        total_lines: complete.then_some(line_no),
    })
}

/// The longest prefix of `s` within `max` bytes that ends on a character boundary.
fn cut(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn read_prefix(abs: &Path, max: u64) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(abs).map_err(|e| format!("cannot open that file: {e}"))?;
    let mut bytes = Vec::new();
    file.take(max)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read that file: {e}"))?;
    Ok(bytes)
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    let since = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    u64::try_from(since.as_millis()).ok()
}

/// `512 B`, `12.3 KB`, `4.6 MB`.
pub fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let kb = bytes as f64 / KB;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if (kb * 10.0).round() < KB * 10.0 {
        format!("{kb:.1} KB")
    } else {
        // Chosen after rounding, so 1,048,575 bytes reads 1.0 MB, not 1024.0 KB.
        format!("{:.1} MB", kb / KB)
    }
}

/// The first line of some prose, cut to 80 characters, for a title.
pub fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut out: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        out.push('…');
    }
    out
}

/// Prose an app holds, such as a comment's text, as a text part. It is cut at
/// [`MAX_EXCERPT_BYTES`], on a character boundary, as a file excerpt is.
pub fn prose_part(text: &str, language: Option<&str>) -> Part {
    let mut end = text.len().min(MAX_EXCERPT_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Part::Text {
        text: text[..end].to_string(),
        language: language.map(str::to_owned),
        start_line: 1,
        truncated: end < text.len(),
    }
}

/// `value` as a JSON part, or a note giving its size when it is over
/// [`MAX_JSON_BYTES`] written out.
pub fn json_part(value: Value) -> Part {
    let size = serde_json::to_vec(&value).map_or(0, |b| b.len());
    if size > MAX_JSON_BYTES {
        return Part::Note {
            text: format!(
                "The structured detail is {}, over the {} cap, so it is not sent.",
                human_size(size as u64),
                human_size(MAX_JSON_BYTES as u64)
            ),
        };
    }
    Part::Json { value }
}

/// A PNG (or other sniffed raster) on disk as an image part, under the inline cap.
pub fn png_part(path: &Path) -> Result<Part, String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("cannot read the picture: {e}"))?
        .len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "the picture is {}, over the {} sent inline",
            human_size(size),
            human_size(MAX_IMAGE_BYTES)
        ));
    }
    let bytes = read_prefix(path, MAX_IMAGE_BYTES)?;
    let sniffed = crate::context::sniff(&bytes).ok_or("the picture is not an image")?;
    Ok(Part::Image {
        mime: sniffed.mime.into(),
        data_base64: BASE64.encode(&bytes),
        width: sniffed.dims.map(|d| d.0),
        height: sniffed.dims.map(|d| d.1),
    })
}

/// An item in the context store. One Kaava stored itself is read where it
/// lies; one that references a project file goes through every file rule.
pub fn context_item(root: &Path, r: &Ref) -> Result<Resolved, String> {
    let Ref::Context { id } = r else {
        return Err("not a context reference".into());
    };
    let item = crate::context::get(root, id).map_err(|e| e.message)?;
    if !item.owned && !item.rel_path.is_empty() {
        let inner = Ref::File {
            path: item.rel_path.clone(),
            lines: None,
        };
        let mut out = file(root, &inner)?;
        out.uri = r.to_string();
        out.title = item.title;
        out.meta.insert("file".into(), json!(inner.to_string()));
        return Ok(out);
    }
    let out = Resolved::empty(r, "context", item.title.clone());
    if item.missing {
        return Ok(out.withhold("the stored file has been deleted or moved"));
    }
    // A copy's title is free text; the file it was copied from and the
    // copy's own name say what it is.
    let names = [
        Some(item.title.as_str()),
        item.key.strip_prefix("file/"),
        Some(item.rel_path.as_str()),
    ];
    if let Some(rule) = names.into_iter().flatten().find_map(policy::secret_rule) {
        return Ok(out.withhold(secret_withheld(rule)));
    }
    // A hand-edited sidecar could point anywhere: only a file that really is
    // inside this project's store is read.
    let found = policy::contain(root, &item.rel_path)
        .ok()
        .filter(|f| policy::inside_store(&f.rel))
        .ok_or("that context item's file is not in this project's context store")?;
    let mut out = describe(out, &found.abs, None)?;
    out.detail = item.source.label.or(Some(item.source.app_id));
    out.meta.insert("context".into(), json!(item.id));
    Ok(out)
}

/// A viewer comment, `.kaava/comments/<id>.json`, and its screenshot.
pub fn viewer_comment(root: &Path, r: &Ref) -> Result<Resolved, String> {
    let Ref::Comment { id } = r else {
        return Err("not a comment reference".into());
    };
    let record = policy::contain(root, &format!(".kaava/comments/{id}.json"))
        .map_err(|_| format!("there is no comment `{id}` in this project"))?;
    let raw = read_prefix(&record.abs, MAX_COMMENT_BYTES + 1)?;
    if raw.len() as u64 > MAX_COMMENT_BYTES {
        return Err(format!(
            "comment `{id}` is over {}, which is more than a comment holds",
            human_size(MAX_COMMENT_BYTES)
        ));
    }
    let comment: crate::comments::Comment =
        serde_json::from_slice(&raw).map_err(|e| format!("comment `{id}` is unreadable: {e}"))?;
    let mut out = Resolved::empty(r, "comment", first_line(&comment.body));
    out.detail = Some(anchor_line(&comment.anchor));
    out.meta.insert("status".into(), json!(comment.status));
    out.meta.insert("author".into(), json!(comment.author));
    out.parts.push(prose_part(&comment.body, Some("markdown")));
    out.parts.push(json_part(
        serde_json::to_value(&comment).unwrap_or(Value::Null),
    ));
    if let Ok(shot) = policy::contain(root, &format!(".kaava/comments/{id}.png")) {
        out.parts
            .push(png_part(&shot.abs).unwrap_or_else(|why| Part::Note {
                text: format!("No screenshot: {why}"),
            }));
    }
    Ok(out)
}

fn anchor_line(anchor: &crate::comments::Anchor) -> String {
    use crate::comments::Anchor;
    match anchor {
        Anchor::Node { path } => format!("Godot node {path}"),
        Anchor::Mesh { part, material } => format!("Blender mesh {part} · {material}"),
        Anchor::Scene { scene, time, .. } => format!("Play · {scene} at {time:.1}s"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::uri::parse;
    use tempfile::TempDir;

    fn project() -> TempDir {
        TempDir::new().expect("tempdir")
    }

    fn put(dir: &TempDir, rel: &str, bytes: &[u8]) {
        let path = dir.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn resolve(dir: &TempDir, uri: &str) -> Result<Resolved, String> {
        let r = parse(uri)?;
        match r {
            Ref::Context { .. } => context_item(dir.path(), &r),
            Ref::Comment { .. } => viewer_comment(dir.path(), &r),
            _ => file(dir.path(), &r),
        }
    }

    fn text_of(r: &Resolved) -> (&str, u32, bool) {
        match r.parts.first() {
            Some(Part::Text {
                text,
                start_line,
                truncated,
                ..
            }) => (text.as_str(), *start_line, *truncated),
            other => panic!("expected a text part, got {other:?}"),
        }
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    #[test]
    fn a_line_range_comes_back_as_exactly_those_lines() {
        let dir = project();
        let body: String = (1..=50).map(|n| format!("line {n}\n")).collect();
        put(&dir, "scripts/player.gd", body.as_bytes());
        let r = resolve(&dir, "kaava://file/scripts/player.gd#L10-L12").unwrap();
        assert_eq!(r.kind, "text");
        assert_eq!(r.title, "player.gd");
        assert_eq!(text_of(&r), ("line 10\nline 11\nline 12", 10, false));
        assert_eq!(r.detail.as_deref(), Some("scripts/player.gd · lines 10–12"));
        let whole = resolve(&dir, "kaava://file/scripts/player.gd").unwrap();
        assert_eq!(whole.meta["lines"], 50);
        assert!(resolve(&dir, "kaava://file/scripts/player.gd#L51")
            .unwrap_err()
            .contains("50 lines"));
    }

    #[test]
    fn an_empty_file_is_an_empty_excerpt_not_an_error() {
        let dir = project();
        put(&dir, "empty.txt", b"");
        let r = resolve(&dir, "kaava://file/empty.txt").unwrap();
        assert_eq!(text_of(&r), ("", 1, false));
    }

    #[test]
    fn excerpts_stop_at_the_line_and_byte_caps() {
        let dir = project();
        let many: String = (0..MAX_EXCERPT_LINES + 50)
            .map(|n| format!("{n}\n"))
            .collect();
        put(&dir, "many.txt", many.as_bytes());
        let r = resolve(&dir, "kaava://file/many.txt").unwrap();
        let (text, _, truncated) = text_of(&r);
        assert!(truncated);
        assert_eq!(text.lines().count(), MAX_EXCERPT_LINES as usize);

        let wide = "é".repeat(MAX_EXCERPT_BYTES);
        put(&dir, "wide.txt", wide.as_bytes());
        let r = resolve(&dir, "kaava://file/wide.txt").unwrap();
        let (text, _, truncated) = text_of(&r);
        assert!(truncated);
        assert!(text.len() <= MAX_EXCERPT_BYTES && !text.is_empty());
    }

    /// The scan limit is not the end of the file: a range it cuts is flagged,
    /// and a line beyond it is not reported as missing.
    #[test]
    fn the_scan_limit_cuts_a_range_rather_than_ending_the_file() {
        let dir = project();
        let body: String = (1..=100).map(|n| format!("{n:03}\n")).collect();
        put(&dir, "big.csv", body.as_bytes());
        let abs = dir.path().join("big.csv");
        let range = |start, end| {
            Some(Lines {
                start,
                end: Some(end),
            })
        };

        let cut = excerpt_within(&abs, range(5, 30), 80).unwrap();
        assert!(cut.truncated, "lines 21-30 lie past the limit");
        assert_eq!(cut.total_lines, None);
        let err = excerpt_within(&abs, range(50, 50), 80).err().unwrap();
        assert!(err.contains("past the first"), "{err}");
        let whole = excerpt_within(&abs, None, body.len() as u64).unwrap();
        assert!(!whole.truncated);
        assert_eq!(whole.total_lines, Some(100));
    }

    #[test]
    fn secrets_are_withheld_and_say_which_rule() {
        let dir = project();
        put(&dir, ".env", b"API_KEY=hunter2\n");
        put(&dir, "config/.env.example", b"API_KEY=\n");
        put(&dir, "android/release.keystore", b"\x00\x01");
        let env = resolve(&dir, "kaava://file/.env").unwrap();
        assert!(env.parts.is_empty());
        assert!(env.withheld.unwrap().contains(".env files"));
        let template = resolve(&dir, "kaava://file/config/.env.example").unwrap();
        assert!(template.withheld.is_none());
        let key = resolve(&dir, "kaava://file/android/release.keystore").unwrap();
        assert!(key.withheld.unwrap().contains("key stores"));
    }

    #[test]
    fn gitignored_files_are_named_but_not_read() {
        let dir = project();
        put(&dir, ".gitignore", b"build/\n*.log\n!keep.log\n");
        put(&dir, "build/out.txt", b"built\n");
        put(&dir, "debug.log", b"noise\n");
        put(&dir, "keep.log", b"kept\n");
        put(&dir, "nested/.gitignore", b"local.txt\n");
        put(&dir, "nested/local.txt", b"mine\n");
        for uri in [
            "kaava://file/build/out.txt",
            "kaava://file/debug.log",
            "kaava://file/nested/local.txt",
        ] {
            let r = resolve(&dir, uri).unwrap();
            assert!(r.withheld.unwrap().contains("gitignored"), "{uri}");
            assert!(r.parts.is_empty());
        }
        assert!(resolve(&dir, "kaava://file/keep.log")
            .unwrap()
            .withheld
            .is_none());
    }

    #[test]
    fn a_missing_file_is_an_error_that_names_it() {
        let dir = project();
        assert!(resolve(&dir, "kaava://file/nope.gd")
            .unwrap_err()
            .contains("nope.gd"));
    }

    #[test]
    fn a_link_out_of_the_project_or_onto_a_secret_is_not_followed() {
        use crate::refs::links;
        let outside = project();
        put(&outside, "private.txt", b"not yours\n");
        let dir = project();
        put(&dir, ".env", b"TOKEN=1\n");
        put(&dir, ".ssh/config", b"Host x\n");

        links::folder(outside.path(), &dir.path().join("linkdir"));
        let err = resolve(&dir, "kaava://file/linkdir/private.txt").unwrap_err();
        assert!(err.contains("outside the project"), "through a folder: {err}");
        let err = resolve(&dir, "kaava://file/linkdir").unwrap_err();
        assert!(err.contains("outside the project"), "the folder: {err}");
        links::folder(&dir.path().join(".ssh"), &dir.path().join("sshdir"));
        let r = resolve(&dir, "kaava://file/sshdir/config").unwrap();
        assert!(r.withheld.unwrap().contains(".ssh"), "named by its target");

        if !links::file(
            &outside.path().join("private.txt"),
            &dir.path().join("away.txt"),
        ) {
            return;
        }
        let err = resolve(&dir, "kaava://file/away.txt").unwrap_err();
        assert!(err.contains("outside the project"), "{err}");
        assert!(links::file(
            &dir.path().join(".env"),
            &dir.path().join("notes.txt")
        ));
        let r = resolve(&dir, "kaava://file/notes.txt").unwrap();
        assert!(r.withheld.unwrap().contains(".env"));
    }

    #[test]
    fn an_image_comes_back_inline_with_its_size_until_the_cap() {
        let dir = project();
        put(&dir, "art/hero.png", &png(64, 32));
        let r = resolve(&dir, "kaava://file/art/hero.png").unwrap();
        assert_eq!(r.kind, "image");
        assert_eq!(r.meta["width"], 64);
        match &r.parts[0] {
            Part::Image { mime, height, .. } => {
                assert_eq!(mime, "image/png");
                assert_eq!(*height, Some(32));
            }
            other => panic!("{other:?}"),
        }
        let mut big = png(4000, 4000);
        big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        put(&dir, "art/huge.png", &big);
        let huge = resolve(&dir, "kaava://file/art/huge.png").unwrap();
        assert!(huge.withheld.unwrap().contains("over the"));
        assert!(huge.parts.is_empty());
        assert_eq!(huge.meta["width"], 4000);
    }

    #[test]
    fn an_apps_prose_and_json_stop_at_their_caps() {
        let small = json!({ "status": "open" });
        assert_eq!(json_part(small.clone()), Part::Json { value: small });
        let big = json!({ "props": "x".repeat(MAX_JSON_BYTES) });
        assert!(
            matches!(json_part(big), Part::Note { text } if text.contains("over the 64.0 KB cap"))
        );

        let whole = prose_part("Move the door", Some("markdown"));
        assert!(matches!(whole, Part::Text { truncated: false, .. }));
        let long = format!("{}\u{e9}", "a".repeat(MAX_EXCERPT_BYTES - 1));
        match prose_part(&long, None) {
            Part::Text {
                text, truncated, ..
            } => {
                assert_eq!(
                    text.len(),
                    MAX_EXCERPT_BYTES - 1,
                    "cut before the two-byte é"
                );
                assert!(truncated);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_size_reads_in_the_unit_its_rounded_value_fits() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(1_048_575), "1.0 MB");
        assert_eq!(human_size(3_500_000), "3.3 MB");
    }

    #[test]
    fn an_svg_is_sent_once_as_its_text() {
        let dir = project();
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>\n";
        put(&dir, "art/dot.svg", svg.as_bytes());
        let r = resolve(&dir, "kaava://file/art/dot.svg").unwrap();
        assert_eq!(r.kind, "image");
        assert_eq!(r.meta["mime"], "image/svg+xml");
        match r.parts.as_slice() {
            [Part::Text { text, language, .. }] => {
                assert_eq!(text, svg.trim_end());
                assert_eq!(language.as_deref(), Some("xml"));
            }
            other => panic!("one text part, not {other:?}"),
        }
    }

    #[test]
    fn an_svg_over_the_cap_is_withheld_and_not_sent_as_text() {
        let dir = project();
        let mut svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\">".to_vec();
        svg.resize(MAX_IMAGE_BYTES as usize + 1, b' ');
        put(&dir, "art/huge.svg", &svg);
        let huge = resolve(&dir, "kaava://file/art/huge.svg").unwrap();
        assert!(huge.withheld.unwrap().contains("over the"));
        assert!(huge.parts.is_empty(), "{:?}", huge.parts);
    }

    #[test]
    fn a_model_reports_its_header_and_an_unknown_binary_a_note() {
        let dir = project();
        let json = br#"{"asset":{"version":"2.0"},"meshes":[{}],"animations":[{},{}]}  "#;
        let mut glb = b"glTF".to_vec();
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&((20 + json.len()) as u32).to_le_bytes());
        glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
        glb.extend_from_slice(b"JSON");
        glb.extend_from_slice(json);
        put(&dir, "models/hero.glb", &glb);
        let r = resolve(&dir, "kaava://file/models/hero.glb").unwrap();
        assert_eq!(r.kind, "model");
        assert_eq!(r.meta["meshes"], 1);
        assert_eq!(r.meta["animations"], 2);
        assert!(matches!(r.parts[0], Part::Note { .. }));
        put(&dir, "blob.dat", &[0u8, 1, 2, 3]);
        let blob = resolve(&dir, "kaava://file/blob.dat").unwrap();
        assert_eq!(blob.kind, "binary");
    }

    #[test]
    fn a_folder_lists_its_entries_but_not_its_secrets() {
        let dir = project();
        put(&dir, ".gitignore", b"*.tmp\n");
        put(&dir, "level/a.tscn", b"[gd_scene]\n");
        put(&dir, "level/props/b.glb", b"glTF");
        put(&dir, "level/.env", b"X=1\n");
        put(&dir, "level/scratch.tmp", b"tmp\n");
        let r = resolve(&dir, "kaava://file/level").unwrap();
        assert_eq!(r.kind, "folder");
        assert_eq!(text_of(&r).0, "props/\na.tscn");
        assert_eq!(r.meta["hidden"], 2);
    }

    #[test]
    fn a_stored_context_image_resolves_and_a_referenced_file_obeys_the_file_rules() {
        let dir = project();
        let shot = crate::context::put(
            dir.path(),
            crate::context::PutRequest {
                key: Some("play/frame".into()),
                kind: None,
                title: Some("Play frame".into()),
                payload: crate::context::Payload::Bytes(png(8, 8)),
                app_id: "play".into(),
                label: None,
                method: crate::context::Method::Put,
                reference_in_place: true,
            },
        )
        .unwrap();
        let r = resolve(&dir, &format!("kaava://context/{}", shot.id)).unwrap();
        assert_eq!(r.kind, "image");
        assert_eq!(r.title, "Play frame");
        assert!(matches!(r.parts[0], Part::Image { .. }));

        put(&dir, ".env", b"A=1\n");
        let env = crate::context::put(
            dir.path(),
            crate::context::PutRequest {
                key: None,
                kind: None,
                title: None,
                payload: crate::context::Payload::Path(dir.path().join(".env")),
                app_id: "terminal".into(),
                label: None,
                method: crate::context::Method::Drop,
                reference_in_place: true,
            },
        )
        .unwrap();
        let r = resolve(&dir, &format!("kaava://context/{}", env.id)).unwrap();
        assert!(r.withheld.unwrap().contains(".env"));
    }

    #[test]
    fn a_copied_secret_is_withheld_by_where_it_came_from_or_what_it_holds() {
        let (dir, outside) = (project(), project());
        put(&outside, "deploy.pem", b"not a key, but named like one\n");
        put(
            &outside,
            "handoff",
            b"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n",
        );
        let copy = |name: &str, key: Option<&str>| {
            crate::context::put(
                dir.path(),
                crate::context::PutRequest {
                    key: key.map(Into::into),
                    kind: None,
                    title: Some("deploy notes".into()),
                    payload: crate::context::Payload::Path(outside.path().join(name)),
                    app_id: "terminal".into(),
                    label: None,
                    method: crate::context::Method::Drop,
                    reference_in_place: true,
                },
            )
            .unwrap()
        };
        for item in [
            copy("deploy.pem", None),
            copy("handoff", Some("notes/handoff")),
        ] {
            assert!(item.owned, "a file from outside is copied in");
            let r = resolve(&dir, &format!("kaava://context/{}", item.id)).unwrap();
            assert!(r.withheld.unwrap().contains("private keys"), "{}", item.key);
            assert!(r.parts.is_empty());
        }
    }

    #[test]
    fn a_viewer_comment_brings_its_text_and_screenshot() {
        let dir = project();
        let ctx = crate::apps::CallContext {
            cluster_id: None,
            project: Some(dir.path().to_path_buf()),
        };
        let c = crate::comments::create(
            &ctx,
            crate::comments::Draft {
                anchor: crate::comments::Anchor::Scene {
                    scene: "hospital.tscn".into(),
                    time: 12.5,
                    screenshot: false,
                },
                body: "The door clips through the wall\nsee frame".into(),
                screenshot_png: Some(png(4, 4)),
            },
        )
        .unwrap();
        let r = resolve(&dir, &format!("kaava://comment/{}", c.id)).unwrap();
        assert_eq!(r.title, "The door clips through the wall");
        assert_eq!(r.detail.as_deref(), Some("Play · hospital.tscn at 12.5s"));
        assert!(r.parts.iter().any(|p| matches!(p, Part::Image { .. })));
        assert!(resolve(&dir, "kaava://comment/nope").is_err());
    }

    #[test]
    fn an_oversized_comment_record_is_refused_unread() {
        let dir = project();
        let mut big = br#"{"body":""#.to_vec();
        big.resize(MAX_COMMENT_BYTES as usize + 1, b'x');
        put(&dir, ".kaava/comments/c-big.json", &big);
        let err = resolve(&dir, "kaava://comment/c-big").unwrap_err();
        assert!(err.contains("more than a comment holds"), "{err}");
    }
}
