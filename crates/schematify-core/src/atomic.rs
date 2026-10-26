//! The atomic JSON writer: temporary file, fsync, rename.
//!
//! Every semantic file in `.veistra/` is written through here, and the three
//! steps each earn their place. The temporary file sits **in the same
//! directory**, so the rename is inside one filesystem and cannot silently
//! become a copy. `sync_all` runs before it, so the bytes are on the device
//! before anything points at them: without it a crash leaves a correctly
//! named file full of zeroes, which is worse than a half-written one because
//! it parses as absent rather than as damaged. The rename over the target is
//! atomic on every filesystem Schematify runs on.
//!
//! The directory itself is not fsynced. A directory handle cannot be flushed
//! on Windows the way a file can, and the guarantee that matters is that a
//! reader never sees a partial file, not that a rename survives a power cut.
//! A design file lost to a power cut is recovered from git. A design file
//! truncated in place is not.

use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;

/// Distinguishes two temporary files written inside one process.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// How many times a rename is retried past a sharing violation.
///
/// Windows is the product's only platform and it locks a file that anything
/// else has open: a backup agent, an indexer, an antivirus scanner, or the
/// editor a person has the node open in. Every one of those releases the
/// handle within milliseconds. Without a retry, saving a node while a scanner
/// walks past it is a hard error a person cannot act on; with one it is
/// invisible. The temporary file and its bytes are already safe on disk by
/// this point, so a retry repeats a rename and never a write.
const RENAME_ATTEMPTS: u32 = 5;

/// The pause before the first retry. Each attempt doubles it, so five
/// attempts wait 5, 10, 20 and 40 milliseconds: 75 ms in the worst case,
/// which is under a frame and far under a scanner's grip on one small file.
const RENAME_BACKOFF: Duration = Duration::from_millis(5);

/// Serialize a value and write it where nothing can observe a partial file.
///
/// The JSON is pretty-printed with a trailing newline. Design data is read in
/// diffs at least as often as it is read in the interface, and a one-line
/// object turns every edit into a whole-file change.
///
/// # Errors
///
/// Returns [`AtomicWriteError`] naming the step that failed. A failure at any
/// step leaves the target file exactly as it was, and removes the temporary
/// file where it can.
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), AtomicWriteError> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory).map_err(|source| AtomicWriteError::Directory {
        path: directory.to_path_buf(),
        source,
    })?;

    let bytes = serde_json::to_vec_pretty(value).map_err(|source| AtomicWriteError::Serialize {
        path: path.to_path_buf(),
        source,
    })?;

    let temporary = temporary_path(path);
    let outcome = write_and_sync(&temporary, &bytes);
    if outcome.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    outcome?;

    rename_with_retry(&temporary, path).map_err(|source| {
        let _ = fs::remove_file(&temporary);
        AtomicWriteError::Rename {
            from: temporary.clone(),
            to: path.to_path_buf(),
            source,
        }
    })
}

/// Rename, retrying past a lock somebody else is holding for a moment.
///
/// Only a permission or sharing error is retried. A missing directory or a
/// cross-device rename fails the same way it did before, immediately, because
/// waiting cannot fix either.
fn rename_with_retry(from: &Path, to: &Path) -> Result<(), std::io::Error> {
    rename_with_retry_counted(from, to).0
}

/// Same rename loop as [`rename_with_retry`], but also reports how many
/// attempts it took.
///
/// Split out so a test can prove a non-transient error fails on the first
/// attempt — the property that matters — instead of measuring wall clock,
/// which a loaded CI runner can blow through even when no sleep happened.
fn rename_with_retry_counted(from: &Path, to: &Path) -> (Result<(), std::io::Error>, u32) {
    let mut pause = RENAME_BACKOFF;
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return (Ok(()), attempt),
            Err(error) if attempt < RENAME_ATTEMPTS && is_transient_lock(&error) => {
                std::thread::sleep(pause);
                pause *= 2;
                attempt += 1;
            }
            // The last attempt takes this arm whatever went wrong, so the
            // error a caller sees is always one a rename actually returned.
            Err(error) => return (Err(error), attempt),
        }
    }
}

/// Whether an error is the kind another process releases on its own.
fn is_transient_lock(error: &std::io::Error) -> bool {
    if matches!(error.kind(), ErrorKind::PermissionDenied) {
        return true;
    }
    // ERROR_SHARING_VIOLATION (32) and ERROR_LOCK_VIOLATION (33). Neither maps
    // to a distinct `ErrorKind` on stable Rust, so they are named by number.
    matches!(error.raw_os_error(), Some(32 | 33))
}

fn write_and_sync(temporary: &Path, bytes: &[u8]) -> Result<(), AtomicWriteError> {
    let mut file = File::create(temporary).map_err(|source| AtomicWriteError::Create {
        path: temporary.to_path_buf(),
        source,
    })?;

    file.write_all(bytes)
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|source| AtomicWriteError::Write {
            path: temporary.to_path_buf(),
            source,
        })?;

    file.sync_all().map_err(|source| AtomicWriteError::Sync {
        path: temporary.to_path_buf(),
        source,
    })
}

/// A temporary name nothing else will pick.
///
/// It carries the process id and a counter rather than a fixed suffix, so two
/// Schematify windows writing the same node at the same moment do not write
/// into one temporary file and rename each other's bytes.
fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map_or_else(|| "node".to_owned(), |n| n.to_string_lossy().into_owned());
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let suffix = format!(".{name}.{}.{sequence}.tmp", std::process::id());
    path.with_file_name(suffix)
}

/// Which step of the write failed.
#[derive(Debug, thiserror::Error)]
pub enum AtomicWriteError {
    /// The containing directory could not be created.
    #[error("cannot create directory {path}")]
    Directory {
        /// The directory.
        path: PathBuf,
        /// The underlying cause.
        #[source]
        source: std::io::Error,
    },

    /// The value did not serialize.
    #[error("cannot serialize the value destined for {path}")]
    Serialize {
        /// The file the value was headed for.
        path: PathBuf,
        /// The underlying cause.
        #[source]
        source: serde_json::Error,
    },

    /// The temporary file could not be created.
    #[error("cannot create temporary file {path}")]
    Create {
        /// The temporary file.
        path: PathBuf,
        /// The underlying cause.
        #[source]
        source: std::io::Error,
    },

    /// The bytes did not reach the temporary file.
    #[error("cannot write {path}")]
    Write {
        /// The temporary file.
        path: PathBuf,
        /// The underlying cause.
        #[source]
        source: std::io::Error,
    },

    /// The temporary file did not reach the device.
    #[error("cannot flush {path} to the device")]
    Sync {
        /// The temporary file.
        path: PathBuf,
        /// The underlying cause.
        #[source]
        source: std::io::Error,
    },

    /// The rename over the target failed, so the target is unchanged.
    #[error("cannot rename {from} over {to}")]
    Rename {
        /// The temporary file.
        from: PathBuf,
        /// The target that was left alone.
        to: PathBuf,
        /// The underlying cause.
        #[source]
        source: std::io::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_write_lands_and_parses_back() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("node.json");
        write_json_atomic(&path, &json!({ "slug": "token-verifier" })).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.ends_with("\n"));
        let back: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back["slug"], "token-verifier");
    }

    #[test]
    fn a_write_leaves_no_temporary_file_behind() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("node.json");
        write_json_atomic(&path, &json!({ "a": 1 })).unwrap();
        write_json_atomic(&path, &json!({ "a": 2 })).unwrap();
        assert_eq!(entries(directory.path()), vec!["node.json".to_owned()]);
    }

    #[test]
    fn an_overwrite_replaces_the_whole_file_rather_than_the_leading_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("node.json");
        write_json_atomic(&path, &json!({ "description": "a long first description" })).unwrap();
        write_json_atomic(&path, &json!({ "description": "short" })).unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["description"], "short");
    }

    #[test]
    fn a_failed_serialization_leaves_the_target_untouched_and_no_temporary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("node.json");
        write_json_atomic(&path, &json!({ "a": 1 })).unwrap();

        // A map with a non-string key cannot become a JSON object, so this
        // fails inside `to_vec_pretty` and never opens a file.
        let unserializable: std::collections::BTreeMap<[u8; 2], u8> =
            [([1, 2], 3)].into_iter().collect();
        let error = write_json_atomic(&path, &unserializable).unwrap_err();
        assert!(matches!(error, AtomicWriteError::Serialize { .. }));

        assert_eq!(entries(directory.path()), vec!["node.json".to_owned()]);
        let back: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["a"], 1);
    }

    #[test]
    fn a_write_creates_the_directory_it_needs() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runs").join("abc").join("run-1.json");
        write_json_atomic(&path, &json!({ "run": 1 })).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn a_sharing_violation_is_treated_as_transient_and_a_real_failure_is_not() {
        for raw in [32, 33] {
            assert!(
                is_transient_lock(&std::io::Error::from_raw_os_error(raw)),
                "os error {raw} is a lock somebody releases"
            );
        }
        assert!(is_transient_lock(&std::io::Error::from(
            ErrorKind::PermissionDenied
        )));
        assert!(!is_transient_lock(&std::io::Error::from(
            ErrorKind::NotFound
        )));
        assert!(!is_transient_lock(&std::io::Error::from(
            ErrorKind::InvalidInput
        )));
    }

    #[test]
    fn a_rename_onto_a_missing_directory_fails_without_waiting() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("from.json");
        fs::write(&source, "{}").unwrap();
        let (result, attempts) =
            rename_with_retry_counted(&source, &directory.path().join("gone").join("to.json"));
        let error = result.unwrap_err();
        assert!(!is_transient_lock(&error));
        // A wall-clock budget flakes on a loaded runner even when nothing was
        // slept on; the attempt count proves the same thing directly.
        assert_eq!(attempts, 1, "a failure the retry cannot fix is not retried");
    }

    #[test]
    fn two_temporary_names_in_one_process_differ() {
        let path = Path::new("/tmp/nodes/node.json");
        assert_ne!(temporary_path(path), temporary_path(path));
    }
}
