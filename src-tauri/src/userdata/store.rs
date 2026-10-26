//! The one place a user-data store reads and writes its file.
//!
//! Eight modules used to carry a copy of the same twenty lines. That was not
//! duplication for its own sake — `presets::store` says the copy is deliberate,
//! because "a second version of it that drifted would be a second way to lose a
//! file" — and the argument was right about the risk. Eight copies could not
//! drift apart. They could all be wrong together, which is what [`FORMAT`],
//! [`set_aside`] and [`durably`] each turned out to be about.
//!
//! `docs/dev/user-data.md` has the table of what is precious and what is cheap,
//! which is the whole of what [`Keep`] encodes.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The format every store in the config directory writes today.
///
/// Bumped when a change would make an *older* build **misread** a file, not
/// when it would merely miss part of it — `project::marker::FORMAT`'s rule,
/// verbatim, because two rules would be one rule and a bug. Adding a field is
/// not a bump: serde already handles that in both directions, and bumping for
/// it would set a file aside over a change that costs nothing.
pub const FORMAT: i64 = 1;

/// Whether a file this build cannot use is worth keeping a copy of.
///
/// The distinction is the one `docs/dev/user-data.md` draws between precious
/// and reconstructible, and it decides one thing: whether an unusable file is
/// renamed out of the way or simply replaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keep {
    /// The user typed it and nothing can reconstruct it — a Recent list, a
    /// preset library, every setting they have moved.
    Aside,
    /// Losing it is annoying rather than destructive, and a directory that
    /// accumulates a copy of every corrupt `layout.json` is its own problem.
    Nothing,
}

/// Just the version, read before anything else in the document is looked at.
///
/// A missing `format` is read as 1 rather than rejected: that is every file on
/// disk today, and requiring a rewrite to make them legible would be this
/// change breaking the thing it exists to protect.
#[derive(Deserialize)]
struct Envelope {
    #[serde(default = "format_one")]
    format: i64,
}

fn format_one() -> i64 {
    1
}

/// Read a store, or start from its default.
///
/// **Never fatal.** Every failure below degrades to `T::default()`, which is
/// the promise all eight stores already made and the reason this returns a
/// value rather than a `Result`: the worst honest outcome of an unreadable file
/// is an empty Recent list, and that is a great deal better than an app that
/// will not open.
pub fn read<T: DeserializeOwned + Default>(path: &Path, keep: Keep) -> T {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        // Not-found is the ordinary case — nobody has changed anything yet —
        // and says nothing worth printing. Anything else is a real read failure
        // and is worth a line, because the visible symptom is a screen showing
        // every default, which looks exactly like a first launch.
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                crate::veistra_log!("could not read {}: {e}", path.display());
                return T::default();
            }
            return restored(path).unwrap_or_default();
        }
    };

    let format = match serde_json::from_str::<Envelope>(&raw) {
        Ok(envelope) => envelope.format,
        Err(e) => {
            crate::veistra_log!("{} is not readable: {e}", path.display());
            set_aside(path, "corrupt", keep);
            return T::default();
        }
    };

    if format > FORMAT {
        crate::veistra_log!(
            "{} is format {format} and this build reads {FORMAT}; setting it aside",
            path.display()
        );
        // Always kept, whatever `keep` says. This is not a damaged file: it is
        // an intact one belonging to a build the user still has, and replacing
        // it is the exact data loss this module was written for. `restored`
        // above is the other half: the build that wrote it takes it back.
        set_aside(path, &format!("format-{format}"), Keep::Aside);
        return T::default();
    }

    // `format < FORMAT` lands here too, and today that can only be a file with
    // no field at all. The first bump is what adds a migration chain; there is
    // deliberately no empty one now, because a chain with no links is a shape
    // to maintain rather than a behaviour.
    serde_json::from_str(&raw).unwrap_or_else(|e| {
        crate::veistra_log!(
            "{} is format {format} and still did not parse: {e}",
            path.display()
        );
        set_aside(path, "corrupt", keep);
        T::default()
    })
}

/// Write a store, atomically, with the format stamped on it.
///
/// Temp file then rename — atomic on NTFS and POSIX alike, so a crash mid-write
/// leaves the previous file intact rather than half of two. `what` names the
/// store in the log and is a noun phrase: "the layout", "the preset store".
pub fn write<T: Serialize>(path: &Path, value: &T, what: &str) {
    match stamped(value) {
        Ok(json) => write_raw(path, &json, what),
        Err(e) => crate::veistra_log!("could not serialize {what}: {e}"),
    }
}

/// The same write, for a document that is already text and carries no format.
///
/// One caller: `mcp::handoff`, which writes this launch's port and token for an
/// agent Veistra did not spawn. That file is not user data — it is rewritten
/// at every launch and its only reader is `scripts/veistra-probe.mjs` — so
/// stamping a version on it would version a fact rather than a format. It is
/// here for the temp-then-rename, which it does want.
pub fn write_raw(path: &Path, text: &str, what: &str) {
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            crate::veistra_log!("could not create {}: {e}", parent.display());
            return;
        }
    }

    let temp = temp_path(path);
    if let Err(e) = durably(&temp, text) {
        crate::veistra_log!("could not write {what} to {}: {e}", temp.display());
        let _ = std::fs::remove_file(&temp);
        return;
    }
    if let Err(e) = std::fs::rename(&temp, path) {
        crate::veistra_log!("could not replace {}: {e}", path.display());
        let _ = std::fs::remove_file(&temp);
    }
}

/// Write the bytes and **flush them to the device** before returning.
///
/// `std::fs::write` opens, writes and closes; it does not ask the drive to
/// commit anything. The rename that follows replaces a directory entry, and the
/// order in which the data and that entry reach the platter is NTFS's business
/// — so on power loss the observable result can be a correctly named file that
/// is empty or short. Temp-then-rename protects against the *process* dying
/// between two writes and never protected against this.
///
/// `sync_all` is a real cost and is paid on every divider drag, because
/// `layout.json` is written from inside `ShellState::mutate`. Paid anyway
/// rather than made conditional: a flush of a few kilobytes on an SSD is small,
/// and the alternative — the file rewritten hundreds of times a session being
/// the one file not committed — is exactly backwards. If it ever measures as a
/// problem, the fix is to debounce the layout write, not to drop the flush.
fn durably(temp: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut file = std::fs::File::create(temp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

/// `layout.json.<pid>.tmp` — a temp name no other process shares.
///
/// Every store used to compute `path.with_extension("json.tmp")`, so two
/// processes writing the same store wrote the same path and interleaved into
/// one file. That needs the single-instance mutex to have failed, which is
/// precisely what an identifier change does — and coupling a naming mistake to
/// a corrupt file is worth removing for the cost of a `format!`.
///
/// **The trade, stated because it is a real one:** the old fixed name was
/// reused by the next write, so a process killed between `create` and `rename`
/// left at most one stray temp file per store. This leaves one per *pid*.
/// Nothing sweeps them, deliberately — a sweep would have to decide which
/// `.tmp` belongs to a live process, and reading the process table to tidy a
/// few kilobytes is a worse trade than the kilobytes. The window is between two
/// adjacent statements, so a file only appears when the process dies inside it.
fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    path.with_file_name(name)
}

/// The document a store writes: its own fields, plus `format`.
///
/// Through a `Value` rather than by giving all eight `Stored` structs a field
/// of their own. None of them denies unknown fields, so every one already
/// *reads* this key and ignores it, and adding eight identical fields — each
/// needing a default, and each serializable to something other than [`FORMAT`]
/// — would be eight chances to write a version that is not the one this build
/// speaks.
fn stamped<T: Serialize>(value: &T) -> serde_json::Result<String> {
    let mut document = serde_json::to_value(value)?;
    if let Some(object) = document.as_object_mut() {
        object.insert("format".to_string(), Value::from(FORMAT));
    }
    serde_json::to_string_pretty(&document)
}

/// Move an unusable file into `backups/`, or leave it to be written over.
///
/// `Keep::Nothing` does nothing at all, which means the next save replaces the
/// bad file in place. That is the intended outcome for `layout.json`: see
/// `shell_store::KEEP`.
fn set_aside(path: &Path, label: &str, keep: Keep) {
    if keep == Keep::Nothing {
        return;
    }

    if let Some(kept) = super::backup::keep(path, label) {
        crate::veistra_log!("set {} aside as {}", path.display(), kept.display());
    }
}

/// The newest backup this build could read, taken back.
///
/// Only ever reached when the file itself is **missing**, so this can never
/// overwrite live data. The case it exists for: a build at this format set its
/// file aside for a *newer* one, the user then downgraded and came back, and
/// the newer build's own data is sitting in `backups/` labelled with the format
/// it was written in — which is this one.
fn restored<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let found = super::backup::newest(path, &format!("format-{FORMAT}"))?;
    let raw = std::fs::read_to_string(&found).ok()?;
    let value = serde_json::from_str(&raw).ok()?;

    if let Err(e) = std::fs::rename(&found, path) {
        crate::veistra_log!("read {} but could not restore it: {e}", found.display());
        // Still returned. The value is right, and the worst case is reading it
        // out of the backup again next launch.
        return Some(value);
    }

    crate::veistra_log!("restored {} from {}", path.display(), found.display());
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A store shaped like the real ones: forward-compatible, sparse, and with
    /// a default that means "nothing has been changed".
    #[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    struct Stored {
        values: BTreeMap<String, String>,
    }

    fn scratch(tag: &str) -> PathBuf {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("veistra-store-{tag}-{at}"));
        std::fs::create_dir_all(&dir).expect("the temp directory is writable");
        dir.join("settings.json")
    }

    fn one(key: &str) -> Stored {
        Stored {
            values: BTreeMap::from([(key.to_string(), "value".to_string())]),
        }
    }

    /// Where a set-aside file went — `backups/`, under its label. See
    /// `userdata::backup` for why that is not beside the original.
    fn aside(path: &Path, label: &str) -> Option<PathBuf> {
        super::super::backup::newest(path, label)
    }

    #[test]
    fn a_value_survives_a_round_trip_and_carries_the_format() {
        let path = scratch("round-trip");
        write(&path, &one("editor.fontSize"), "the settings");

        let raw = std::fs::read_to_string(&path).expect("written");
        assert!(raw.contains("\"format\": 1"), "stamped: {raw}");
        assert_eq!(read::<Stored>(&path, Keep::Aside), one("editor.fontSize"));
    }

    /// Every file on disk when this landed. Requiring a rewrite to make them
    /// legible would be the change breaking what it exists to protect.
    #[test]
    fn a_file_with_no_format_field_is_read_as_format_one() {
        let path = scratch("no-format");
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("creates");
        std::fs::write(&path, r#"{"values":{"a":"value"}}"#).expect("writes");

        assert_eq!(read::<Stored>(&path, Keep::Aside), one("a"));
        assert!(path.exists(), "and it is not set aside");
    }

    /// The downgrade case, and the worst failure in the design before this
    /// existed: parsing it would drop the newer build's fields and the next
    /// save would write the truncated value back over the original.
    #[test]
    fn a_file_from_a_newer_format_is_set_aside_rather_than_parsed() {
        let path = scratch("newer");
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("creates");
        std::fs::write(&path, r#"{"format":3,"values":{"a":"b"},"newThing":42}"#).expect("writes");

        assert_eq!(read::<Stored>(&path, Keep::Aside), Stored::default());
        assert!(
            !path.exists(),
            "the original is moved, not left to be written over"
        );
        assert!(aside(&path, "format-3").is_some());
    }

    /// The set-aside file is what the newer build finds when it comes back, so
    /// losing a byte of it would make the whole mechanism pointless.
    #[test]
    fn a_set_aside_file_keeps_every_byte_it_had() {
        let path = scratch("bytes");
        let original = r#"{"format":9,"values":{"a":"b"},"newThing":[1,2,3]}"#;
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("creates");
        std::fs::write(&path, original).expect("writes");

        let _: Stored = read(&path, Keep::Aside);
        let kept = aside(&path, "format-9").expect("set aside");
        assert_eq!(std::fs::read_to_string(kept).expect("readable"), original);
    }

    /// A future-format file is intact and belongs to a build the user still
    /// has, so it is kept whatever the store said about its own worth.
    #[test]
    fn a_newer_format_is_kept_even_for_a_store_that_keeps_nothing() {
        let path = scratch("newer-cheap");
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("creates");
        std::fs::write(&path, r#"{"format":2}"#).expect("writes");

        let _: Stored = read(&path, Keep::Nothing);
        assert!(aside(&path, "format-2").is_some());
    }

    #[test]
    fn a_corrupt_precious_store_is_set_aside_before_the_default_replaces_it() {
        let path = scratch("corrupt");
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("creates");
        std::fs::write(&path, "{ not json").expect("writes");

        assert_eq!(read::<Stored>(&path, Keep::Aside), Stored::default());
        let kept = aside(&path, "corrupt").expect("set aside");
        assert_eq!(
            std::fs::read_to_string(kept).expect("readable"),
            "{ not json"
        );
    }

    /// The deliberate asymmetry, asserted so nobody "fixes" it later. A layout
    /// is rewritten on every divider drag and is the file most likely to be
    /// caught mid-write; a copy of each one is a directory of debris in
    /// exchange for a workspace the user can rebuild in a minute.
    #[test]
    fn a_corrupt_layout_is_not_copied() {
        let path = scratch("corrupt-cheap");
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("creates");
        std::fs::write(&path, "{ not json").expect("writes");

        assert_eq!(read::<Stored>(&path, Keep::Nothing), Stored::default());
        assert!(aside(&path, "corrupt").is_none(), "nothing is kept");
    }

    /// Two Veistra processes writing one store is only possible when the
    /// single-instance mutex has failed — which is what an identifier change
    /// does — and a shared temp name turns that into a corrupt file rather than
    /// a last-writer-wins one.
    #[test]
    fn two_writers_do_not_share_a_temp_file() {
        let path = scratch("temp-name");
        let temp = temp_path(&path);

        assert_ne!(temp, path.with_extension("json.tmp"));
        assert!(temp
            .file_name()
            .expect("has a name")
            .to_string_lossy()
            .contains(&std::process::id().to_string()));
        assert_eq!(temp.parent(), path.parent(), "beside the file it replaces");
    }

    /// The whole point of writing somewhere else first. A `Serialize` that
    /// fails leaves the previous file untouched — and, before this, would have
    /// left a temp file behind on every attempt.
    #[test]
    fn a_failed_write_removes_its_own_temp_file() {
        let path = scratch("failed-write");
        write(&path, &one("kept"), "the settings");

        // A directory cannot be opened with `File::create`, so this is a write
        // that fails after the parent exists and before the rename.
        let temp = temp_path(&path);
        std::fs::create_dir_all(&temp).expect("stands in for an unwritable temp path");
        write_raw(&path, "{}", "the settings");

        assert_eq!(read::<Stored>(&path, Keep::Aside), one("kept"));
        assert!(temp.exists(), "a directory in the way is not deleted");
        std::fs::remove_dir(&temp).expect("cleans up");
    }

    /// A rename that cannot happen must not take the previous file with it.
    #[test]
    fn a_failed_rename_leaves_the_previous_file_intact() {
        let path = scratch("failed-rename");
        write(&path, &one("kept"), "the settings");
        let before = std::fs::read_to_string(&path).expect("written");

        // Renaming onto a *directory* fails on Windows and Unix alike, which is
        // the closest a test can get to the sharing violation this guards.
        let blocked = path.with_file_name("blocked.json");
        std::fs::create_dir_all(&blocked).expect("creates");
        write_raw(&blocked, "{}", "the settings");

        assert_eq!(std::fs::read_to_string(&path).expect("still there"), before);
        assert!(
            !temp_path(&blocked).exists(),
            "and the temp file it could not rename is cleaned up"
        );
    }

    /// The downgrade, and the return from it, end to end. Setting a file aside
    /// only halves the problem: without this the build that wrote it opens on
    /// an empty workspace with its own data in a directory nothing reads.
    #[test]
    fn a_file_set_aside_by_an_older_build_is_taken_back() {
        let path = scratch("round-the-downgrade");
        write(&path, &one("survives"), "the settings");
        let written = std::fs::read_to_string(&path).expect("written");

        // The older build's read: this file claims a format it cannot handle.
        let pretending = written.replace("\"format\": 1", "\"format\": 1000");
        std::fs::write(&path, &pretending).expect("writes");
        assert_eq!(read::<Stored>(&path, Keep::Aside), Stored::default());
        assert!(!path.exists());

        // And this build's, once the user is back on it. `format-1000` is the
        // label, because that is the format the file was written in.
        let mine = aside(&path, "format-1000").expect("set aside");
        std::fs::rename(&mine, mine.with_file_name("settings.format-1.9.json")).expect("relabels");

        assert_eq!(read::<Stored>(&path, Keep::Aside), one("survives"));
        assert!(path.exists(), "and it is back where it belongs");
    }

    #[test]
    fn a_missing_file_is_the_default_and_not_a_complaint() {
        let path = scratch("missing");
        assert_eq!(read::<Stored>(&path, Keep::Aside), Stored::default());
    }

    /// The forward half of the compatibility promise, which the format field
    /// must not have taken away: a *same-format* file with a field this build
    /// has never heard of still loads.
    #[test]
    fn an_unknown_field_at_the_current_format_still_reads() {
        let path = scratch("unknown");
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("creates");
        std::fs::write(&path, r#"{"format":1,"values":{"a":"value"},"team":true}"#)
            .expect("writes");

        assert_eq!(read::<Stored>(&path, Keep::Aside), one("a"));
    }
}
