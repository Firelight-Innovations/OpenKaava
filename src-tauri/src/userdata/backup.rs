//! The copies kept when a file is about to be replaced by something derived.
//!
//! **Not on every save.** `layout.json` is rewritten hundreds of times a
//! session — `shell_store::persist` runs inside every `ShellState::mutate`, so
//! a divider drag writes it — and a copy per save is a garbage generator with a
//! rotation policy bolted on. A backup is taken at exactly the moments a file is
//! about to be replaced by something *derived* rather than by something the
//! user just did: a file this build cannot parse, and one written by a build
//! that reads a newer format.
//!
//! Inside the config directory rather than beside it, deliberately: it is user
//! data, so [`super::adopt`] should move it with everything else, and the NSIS
//! uninstaller's "Delete the application data" checkbox should take it when
//! somebody asks for their data to go.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The directory, under the config directory.
const DIR: &str = "backups";

/// How many copies are kept per file.
///
/// Three because the interesting one is almost always the most recent, and the
/// second and third exist for the case where a migration was wrong and shipped
/// in two consecutive versions.
const PER_STEM: usize = 3;

/// Move `path` into the backups directory, labelled, and trim to [`PER_STEM`].
///
/// Returns where it went, or `None` if it could not be moved — in which case
/// the original is still where it was, which is the safe half of the failure.
///
/// A move rather than a copy. The caller is about to treat the file as absent,
/// and leaving it in place would mean the next save writing over it: the point
/// is to get it out of the way *and* keep it, not to keep a second copy of
/// something that is about to be destroyed.
pub fn keep(path: &Path, label: &str) -> Option<PathBuf> {
    let dir = path.parent()?.join(DIR);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        crate::veistra_log!("could not create {}: {e}", dir.display());
        return None;
    }

    let stem = path.file_stem()?.to_str()?;
    let extension = path.extension().and_then(OsStr::to_str).unwrap_or("json");
    let target = dir.join(format!("{stem}.{label}.{}.{extension}", now_ms()));

    if let Err(e) = std::fs::rename(path, &target) {
        crate::veistra_log!("could not back up {}: {e}", path.display());
        return None;
    }

    trim(&dir, stem);
    Some(target)
}

/// The newest backup of `path` carrying `label`, if there is one.
///
/// What closes the loop on a downgrade. A build that set `layout.json` aside as
/// `format-3` and then ran again *as the newer build* would otherwise open on
/// an empty workspace with its own data sitting in a directory nothing looks
/// at — the user losing their layout permanently rather than for the duration
/// of the downgrade, which was the whole thing this was meant to avoid.
///
/// Newest by the timestamp in the name rather than by mtime: the name is what
/// this module wrote and controls, and mtime is what a backup tool, a sync
/// client or a file copy rewrites.
pub fn newest(path: &Path, label: &str) -> Option<PathBuf> {
    let dir = path.parent()?.join(DIR);
    let stem = path.file_stem()?.to_str()?;
    let prefix = format!("{stem}.{label}.");

    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|found| {
            found
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .max_by_key(|found| stamp_of(found))
}

/// Delete every backup of `stem` past the newest [`PER_STEM`].
///
/// Oldest first, and by the stamp in the name for [`newest`]'s reason. Every
/// label for one stem shares the budget: a file that has been corrupt twice and
/// from the future once has had three interesting moments, not three each.
fn trim(dir: &Path, stem: &str) {
    let prefix = format!("{stem}.");
    let mut found: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name.starts_with(&prefix))
            })
            .collect(),
        Err(e) => {
            crate::veistra_log!("could not list {}: {e}", dir.display());
            return;
        }
    };

    if found.len() <= PER_STEM {
        return;
    }

    found.sort_by_key(|path| stamp_of(path));
    for old in found.iter().take(found.len() - PER_STEM) {
        if let Err(e) = std::fs::remove_file(old) {
            crate::veistra_log!("could not remove {}: {e}", old.display());
        }
    }
}

/// The millisecond stamp out of a backup's name, or 0 for a name that has none.
///
/// Zero rather than a skip, so a file somebody dropped in this directory by
/// hand sorts oldest and is the first thing trimmed. Nothing else writes here.
fn stamp_of(path: &Path) -> u128 {
    path.file_name()
        .and_then(OsStr::to_str)
        .and_then(|name| name.rsplit('.').nth(1))
        .and_then(|stamp| stamp.parse().ok())
        .unwrap_or(0)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("veistra-backup-{tag}-{}", now_nanos()));
        std::fs::create_dir_all(&dir).expect("the temp directory is writable");
        dir.join("settings.json")
    }

    fn now_nanos() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    }

    /// `keep` stamps in milliseconds, and these tests write faster than that.
    /// Placing the file by hand is what lets a test say which is older.
    fn planted(path: &Path, label: &str, stamp: u128, contents: &str) -> PathBuf {
        let dir = path.parent().expect("has a parent").join(DIR);
        std::fs::create_dir_all(&dir).expect("creates");
        let target = dir.join(format!("settings.{label}.{stamp}.json"));
        std::fs::write(&target, contents).expect("writes");
        target
    }

    fn names(path: &Path) -> Vec<String> {
        let dir = path.parent().expect("has a parent").join(DIR);
        let mut out: Vec<String> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        out.sort();
        out
    }

    #[test]
    fn a_kept_file_moves_into_the_backups_directory_under_its_label() {
        let path = scratch("keep");
        std::fs::write(&path, "original").expect("writes");

        let kept = keep(&path, "corrupt").expect("kept");

        assert!(!path.exists(), "moved, not copied");
        assert_eq!(
            std::fs::read_to_string(&kept).expect("readable"),
            "original"
        );
        assert_eq!(
            kept.parent().and_then(|p| p.file_name()),
            Some(OsStr::new(DIR))
        );
        assert!(kept
            .file_name()
            .expect("named")
            .to_string_lossy()
            .starts_with("settings.corrupt."));
    }

    #[test]
    fn a_backup_names_the_format_it_came_from() {
        let path = scratch("labelled");
        std::fs::write(&path, "{}").expect("writes");

        let kept = keep(&path, "format-7").expect("kept");
        assert!(kept.to_string_lossy().contains("settings.format-7."));
    }

    #[test]
    fn only_three_backups_are_kept_per_stem() {
        let path = scratch("cap");
        for stamp in 1..=5 {
            planted(&path, "corrupt", stamp, &format!("copy {stamp}"));
        }
        std::fs::write(&path, "the sixth").expect("writes");

        keep(&path, "corrupt").expect("kept");

        assert_eq!(names(&path).len(), PER_STEM);
    }

    #[test]
    fn the_oldest_is_the_one_deleted() {
        let path = scratch("oldest");
        planted(&path, "corrupt", 1, "oldest");
        planted(&path, "corrupt", 2, "middle");
        planted(&path, "corrupt", 3, "newest");
        std::fs::write(&path, "the fourth").expect("writes");

        keep(&path, "corrupt").expect("kept");

        let kept = names(&path);
        assert_eq!(kept.len(), PER_STEM);
        assert!(!kept.iter().any(|n| n.contains(".1.")), "the oldest went");
        assert!(kept.iter().any(|n| n.contains(".3.")), "the newest stayed");
    }

    /// Every label for one file shares the budget. A store that has been
    /// corrupt twice and from the future once has had three interesting
    /// moments, not three of each.
    #[test]
    fn labels_share_one_budget_per_file() {
        let path = scratch("labels");
        planted(&path, "corrupt", 1, "a");
        planted(&path, "format-2", 2, "b");
        planted(&path, "corrupt", 3, "c");
        std::fs::write(&path, "d").expect("writes");

        keep(&path, "format-9").expect("kept");

        assert_eq!(names(&path).len(), PER_STEM);
    }

    #[test]
    fn the_newest_backup_under_a_label_is_the_one_found() {
        let path = scratch("newest");
        planted(&path, "format-3", 10, "older");
        let latest = planted(&path, "format-3", 20, "newer");
        planted(&path, "corrupt", 30, "a different label");

        assert_eq!(newest(&path, "format-3"), Some(latest));
        assert_eq!(newest(&path, "format-4"), None);
    }

    #[test]
    fn nothing_is_found_when_there_is_no_backups_directory() {
        let path = scratch("empty");
        assert_eq!(newest(&path, "format-3"), None);
    }

    /// The whole point of this module, and the regression somebody will
    /// introduce: no ordinary write goes anywhere near here.
    #[test]
    fn an_ordinary_save_takes_no_backup() {
        let path = scratch("no-backup");
        for _ in 0..5 {
            super::super::store::write(&path, &serde_json::json!({"a": 1}), "the settings");
        }

        assert!(
            !path.parent().expect("has a parent").join(DIR).exists(),
            "saving is not a moment at which anything is about to be lost"
        );
    }
}
