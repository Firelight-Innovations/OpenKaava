//! The `<name>.veistra` file — what makes a folder a Veistra project.
//!
//! Two things sit at the root of a project and they do opposite jobs:
//!
//!   * **`<name>.veistra`** is what the project *is*. Identity, and whatever Veistra
//!     needs to know before it opens anything. It is small, it is a human's to
//!     read and edit, and it belongs in version control.
//!   * **`.veistra/`** is what Veistra *produced*. Agent traces, designs, docs, the
//!     history of how the game got built. It grows without bound and no human
//!     hand-edits it.
//!
//! They cannot share a name — one directory cannot hold both a file called
//! `.veistra` and a folder called `.veistra` — so the manifest takes the project's
//! own name and the [`EXTENSION`]. [`load`] holds the forward-compatibility
//! promise: a file from a newer Veistra still opens here.

use crate::error::{AppError, Result};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The extension that names a project manifest — `<name>.veistra`, the way
/// `.uproject` and `.sln` do it. Naming the file after the project also means
/// the filename says which project it is when it turns up in a search result,
/// and it leaves room for the OS to learn `.veistra` as a file type that launches
/// this orchestrator.
pub const EXTENSION: &str = "veistra";

/// The directory beside it, holding everything Veistra generates about the
/// project. Created empty — what goes inside is not designed yet, and inventing
/// a subdirectory layout now would be committing to a shape nothing has asked
/// for.
pub const TRACE_DIR: &str = ".veistra";

/// The format version this build writes.
///
/// Bumped when a change would make an *older* build misread the file, not merely
/// miss part of it. Adding a key is not a bump; changing what an existing key
/// means is.
pub const FORMAT: i64 = 1;

/// A project manifest, as this build understands it.
///
/// Carries no path of its own: [`find`] already answered where it is, and a
/// second copy of that would only be a second thing that could be wrong.
#[derive(Debug, Clone)]
pub struct Marker {
    pub name: String,
    /// Stable across renames and moves. Empty for a manifest written before ids
    /// existed, or one hand-edited to drop it — a project without one still
    /// opens, it just cannot be recognised as the same project somewhere else.
    pub id: String,
    /// The `format` this file declares. Greater than [`FORMAT`] means it was
    /// written by a newer Veistra and this build is reading it partially.
    pub format: i64,
}

/// Find the manifest in a project directory, if there is one.
///
/// A directory with two `.veistra` files is malformed rather than ambiguous, but
/// this has to answer *something* — so it takes the lexicographically first,
/// which at least makes the answer the same on every machine and every launch.
/// A filesystem's own iteration order is not stable across either.
///
/// `.veistra` the directory cannot be mistaken for a manifest here: Rust treats a
/// leading dot as the start of the file stem, so `.veistra` has no extension at
/// all, and the `is_file` check would reject it regardless.
pub fn find(dir: &Path) -> Option<PathBuf> {
    let mut found: Option<PathBuf> = None;

    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        if found.as_ref().is_none_or(|current| path < *current) {
            found = Some(path);
        }
    }

    found
}

/// Read a manifest. Deliberately lenient: unknown tables and unknown keys are
/// ignored rather than rejected, and every field this build reads has a
/// fallback. A project written by a later Veistra must still open here, degraded,
/// rather than failing to open at all — and `format` is how this build finds out
/// that is what happened, so it can say so instead of quietly misreading the
/// file.
///
/// The other half of that promise is not yet owed: nothing rewrites a marker
/// today, only creates one. When something does, it must **merge into the parsed
/// document rather than re-serialize this struct**, or the first save from an old
/// build will silently drop every key a newer one added.
pub fn load(path: &Path) -> Result<Marker> {
    let raw = std::fs::read_to_string(path).map_err(|source| AppError::Io {
        path: path.display().to_string(),
        source,
    })?;

    let doc: toml::Table = raw.parse().map_err(|source| AppError::Toml {
        path: path.display().to_string(),
        source,
    })?;

    let project = doc.get("project").and_then(|v| v.as_table());

    // The filename is the fallback for the name, and that is not arbitrary: the
    // file is *called* `<name>.veistra`, so its stem already carries the answer.
    let name = project
        .and_then(|p| p.get("name"))
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });

    Ok(Marker {
        name,
        id: project
            .and_then(|p| p.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        format: doc
            .get("veistra")
            .and_then(|v| v.as_table())
            .and_then(|h| h.get("format"))
            .and_then(toml::Value::as_integer)
            .unwrap_or(FORMAT),
    })
}

/// Write a fresh manifest into `dir`, and create the `.veistra/` directory beside
/// it. Fails if a manifest is already there — adopting an existing project is
/// [`super::open`]'s job, and silently overwriting one would throw away its id.
pub fn create(dir: &Path, name: &str) -> Result<Marker> {
    if let Some(existing) = find(dir) {
        return Err(AppError::AlreadyAProject(existing.display().to_string()));
    }

    let path = dir.join(format!("{name}.{EXTENSION}"));
    let id = mint_id(&path);

    // Written by hand rather than serialized from a struct, because this file's
    // comments are most of its value: it is the first thing a person opens when
    // they want to know what a Veistra project is, and `toml::to_string` cannot
    // emit a comment.
    let contents = format!(
        r#"# A Veistra project.
#
# This file is the project itself — its identity, and what Veistra needs to know
# before opening anything. Small, yours to edit, and meant for version control.
#
# The `.veistra/` directory beside it is the opposite: everything Veistra produces
# about this project — agent traces, designs, docs, the history of how the game
# got built. Machine-written, and it grows.

[veistra]
# Bumped only when a change would make an older Veistra misread this file.
format = {FORMAT}
created-with = "{version}"

[project]
# Stable across renames and moves. What Veistra means when it says "this project".
id = "{id}"
name = "{name}"
# Milliseconds since the Unix epoch. Stored as a number rather than a date so
# there is exactly one way to read it and no timezone to get wrong.
created-unix-ms = {created}
"#,
        version = env!("CARGO_PKG_VERSION"),
        created = now_ms(),
    );

    std::fs::write(&path, contents).map_err(|source| AppError::Io {
        path: path.display().to_string(),
        source,
    })?;

    let traces = dir.join(TRACE_DIR);
    std::fs::create_dir_all(&traces).map_err(|source| AppError::Io {
        path: traces.display().to_string(),
        source,
    })?;

    Ok(Marker {
        name: name.to_string(),
        id,
        format: FORMAT,
    })
}

/// Milliseconds since the Unix epoch.
///
/// `0` if the clock is set before 1970, which is not a state worth failing an
/// otherwise-good project creation over.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A project id: the creation time, then a hash of the time and the path.
///
/// Not a UUID, because a dependency for one value is a poor trade and this needs
/// only to be unique among projects on machines a person actually uses — two
/// collisions would have to be created in the same nanosecond at the same path.
/// The leading timestamp also makes ids sort chronologically, which costs
/// nothing and is occasionally useful.
fn mint_id(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    nanos.hash(&mut hasher);

    format!("{nanos:016x}{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp directory that cleans itself up, so these tests can touch a real
    /// filesystem — which is the only way to test `find`, since its whole job is
    /// reading one.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("veistra-marker-{tag}-{}", now_ms()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn create_writes_a_manifest_that_load_reads_back() {
        let dir = TempDir::new("roundtrip");
        let written = create(&dir.0, "MyGame").expect("create");

        let path = find(&dir.0).expect("create leaves a manifest find can locate");
        assert_eq!(path.file_name().unwrap(), "MyGame.veistra");
        assert!(
            dir.0.join(TRACE_DIR).is_dir(),
            ".veistra/ is created beside it"
        );

        let read = load(&path).expect("load");
        assert_eq!(read.name, "MyGame");
        assert_eq!(read.id, written.id, "the id survives the round trip");
        assert_eq!(read.format, FORMAT);
    }

    #[test]
    fn find_locates_the_manifest_and_ignores_the_trace_directory() {
        let dir = TempDir::new("find");
        create(&dir.0, "MyGame").expect("create");

        let found = find(&dir.0).expect("a manifest is there");
        assert_eq!(found.file_name().unwrap(), "MyGame.veistra");
    }

    #[test]
    fn find_is_none_for_a_plain_folder() {
        let dir = TempDir::new("plain");
        std::fs::write(dir.0.join("readme.txt"), "not a project").expect("write");
        assert!(find(&dir.0).is_none());
    }

    #[test]
    fn creating_over_an_existing_project_is_refused() {
        let dir = TempDir::new("twice");
        create(&dir.0, "MyGame").expect("create");

        let second = create(&dir.0, "Other");
        assert!(
            matches!(second, Err(AppError::AlreadyAProject(_))),
            "a second manifest would orphan the first project's id"
        );
    }

    /// The forward-compatibility promise in the module doc, as a test: a file
    /// from a later Veistra, with tables and keys this build has never heard of,
    /// still opens — and still reports the format that produced it.
    #[test]
    fn a_manifest_from_a_newer_veistra_still_loads() {
        let dir = TempDir::new("newer");
        let path = dir.0.join("Future.veistra");
        std::fs::write(
            &path,
            r#"
[veistra]
format = 99
created-with = "9.0.0"

[project]
id = "abc123"
name = "Future"
engine-channel = "nightly"

[rendering]
pipeline = "deferred"
"#,
        )
        .expect("write");

        let marker = load(&path).expect("an unknown key must not fail the read");
        assert_eq!(marker.name, "Future");
        assert_eq!(marker.id, "abc123");
        assert_eq!(
            marker.format, 99,
            "so the caller can say it is reading it partially"
        );
    }

    #[test]
    fn a_manifest_with_no_name_falls_back_to_its_filename() {
        let dir = TempDir::new("nameless");
        let path = dir.0.join("Salvage.veistra");
        std::fs::write(&path, "[veistra]\nformat = 1\n").expect("write");

        assert_eq!(load(&path).expect("load").name, "Salvage");
    }
}
