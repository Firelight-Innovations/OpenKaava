//! What kind of thing a file is, from its name and its first bytes, and the
//! cheap facts worth reporting about it without decoding it: an image's size,
//! a model's mesh count, a sound's length.

use serde_json::{json, Map, Value};

/// The kinds a file reference resolves to. Text files of any language are
/// `Text`; a scene or a model that happens to be text keeps its own kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Image,
    Model,
    Scene,
    Audio,
    Video,
    Binary,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Text => "text",
            Kind::Image => "image",
            Kind::Model => "model",
            Kind::Scene => "scene",
            Kind::Audio => "audio",
            Kind::Video => "video",
            Kind::Binary => "binary",
        }
    }
}

/// What the extension says: the kind, a mime type, whether the bytes are text
/// (so an excerpt makes sense), and an editor language name for highlighting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Class {
    pub kind: Kind,
    pub mime: &'static str,
    pub textual: bool,
    pub language: Option<&'static str>,
}

const fn class(
    kind: Kind,
    mime: &'static str,
    textual: bool,
    language: Option<&'static str>,
) -> Class {
    Class {
        kind,
        mime,
        textual,
        language,
    }
}

/// Classify by extension. Unknown extensions are `Binary` here; the caller
/// sniffs the bytes and promotes text it finds.
pub fn classify(name: &str) -> Class {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let code = |lang| class(Kind::Text, "text/plain", true, Some(lang));
    match ext.as_str() {
        "png" => class(Kind::Image, "image/png", false, None),
        "jpg" | "jpeg" => class(Kind::Image, "image/jpeg", false, None),
        "gif" => class(Kind::Image, "image/gif", false, None),
        "webp" => class(Kind::Image, "image/webp", false, None),
        "svg" => class(Kind::Image, "image/svg+xml", true, Some("xml")),
        "bmp" | "tga" | "psd" | "exr" | "hdr" | "dds" | "ktx" | "ktx2" | "ico" | "tif" | "tiff" => {
            class(Kind::Image, "application/octet-stream", false, None)
        }
        "glb" => class(Kind::Model, "model/gltf-binary", false, None),
        "gltf" => class(Kind::Model, "model/gltf+json", true, Some("json")),
        "obj" => class(Kind::Model, "model/obj", true, None),
        "dae" => class(Kind::Model, "model/vnd.collada+xml", true, Some("xml")),
        "usda" => class(Kind::Model, "model/vnd.usda", true, None),
        "fbx" | "blend" | "stl" | "ply" | "3ds" | "usd" | "usdz" | "usdc" => {
            class(Kind::Model, "application/octet-stream", false, None)
        }
        "tscn" | "tres" | "godot" => class(Kind::Scene, "text/plain", true, Some("ini")),
        "unity" | "prefab" | "asset" | "mat" => class(Kind::Scene, "text/yaml", true, Some("yaml")),
        "scn" | "res" | "umap" | "uasset" => {
            class(Kind::Scene, "application/octet-stream", false, None)
        }
        "wav" => class(Kind::Audio, "audio/wav", false, None),
        "mp3" => class(Kind::Audio, "audio/mpeg", false, None),
        "ogg" | "oga" => class(Kind::Audio, "audio/ogg", false, None),
        "flac" => class(Kind::Audio, "audio/flac", false, None),
        "opus" | "m4a" | "aac" | "aif" | "aiff" => {
            class(Kind::Audio, "application/octet-stream", false, None)
        }
        "mp4" | "m4v" => class(Kind::Video, "video/mp4", false, None),
        "webm" => class(Kind::Video, "video/webm", false, None),
        "mov" | "mkv" | "avi" | "ogv" => {
            class(Kind::Video, "application/octet-stream", false, None)
        }
        "md" | "markdown" => class(Kind::Text, "text/markdown", true, Some("markdown")),
        "json" | "jsonc" => class(Kind::Text, "application/json", true, Some("json")),
        "csv" => class(Kind::Text, "text/csv", true, None),
        "rs" => code("rust"),
        "ts" | "tsx" | "mts" | "cts" => code("typescript"),
        "js" | "jsx" | "mjs" | "cjs" => code("javascript"),
        "gd" => code("gdscript"),
        "gdshader" | "shader" | "glsl" | "hlsl" | "wgsl" => code("glsl"),
        "cs" => code("csharp"),
        "py" => code("python"),
        "lua" => code("lua"),
        "c" | "h" => code("c"),
        "cpp" | "cc" | "hpp" | "hh" => code("cpp"),
        "toml" => code("toml"),
        "yaml" | "yml" => code("yaml"),
        "xml" => code("xml"),
        "html" | "htm" => code("html"),
        "css" => code("css"),
        "sh" | "bash" => code("shell"),
        "ps1" => code("powershell"),
        "ini" | "cfg" | "conf" => code("ini"),
        "txt" | "log" | "" => class(Kind::Text, "text/plain", true, None),
        _ => class(Kind::Binary, "application/octet-stream", false, None),
    }
}

/// Text, as far as the first bytes can tell: valid UTF-8 (a cut final
/// character allowed) with no NUL.
pub fn looks_textual(head: &[u8]) -> bool {
    if head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && head.len() - e.valid_up_to() < 4,
    }
}

/// Facts read from a model's header without loading it. A GLB's JSON chunk or
/// a glTF file is parsed from the bytes given and its arrays counted; a chunk
/// cut short by the caller's read limit yields no facts rather than wrong ones.
pub fn model_facts(ext: &str, bytes: &[u8]) -> Map<String, Value> {
    let json = match ext {
        "glb" => glb_json(bytes),
        "gltf" => serde_json::from_slice(bytes).ok(),
        _ => None,
    };
    let mut out = Map::new();
    if let Some(doc) = json {
        for key in [
            "scenes",
            "nodes",
            "meshes",
            "materials",
            "textures",
            "animations",
            "skins",
        ] {
            let n = doc.get(key).and_then(Value::as_array).map_or(0, Vec::len);
            out.insert(key.into(), json!(n));
        }
        if let Some(gen) = doc.pointer("/asset/generator").and_then(Value::as_str) {
            out.insert(
                "generator".into(),
                json!(gen.chars().take(120).collect::<String>()),
            );
        }
    }
    out
}

/// The JSON chunk of a binary glTF: 12-byte header, then `length`, `JSON`.
fn glb_json(bytes: &[u8]) -> Option<Value> {
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" || &bytes[16..20] != b"JSON" {
        return None;
    }
    let len = u32::from_le_bytes(bytes[12..16].try_into().ok()?) as usize;
    let chunk = bytes.get(20..20usize.checked_add(len)?)?;
    serde_json::from_slice(chunk).ok()
}

/// A WAV file's format and length, from its `fmt ` and `data` chunks. `len` is
/// the whole file's size: a header can claim more data than the file holds,
/// or 0 or `0xFFFFFFFF` while a recorder is still writing.
pub fn wav_facts(bytes: &[u8], len: u64) -> Map<String, Value> {
    let mut out = Map::new();
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return out;
    }
    let le16 = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let le32 = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let (mut i, mut byte_rate) = (12usize, 0u32);
    while i + 8 <= bytes.len() {
        let size = le32(i + 4) as usize;
        match &bytes[i..i + 4] {
            b"fmt " if i + 24 <= bytes.len() => {
                out.insert("channels".into(), json!(le16(i + 10)));
                out.insert("sampleRate".into(), json!(le32(i + 12)));
                out.insert("bitsPerSample".into(), json!(le16(i + 22)));
                byte_rate = le32(i + 16);
            }
            b"data" if byte_rate > 0 => {
                let present = len.saturating_sub(i as u64 + 8);
                let data = match le32(i + 4) {
                    0 | u32::MAX => present,
                    claimed => u64::from(claimed).min(present),
                };
                let seconds = data as f64 / f64::from(byte_rate);
                out.insert("seconds".into(), json!((seconds * 100.0).round() / 100.0));
                break;
            }
            _ => {}
        }
        i = i.saturating_add(8 + size + (size & 1));
    }
    out
}

/// An SVG's own size: its root element's `width` and `height` when both are
/// plain pixel lengths, else its `viewBox`. A percentage or an `em` is a size
/// only the page it sits in can settle, so it is no answer here.
pub fn svg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(SVG_HEAD)]);
    let tag = &text[text.find("<svg")?..];
    let tag = &tag[..tag.find('>')?];
    let px = |name| attr(tag, name).and_then(pixels);
    if let (Some(w), Some(h)) = (px("width"), px("height")) {
        return Some((w, h));
    }
    let view: Vec<f64> = attr(tag, "viewBox")?
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    match view[..] {
        [_, _, w, h] => Some((whole(w)?, whole(h)?)),
        _ => None,
    }
}

/// How far into an SVG its root element is looked for.
const SVG_HEAD: usize = 8 * 1024;

/// The value of attribute `name` in one start tag, quoted either way.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut at = 0;
    while let Some(i) = tag[at..].find(name).map(|i| at + i) {
        at = i + name.len();
        if !tag[..i].ends_with(char::is_whitespace) {
            continue;
        }
        let Some(value) = tag[at..].trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim_start();
        let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let body = &value[1..];
        return body.find(quote).map(|end| &body[..end]);
    }
    None
}

/// A length in pixels, written bare or with `px`.
fn pixels(value: &str) -> Option<u32> {
    let value = value.trim();
    whole(
        value
            .strip_suffix("px")
            .unwrap_or(value)
            .trim()
            .parse()
            .ok()?,
    )
}

/// A size in whole pixels, if it is one a picture could have.
fn whole(n: f64) -> Option<u32> {
    (n.is_finite() && (1.0..=100_000.0).contains(&n)).then(|| n.round() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_svg_is_sized_by_its_pixels_else_its_view_box() {
        let size = |s: &str| svg_size(s.as_bytes());
        assert_eq!(size(r#"<svg width="64" height="32px">"#), Some((64, 32)));
        assert_eq!(
            size(r#"<?xml?><svg stroke-width="9" width='10' height="20" viewBox="0 0 1 1">"#),
            Some((10, 20))
        );
        assert_eq!(
            size(r#"<svg width="100%" viewBox="0,0 120.4 80">"#),
            Some((120, 80))
        );
        assert_eq!(size(r#"<svg width="2em" height="2em">"#), None);
        assert_eq!(size(r#"<svg viewBox="0 0 0 10">"#), None);
        assert_eq!(size("<svg>"), None);
        assert_eq!(size("not an svg"), None);
    }

    #[test]
    fn game_assets_classify_by_extension() {
        assert_eq!(classify("hero.GLB").kind, Kind::Model);
        assert_eq!(classify("level.tscn").kind, Kind::Scene);
        assert!(classify("level.tscn").textual);
        assert!(!classify("level.scn").textual);
        assert_eq!(classify("jump.wav").kind, Kind::Audio);
        assert_eq!(classify("intro.webm").kind, Kind::Video);
        assert_eq!(classify("sheet.png").mime, "image/png");
        assert_eq!(classify("player.gd").language, Some("gdscript"));
        assert_eq!(classify("README").kind, Kind::Text);
        assert_eq!(classify("data.weird").kind, Kind::Binary);
    }

    #[test]
    fn text_is_utf8_without_nul_and_a_cut_last_character_is_forgiven() {
        assert!(looks_textual(b"fn main() {}\n"));
        assert!(!looks_textual(b"PK\x03\x04\x00\x00"));
        assert!(!looks_textual(&[0xC3, 0x28, b'a', b'b', b'c', b'd']));
        let cut = "h\u{e9}llo".as_bytes();
        assert!(looks_textual(&cut[..2]));
    }

    fn glb(json: &str) -> Vec<u8> {
        let mut chunk = json.as_bytes().to_vec();
        while !chunk.len().is_multiple_of(4) {
            chunk.push(b' ');
        }
        let total = 12 + 8 + chunk.len();
        let mut out = b"glTF".to_vec();
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&(total as u32).to_le_bytes());
        out.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
        out.extend_from_slice(b"JSON");
        out.extend_from_slice(&chunk);
        out
    }

    #[test]
    fn a_glb_reports_what_it_holds() {
        let bytes = glb(
            r#"{"asset":{"version":"2.0","generator":"Blender"},"meshes":[{},{}],"materials":[{}]}"#,
        );
        let facts = model_facts("glb", &bytes);
        assert_eq!(facts["meshes"], 2);
        assert_eq!(facts["materials"], 1);
        assert_eq!(facts["animations"], 0);
        assert_eq!(facts["generator"], "Blender");
    }

    #[test]
    fn a_truncated_or_foreign_glb_reports_nothing_rather_than_failing() {
        let mut bytes = glb(r#"{"meshes":[{}]}"#);
        bytes.truncate(24);
        assert!(model_facts("glb", &bytes).is_empty());
        assert!(model_facts("glb", b"not a model at all").is_empty());
    }

    /// A mono 16-bit 8 kHz WAV header whose `data` chunk claims `data_len`
    /// bytes, and its byte rate.
    fn wav(data_len: u32) -> (Vec<u8>, u64) {
        let (rate, channels, bits) = (8000u32, 1u16, 16u16);
        let byte_rate = rate * u32::from(channels) * u32::from(bits / 8);
        let mut b = b"RIFF".to_vec();
        b.extend_from_slice(&36u32.saturating_add(data_len).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&byte_rate.to_le_bytes());
        b.extend_from_slice(&(channels * bits / 8).to_le_bytes());
        b.extend_from_slice(&bits.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        (b, u64::from(byte_rate))
    }

    #[test]
    fn a_wav_reports_its_format_and_length() {
        let (b, rate) = wav(32_000);
        let facts = wav_facts(&b, b.len() as u64 + 2 * rate);
        assert_eq!(facts["sampleRate"], 8000);
        assert_eq!(facts["channels"], 1);
        assert_eq!(facts["seconds"], 2.0);
    }

    #[test]
    fn a_wav_length_counts_the_bytes_that_are_there() {
        // 16,000 bytes a second, so the bytes present are what decide.
        let seconds = |claimed: u32, present: u64| {
            let (b, _) = wav(claimed);
            wav_facts(&b, b.len() as u64 + present)["seconds"].clone()
        };
        assert_eq!(
            seconds(32_000, 8_000),
            0.5,
            "a cut file is as long as what is left"
        );
        assert_eq!(
            seconds(u32::MAX, 16_000),
            1.0,
            "a recorder's placeholder size"
        );
        assert_eq!(seconds(0, 32_000), 2.0, "a size never filled in");
    }
}
