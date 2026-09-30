//! A project's own icon: an image at `.kaava/icon.<ext>`, drawn wherever the
//! shell would otherwise draw the project's initial on a coloured tile.
//!
//! The file lives in the project, not in OpenKaava's settings, so it travels
//! with the folder: commit it and everyone who opens the project sees the same
//! icon. `.kaava/` is [`super::TRACE_DIR`], the directory OpenKaava already
//! owns inside a project.
//!
//! The webview is handed a `data:` URL rather than a path. An `<img>` in the
//! shell cannot load an arbitrary `C:\` path without opening the asset
//! protocol to the whole disk, and a data URL needs no permission at all. The
//! cost is that the bytes cross the bridge as base64, which is why the size is
//! capped at [`MAX_BYTES`]: an icon is drawn at 32px at most, and anything
//! larger is a photo somebody picked by mistake.

use super::TRACE_DIR;
use crate::error::{AppError, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use std::path::{Path, PathBuf};

/// The extensions an icon may have, in the order [`find`] looks for them. The
/// first one present wins, so a project holding two icons shows the PNG.
pub const EXTENSIONS: [&str; 4] = ["png", "svg", "jpg", "webp"];

/// The largest icon, in bytes, that is read or accepted. 256 KiB is far more
/// than a 32px image needs and still small enough to send on every redraw.
pub const MAX_BYTES: u64 = 256 * 1024;

/// The icon file inside `project`, if it has one.
pub fn find(project: &Path) -> Option<PathBuf> {
    let dir = project.join(TRACE_DIR);
    EXTENSIONS
        .iter()
        .map(|ext| dir.join(format!("icon.{ext}")))
        .find(|path| path.is_file())
}

/// The project's icon as a `data:` URL, or `None` for "no icon".
///
/// `None` also covers an icon that is too large or cannot be read. The caller
/// falls back to the letter tile either way, and a title bar has no room to
/// explain which.
pub fn data_url(project: &Path) -> Option<String> {
    let path = find(project)?;
    if std::fs::metadata(&path).ok()?.len() > MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let ext = path.extension()?.to_str()?;
    Some(encode(ext, &bytes))
}

/// Copy `source` into `project` as its icon, and answer the new `data:` URL.
///
/// Any icon already there under a *different* extension is removed first.
/// Otherwise a PNG set before would keep winning [`find`] over the SVG just
/// chosen, and the choice would appear to do nothing.
///
/// The source is read into memory before anything is removed, so choosing the
/// project's current icon file as the new one is a harmless rewrite rather than
/// a delete followed by a failed read.
pub fn set(project: &Path, source: &Path) -> Result<String> {
    if !project.is_dir() {
        return Err(AppError::NotAProject(project.display().to_string()));
    }
    let ext = normalized_extension(source).ok_or_else(|| {
        AppError::ProjectIcon(format!(
            "{} is not a PNG, SVG, JPEG or WebP image, so it cannot be a project icon.",
            source.display()
        ))
    })?;

    let meta = std::fs::metadata(source).map_err(|e| io(source, e))?;
    if !meta.is_file() {
        return Err(AppError::ProjectIcon(format!(
            "{} is not a file.",
            source.display()
        )));
    }
    if meta.len() > MAX_BYTES {
        return Err(AppError::ProjectIcon(format!(
            "That image is {} KiB. A project icon can be at most {} KiB.",
            meta.len().div_ceil(1024),
            MAX_BYTES / 1024
        )));
    }
    let bytes = std::fs::read(source).map_err(|e| io(source, e))?;

    let dir = project.join(TRACE_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| io(&dir, e))?;
    for other in EXTENSIONS.iter().filter(|other| **other != ext) {
        let stale = dir.join(format!("icon.{other}"));
        if stale.is_file() {
            std::fs::remove_file(&stale).map_err(|e| io(&stale, e))?;
        }
    }
    let target = dir.join(format!("icon.{ext}"));
    std::fs::write(&target, &bytes).map_err(|e| io(&target, e))?;

    Ok(encode(ext, &bytes))
}

/// The extension `source` will be stored under, or `None` when it is not an
/// image this accepts. Case-insensitive, and `.jpeg` is stored as `.jpg` so
/// [`find`] has one spelling to look for.
fn normalized_extension(source: &Path) -> Option<&'static str> {
    let ext = source.extension()?.to_str()?.to_ascii_lowercase();
    let ext = if ext == "jpeg" {
        "jpg".to_string()
    } else {
        ext
    };
    EXTENSIONS.iter().copied().find(|known| *known == ext)
}

/// `data:<mime>;base64,<bytes>`.
fn encode(ext: &str, bytes: &[u8]) -> String {
    let mime = match ext {
        "svg" => "image/svg+xml",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    format!("data:{mime};base64,{}", BASE64.encode(bytes))
}

fn io(path: &Path, source: std::io::Error) -> AppError {
    AppError::Io {
        path: path.display().to_string(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one-pixel PNG header is enough: nothing here decodes the image.
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn icon_dir(project: &Path) -> PathBuf {
        let dir = project.join(TRACE_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_project_without_an_icon_has_none() {
        let project = tempfile::tempdir().unwrap();
        assert_eq!(find(project.path()), None);
        assert_eq!(data_url(project.path()), None);
    }

    #[test]
    fn an_icon_is_answered_as_a_data_url_with_its_type() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(icon_dir(project.path()).join("icon.svg"), "<svg/>").unwrap();
        assert_eq!(
            data_url(project.path()).as_deref(),
            Some("data:image/svg+xml;base64,PHN2Zy8+")
        );
    }

    /// Two icons is a state `set` never leaves behind, but a person can make it
    /// by hand, and the answer has to be the same every time.
    #[test]
    fn png_wins_when_there_are_two() {
        let project = tempfile::tempdir().unwrap();
        let dir = icon_dir(project.path());
        std::fs::write(dir.join("icon.webp"), b"w").unwrap();
        std::fs::write(dir.join("icon.png"), PNG).unwrap();
        assert_eq!(find(project.path()), Some(dir.join("icon.png")));
    }

    #[test]
    fn an_oversized_icon_reads_as_none() {
        let project = tempfile::tempdir().unwrap();
        let big = vec![0u8; MAX_BYTES as usize + 1];
        std::fs::write(icon_dir(project.path()).join("icon.png"), big).unwrap();
        assert_eq!(data_url(project.path()), None);
    }

    #[test]
    fn setting_copies_into_kaava_and_replaces_the_old_icon() {
        let project = tempfile::tempdir().unwrap();
        let dir = icon_dir(project.path());
        std::fs::write(dir.join("icon.png"), PNG).unwrap();

        let picked = tempfile::tempdir().unwrap();
        let source = picked.path().join("Logo.JPEG");
        std::fs::write(&source, b"jpeg-bytes").unwrap();

        let url = set(project.path(), &source).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        assert_eq!(std::fs::read(dir.join("icon.jpg")).unwrap(), b"jpeg-bytes");
        // Removed, or it would keep winning `find` over the new choice.
        assert!(!dir.join("icon.png").exists());
        assert_eq!(data_url(project.path()), Some(url));
        // A copy: the file the person picked is left where it was.
        assert!(source.exists());
    }

    /// `.kaava/` does not exist in a folder that has never been opened as a
    /// project. Setting an icon is allowed to be the thing that creates it.
    #[test]
    fn setting_creates_the_kaava_directory() {
        let project = tempfile::tempdir().unwrap();
        let picked = tempfile::tempdir().unwrap();
        let source = picked.path().join("icon.png");
        std::fs::write(&source, PNG).unwrap();

        set(project.path(), &source).unwrap();
        assert!(project.path().join(TRACE_DIR).join("icon.png").is_file());
    }

    #[test]
    fn choosing_the_current_icon_again_keeps_it() {
        let project = tempfile::tempdir().unwrap();
        let current = icon_dir(project.path()).join("icon.png");
        std::fs::write(&current, PNG).unwrap();

        set(project.path(), &current).unwrap();
        assert_eq!(std::fs::read(&current).unwrap(), PNG);
    }

    #[test]
    fn a_file_that_is_not_an_image_is_refused() {
        let project = tempfile::tempdir().unwrap();
        let picked = tempfile::tempdir().unwrap();
        let source = picked.path().join("notes.txt");
        std::fs::write(&source, b"hello").unwrap();

        assert!(matches!(
            set(project.path(), &source),
            Err(AppError::ProjectIcon(_))
        ));
        assert!(!project.path().join(TRACE_DIR).exists());
    }

    #[test]
    fn an_oversized_image_is_refused() {
        let project = tempfile::tempdir().unwrap();
        let picked = tempfile::tempdir().unwrap();
        let source = picked.path().join("photo.png");
        std::fs::write(&source, vec![0u8; MAX_BYTES as usize + 1]).unwrap();

        assert!(matches!(
            set(project.path(), &source),
            Err(AppError::ProjectIcon(_))
        ));
    }
}
