//! What a reference may reach. Every rule here is a refusal, and every refusal
//! is a sentence the person or agent can read.
//!
//! Three gates, in order: the path's spelling ([`check_relative`]), where it
//! really lands once symlinks and junctions are followed, and what kind of file
//! it is (secrets are never served, gitignored files are named but not read).

/// Names Windows reserves in every directory, whatever the extension.
const DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
/// Longer relative paths are refused rather than handed to a long-path API.
const MAX_PATH_CHARS: usize = 1024;

/// Refuse a relative path whose spelling could escape the root or confuse
/// Windows: empty segments, `.` and `..`, drive letters, `\`, `:` (alternate
/// data streams), reserved device names, and trailing dots or spaces.
pub fn check_relative(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("the reference names no path".into());
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err(format!("a path is at most {MAX_PATH_CHARS} characters"));
    }
    if path.contains('\\') || path.contains(':') {
        return Err(format!(
            "`{path}` must be relative to the project, with `/` separators and no drive"
        ));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!(
                "`{path}` must stay inside the project: no empty, `.` or `..` segments"
            ));
        }
        if segment.ends_with('.') || segment.ends_with(' ') {
            return Err(format!("`{segment}` ends in a dot or a space"));
        }
        let stem = segment.split('.').next().unwrap_or(segment);
        if DEVICE_NAMES.contains(&stem.to_ascii_lowercase().as_str()) {
            return Err(format!("`{segment}` is a reserved device name"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_project_paths_pass() {
        for ok in [
            "a.rs",
            "scripts/player.gd",
            "art/hero sheet.png",
            ".gitignore",
            "levels/v1.2/map.tscn",
            "console.log",
        ] {
            assert!(check_relative(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn spellings_that_leave_the_root_or_trip_windows_are_refused() {
        for bad in [
            "",
            "/etc/passwd",
            "a//b",
            "a/./b",
            "../x",
            "a/..",
            "C:/x",
            "a\\b",
            "file.txt:secret",
            "con",
            "aux.txt",
            "dir/COM1.log",
            "trailing.",
            "trailing ",
        ] {
            assert!(check_relative(bad).is_err(), "{bad:?} passed");
        }
        assert!(check_relative(&"a/".repeat(600)).is_err());
    }
}
