//! Where review notes survive a restart: `.veistra/review-comments.json`, inside the checkout.
//!
//! **Inside the checkout, not in the config directory.** The Recent list in `project::store` went
//! to the OS config directory because it is a fact about *this machine's* history. A note on a
//! line of a diff is the opposite — it is about that code, it is worth carrying to another machine
//! with the branch, and a person reviewing an agent's worktree wants the notes to travel with the
//! worktree. `.veistra/` is the directory the project manifest already promises holds what Veistra
//! produced about a project (see `project::marker`), and this is its first occupant.
//!
//! The root handed in is the **repository** root, resolved by the caller through the same
//! `git::repo_root` every other source-control command uses. That matters: the paths inside the
//! file are repo-relative, so the file and the paths it holds share one base and a note cannot
//! come to name a file relative to the wrong directory. A cluster working in a git worktree
//! resolves to that worktree, so its notes stay with the branch being reviewed rather than
//! leaking into the main checkout.
//!
//! Reading is never fatal. Writing is: see [`save`].

use super::ReviewComment;
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE: &str = "review-comments.json";

/// The format version this build writes.
///
/// Bumped when a change would make an *older* build misread the file, not when it would merely
/// miss part of it — the same rule `project::marker::FORMAT` follows. Adding a field to a note is
/// not a bump.
const FORMAT: i64 = 1;

/// The file as it sits on disk: a version, and the notes.
///
/// Wrapped in a document rather than written as a bare array, so there is somewhere to put the
/// version. An array has no room for one, and discovering that after people have files on disk is
/// how a format ends up with a sidecar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    format: i64,
    #[serde(default)]
    comments: Vec<ReviewComment>,
}

/// Read a checkout's notes, or start empty.
///
/// **Never fatal.** A missing file is the ordinary first-review case. A truncated or hand-mangled
/// one degrades to no notes and a line in the log, for the same reason `project::store::load`
/// does: the worst honest outcome of an unreadable file is an empty list, and that is far better
/// than a source-control panel that refuses to draw.
///
/// A file written by a *newer* build still loads. `serde` ignores fields it does not know, so a
/// note carrying something this build has never heard of arrives with the rest of it intact —
/// which is the whole reason [`FORMAT`] is only bumped for changes that break that.
pub fn load(root: &Path) -> Vec<ReviewComment> {
    let path = file(root);

    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                crate::veistra_log!("could not read {}: {e}", path.display());
            }
            return Vec::new();
        }
    };

    match serde_json::from_str::<Document>(&raw) {
        Ok(document) => {
            let mut comments = document.comments;
            super::sort(&mut comments);
            comments
        }
        Err(e) => {
            crate::veistra_log!("{} is not readable, starting fresh: {e}", path.display());
            Vec::new()
        }
    }
}

/// Write a checkout's notes, atomically, and report a failure rather than swallowing it.
///
/// The one place this deliberately diverges from `project::store::save`, which logs and returns.
/// That store holds a Recent list, and a lost entry costs a person one click. This holds prose
/// somebody just typed, and a save that failed silently would leave a note on screen that is not
/// on disk — so every caller here is a command that can put the failure in front of them.
///
/// Temp file then rename, for the reason that store gives: truncating the real file and writing
/// into it leaves a window where a crash yields half a JSON document. `rename` over an existing
/// file is atomic on NTFS and POSIX alike, so a reader sees one whole version or the other.
///
/// Creates `.veistra/` if it is missing. A cluster working in a git worktree has a checkout git made
/// rather than one Veistra created, so the directory the project manifest would have written is
/// simply not there — and a first note is a perfectly ordinary reason to make it.
pub fn save(root: &Path, comments: &[ReviewComment]) -> Result<()> {
    let path = file(root);
    let dir = path.parent().unwrap_or(root);

    std::fs::create_dir_all(dir).map_err(|source| AppError::Io {
        path: dir.display().to_string(),
        source,
    })?;

    let document = Document {
        format: FORMAT,
        comments: comments.to_vec(),
    };

    // Pretty rather than compact: this file lives inside the checkout, so it can end up in a diff
    // that a person has to read.
    let json = serde_json::to_string_pretty(&document)
        .map_err(|e| AppError::Review(format!("could not serialize the review comments: {e}")))?;

    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json).map_err(|source| AppError::Io {
        path: temp.display().to_string(),
        source,
    })?;

    std::fs::rename(&temp, &path).map_err(|source| {
        // The temp file is this function's litter, not the caller's problem, and leaving it would
        // mean the next save writes over a file that is already there. The rename failure is what
        // gets reported either way.
        let _ = std::fs::remove_file(&temp);
        AppError::Io {
            path: path.display().to_string(),
            source,
        }
    })
}

fn file(root: &Path) -> PathBuf {
    root.join(crate::project::TRACE_DIR).join(FILE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::{self, ReviewDraft, ReviewScope};

    /// A temp directory that cleans itself up, so these tests can touch a real filesystem — which
    /// is the only way to test a module whose whole job is reading and writing one. Modelled on
    /// `project::marker`'s.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "veistra-review-{tag}-{}-{:?}",
                review::now_ms(),
                std::thread::current().id()
            ));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn one(path: &str, line: u32, body: &str) -> Vec<ReviewComment> {
        let mut comments = Vec::new();
        review::add(
            &mut comments,
            ReviewDraft {
                path: path.to_string(),
                scope: ReviewScope::Branch,
                start_line: line,
                end_line: line,
                body: body.to_string(),
            },
            7,
        )
        .expect("a valid draft");
        comments
    }

    #[test]
    fn a_checkout_with_no_file_yet_has_no_notes() {
        let dir = TempDir::new("empty");
        assert!(load(&dir.0).is_empty());
    }

    #[test]
    fn notes_survive_a_write_and_a_read() {
        let dir = TempDir::new("roundtrip");
        let written = one("src/a.rs", 12, "explain this branch");

        save(&dir.0, &written).expect("a writable temp dir");
        let read = load(&dir.0);

        assert_eq!(read, written);
    }

    /// The `.veistra/` directory is Veistra's to create — a git worktree arrives without one.
    #[test]
    fn saving_creates_the_trace_directory() {
        let dir = TempDir::new("mkdir");
        assert!(!dir.0.join(crate::project::TRACE_DIR).is_dir());

        save(&dir.0, &one("a.rs", 1, "note")).expect("a writable temp dir");

        assert!(dir.0.join(crate::project::TRACE_DIR).is_dir());
    }

    #[test]
    fn a_save_leaves_no_temp_file_behind() {
        let dir = TempDir::new("tidy");
        save(&dir.0, &one("a.rs", 1, "note")).expect("a writable temp dir");

        let stray: Vec<_> = std::fs::read_dir(dir.0.join(crate::project::TRACE_DIR))
            .expect("the trace dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();

        assert!(stray.is_empty(), "found {stray:?}");
    }

    #[test]
    fn an_unreadable_file_reads_as_no_notes_rather_than_failing() {
        let dir = TempDir::new("corrupt");
        let path = file(&dir.0);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        std::fs::write(&path, "{ this is not json").expect("write");

        assert!(load(&dir.0).is_empty());
    }

    /// The forward-compatibility promise on [`load`], as a test.
    #[test]
    fn a_document_from_a_newer_build_still_loads_what_this_one_understands() {
        let dir = TempDir::new("newer");
        let path = file(&dir.0);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        std::fs::write(
            &path,
            r#"{
              "format": 99,
              "comments": [{
                "id": "abc",
                "path": "src/a.rs",
                "scope": "staged",
                "startLine": 4,
                "endLine": 4,
                "body": "from the future",
                "createdAt": 1,
                "resolved": false,
                "reactions": ["a field this build has never heard of"]
              }],
              "somethingElseEntirely": true
            }"#,
        )
        .expect("write");

        let read = load(&dir.0);

        assert_eq!(read.len(), 1);
        assert_eq!(read[0].body, "from the future");
        assert_eq!(read[0].scope, ReviewScope::Staged);
    }

    /// Storage order is applied on read as well as on write, so a hand-edited file comes back in
    /// the order every consumer expects rather than in the order somebody typed it.
    #[test]
    fn loading_sorts_what_it_found() {
        let dir = TempDir::new("sorted");
        let path = file(&dir.0);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        std::fs::write(
            &path,
            r#"{"format":1,"comments":[
              {"id":"2","path":"src/b.rs","scope":"unstaged","startLine":1,"endLine":1,"body":"b","createdAt":1,"resolved":false},
              {"id":"1","path":"src/a.rs","scope":"unstaged","startLine":5,"endLine":5,"body":"a","createdAt":1,"resolved":false}
            ]}"#,
        )
        .expect("write");

        let read = load(&dir.0);

        let order: Vec<&str> = read.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(order, vec!["src/a.rs", "src/b.rs"]);
    }
}
