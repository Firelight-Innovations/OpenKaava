//! Walks a source tree for `@veistra:` marker tokens (PRD section 9.1).
//!
//! The token is "found by plain regular expression" per the PRD, and that is
//! taken literally here: every text file's raw content is scanned line by
//! line with the same regex regardless of the file's language. There is no
//! per-language comment parser to be missing a branch from, which is what
//! lets an unrecognized language degrade to a plain text scan rather than a
//! miss — the same code path handles a Rust `//` comment, a Python `#`
//! comment, a JSX `{/* */}` comment, and a language nobody has written yet,
//! because none of them are special-cased.

use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use regex::Regex;
use serde::Serialize;
use uuid::Uuid;

use crate::token::{parse_captures, token_pattern};

/// Directory names never descended into, regardless of `.gitignore` content.
/// `.veistra` is the design data itself (PRD section 6.1) — a `test-case`
/// facet's `impl_ref` field (section 5.5) can hold the same marker-token text
/// the scanner looks for, so without this exclusion the design data counts as
/// a second code occurrence of its own marker and a correct project reports
/// a false `duplicate`. `.git` is excluded for the same reason no source tree
/// scan should read version-control internals as code.
const ALWAYS_SKIP_DIRS: [&str; 4] = ["node_modules", "target", ".veistra", ".git"];

/// Bytes examined at the front of a file to guess whether it is binary. Git
/// uses the same "does the prefix contain a NUL byte" heuristic.
const BINARY_SNIFF_LEN: usize = 8000;

/// One `@veistra:` marker found while walking the tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Occurrence {
    /// The file the marker was found in, relative or absolute as given to
    /// [`scan_tree`]'s root.
    pub file: PathBuf,
    /// 1-based line number within `file`.
    pub line: usize,
    /// The marker's UUID — see [`crate::token`].
    pub id: Uuid,
    /// The marker's trailing slug, if present.
    pub slug: Option<String>,
}

/// A file the scanner could not treat as text, and why. Never fatal — the
/// scan continues past it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkippedFile {
    /// The file that was skipped.
    pub file: PathBuf,
    /// Human-readable reason: an I/O error's message, or `"binary content"`.
    pub reason: String,
}

/// The result of walking one tree.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ScanResult {
    /// Every marker found, in the order files were visited.
    pub occurrences: Vec<Occurrence>,
    /// Every file the scanner declined to read as text.
    pub skipped: Vec<SkippedFile>,
}

/// Walk `root`, respecting `.gitignore` (repository, global, and per-directory
/// excludes) and never descending into `node_modules` or `target` regardless
/// of what `.gitignore` says. A file that cannot be read, or that looks
/// binary, is recorded in [`ScanResult::skipped`] rather than aborting the
/// walk.
pub fn scan_tree(root: &Path) -> ScanResult {
    let pattern = token_pattern();
    let mut result = ScanResult::default();

    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // `ignore`'s default requires a discoverable `.git` directory before
        // it honors any `.gitignore` at all. A Schematify project is
        // ordinarily a git working tree, but "respect .gitignore" should not
        // silently stop doing that the one time it isn't (a fresh scaffold
        // before the first commit, a CI checkout without `.git`).
        .require_git(false)
        .filter_entry(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| !ALWAYS_SKIP_DIRS.contains(&name))
                .unwrap_or(true)
        })
        .build();

    for entry in walker {
        let Ok(entry) = entry else {
            continue;
        };
        let is_file = entry.file_type().map(|ft| ft.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        scan_file(entry.path(), &pattern, &mut result);
    }

    result
}

fn scan_file(path: &Path, pattern: &Regex, result: &mut ScanResult) {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) => {
            result.skipped.push(SkippedFile {
                file: path.to_path_buf(),
                reason: err.to_string(),
            });
            return;
        }
    };

    if looks_binary(&bytes) {
        result.skipped.push(SkippedFile {
            file: path.to_path_buf(),
            reason: "binary content".to_string(),
        });
        return;
    }

    // Lossy rather than strict UTF-8: a text-like file with a stray invalid
    // byte sequence should still yield whatever markers it has, not abort.
    let text = String::from_utf8_lossy(&bytes);
    for (idx, line) in text.lines().enumerate() {
        if !line.contains(crate::token::TOKEN_PREFIX) {
            continue;
        }
        for caps in pattern.captures_iter(line) {
            if let Some((id, slug)) = parse_captures(&caps) {
                result.occurrences.push(Occurrence {
                    file: path.to_path_buf(),
                    line: idx + 1,
                    id,
                    slug,
                });
            }
        }
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    let scan_len = bytes.len().min(BINARY_SNIFF_LEN);
    bytes[..scan_len].contains(&0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, rel: &str, content: &[u8]) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(path, content).expect("write fixture file");
    }

    #[test]
    fn finds_markers_across_several_comment_syntaxes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        write(
            root,
            "src/lib.rs",
            b"// @veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 token-verifier.verify_signature\nfn verify() {}\n",
        );
        write(
            root,
            "scripts/tool.py",
            b"# @veistra:0192f4a2-4c3d-7890-a1b2-c3d4e5f6a7b8 tool.run\ndef run():\n    pass\n",
        );
        write(
            root,
            "src/widget.tsx",
            b"/* @veistra:0192f4a3-4c3d-7890-a1b2-c3d4e5f6a7b8 widget.render */\nexport function Widget() {}\n",
        );
        write(
            root,
            "docs/notes.html",
            b"<!-- @veistra:0192f4a4-4c3d-7890-a1b2-c3d4e5f6a7b8 notes.section -->\n<p>hi</p>\n",
        );
        write(
            root,
            "config/settings.toml",
            b"# @veistra:0192f4a5-4c3d-7890-a1b2-c3d4e5f6a7b8 settings.load\nkey = 1\n",
        );
        write(
            root,
            "src/unknown.zig",
            b"// @veistra:0192f4a6-4c3d-7890-a1b2-c3d4e5f6a7b8 unknown.build\n",
        );

        let result = scan_tree(root);
        assert_eq!(result.occurrences.len(), 6, "expected one marker per file");
        assert!(result.skipped.is_empty());

        let ids: std::collections::HashSet<_> = result.occurrences.iter().map(|o| o.id).collect();
        assert_eq!(
            ids.len(),
            6,
            "every marker has a distinct id in this fixture"
        );
    }

    #[test]
    fn skips_node_modules_and_target_even_without_gitignore() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write(
            root,
            "node_modules/pkg/index.js",
            b"// @veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 pkg.entry\n",
        );
        write(
            root,
            "target/debug/build.rs",
            b"// @veistra:0192f4a2-4c3d-7890-a1b2-c3d4e5f6a7b8 build.step\n",
        );
        write(
            root,
            "src/lib.rs",
            b"// @veistra:0192f4a3-4c3d-7890-a1b2-c3d4e5f6a7b8 real.code\n",
        );

        let result = scan_tree(root);
        assert_eq!(result.occurrences.len(), 1);
        assert_eq!(
            result.occurrences[0].id.to_string(),
            "0192f4a3-4c3d-7890-a1b2-c3d4e5f6a7b8"
        );
    }

    #[test]
    fn a_marker_inside_veistra_or_git_produces_no_occurrence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        // A test-case facet's `impl_ref` field (PRD 5.5, 5.10) can hold the
        // very marker text the scanner is looking for. The design data is
        // not code, and must never be double-counted as a second site for
        // the same marker.
        write(
            root,
            ".veistra/nodes/0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8.json",
            br#"{"id": "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8", "impl_ref": "@veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 thing.run"}"#,
        );
        write(
            root,
            ".git/config",
            b"// @veistra:0192f4a2-4c3d-7890-a1b2-c3d4e5f6a7b8 git.internal\n",
        );
        write(
            root,
            "src/lib.rs",
            b"// @veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 thing.run\n",
        );

        let result = scan_tree(root);
        assert_eq!(
            result.occurrences.len(),
            1,
            "only the source file's marker should be found, not the copy inside .veistra or .git"
        );
        assert_eq!(result.occurrences[0].file, root.join("src").join("lib.rs"));
    }

    #[test]
    fn respects_gitignore() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write(root, ".gitignore", b"ignored/\n");
        write(
            root,
            "ignored/file.rs",
            b"// @veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 ignored.thing\n",
        );
        write(
            root,
            "kept/file.rs",
            b"// @veistra:0192f4a2-4c3d-7890-a1b2-c3d4e5f6a7b8 kept.thing\n",
        );

        let result = scan_tree(root);
        assert_eq!(result.occurrences.len(), 1);
        assert_eq!(
            result.occurrences[0].id.to_string(),
            "0192f4a2-4c3d-7890-a1b2-c3d4e5f6a7b8"
        );
    }

    #[test]
    fn binary_file_is_skipped_not_panicked_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        // A NUL byte early in the content is enough to look binary.
        let mut content =
            b"@veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 binary.thing\x00".to_vec();
        content.extend_from_slice(b"trailing bytes after the null");
        write(root, "asset.bin", &content);

        let result = scan_tree(root);
        assert!(result.occurrences.is_empty());
        assert_eq!(result.skipped.len(), 1);
        assert_eq!(result.skipped[0].reason, "binary content");
    }

    #[test]
    fn invalid_utf8_text_file_does_not_panic_and_still_finds_the_marker() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let mut content = b"// note: \xFF\xFE stray bytes\n".to_vec();
        content
            .extend_from_slice(b"// @veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 still.found\n");
        write(root, "weird.txt", &content);

        let result = scan_tree(root);
        assert_eq!(result.occurrences.len(), 1);
        assert!(result.skipped.is_empty());
    }
}
