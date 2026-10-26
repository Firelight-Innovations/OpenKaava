//! Joining the manifest against the filesystem.
//!
//! The manifest says "engine should be at version 0.1.0". Discovery answers
//! "…and here is what is actually sitting on this machine right now".

use crate::error::{AppError, Result};
use crate::manifest::Manifest;
use crate::tool::{ResolvedTool, ToolSpec, ToolStatus};
use semver::Version;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// The whole picture handed to the UI in one payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackSnapshot {
    pub stack_name: String,
    pub stack_version: String,
    pub manifest_path: PathBuf,
    pub checkout_root: PathBuf,
    pub tools: Vec<ResolvedTool>,
}

/// Stack components this build actually resolves and reports health for.
///
/// veistra.toml pins every component of the stack, because the manifest's job is
/// to describe the whole of it — but a checkout that is nothing but a README in
/// an otherwise empty directory has no Cargo.toml or package.json for
/// `probe_version` to read, so it would resolve to `Unversioned` and the health
/// popover would carry a warning per component that nobody can act on,
/// drowning out anything that might actually be worth seeing.
///
/// This is the filter that keeps that from happening: a tool id not listed
/// here is dropped before `resolve_one` ever runs, so it is never probed and
/// never produces a `ResolvedTool` at all — not a warning the frontend has to
/// know to hide, nothing to resolve. veistra.toml keeps every pin regardless, so
/// no information about the stack's shape is lost; when a component gets past
/// a README, giving it health tracking back is exactly one id added here.
///
/// Empty today for a second reason on top of that one: veistra.toml's `[[tool]]`
/// array is itself empty. Schematify's two predecessor applications were its
/// two entries and are now folded into one in-repo app (`apps/README.md`), so
/// there is currently no stack component left to enable health tracking for.
const ENABLED_TOOLS: &[&str] = &[];

pub fn resolve(manifest_path: &Path, manifest: &Manifest) -> Result<StackSnapshot> {
    let manifest_dir = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let checkout_root = normalize(&manifest_dir.join(&manifest.stack.checkout_root));

    // `collect::<Result<Vec<_>>>()` is a neat Rust trick: an iterator of
    // `Result`s collects into a `Result<Vec<_>>` that is `Err` if *any* item
    // failed. So one bad tool entry aborts the whole resolve, which is what we
    // want — a malformed manifest shouldn't half-load.
    let tools = manifest
        .tools
        .iter()
        .filter(|spec| ENABLED_TOOLS.contains(&spec.id.as_str()))
        .map(|spec| resolve_one(spec, &checkout_root))
        .collect::<Result<Vec<_>>>()?;

    Ok(StackSnapshot {
        stack_name: manifest.stack.name.clone(),
        stack_version: manifest.stack.version.clone(),
        manifest_path: manifest_path.to_path_buf(),
        checkout_root,
        tools,
    })
}

fn resolve_one(spec: &ToolSpec, checkout_root: &Path) -> Result<ResolvedTool> {
    // Validate the pin even when the checkout is missing — a typo in veistra.toml
    // should be loud immediately, not the day someone finally clones the repo.
    let pinned = Version::parse(&spec.version).map_err(|source| AppError::Version {
        id: spec.id.clone(),
        version: spec.version.clone(),
        source,
    })?;

    let checkout_path = checkout_root.join(spec.dir_name());

    let status = if !checkout_path.is_dir() {
        ToolStatus::Missing
    } else {
        match probe_version(&checkout_path) {
            Some(found) if found == pinned.to_string() => ToolStatus::Ready { version: found },
            Some(found) => ToolStatus::Mismatch {
                expected: pinned.to_string(),
                found,
            },
            None => ToolStatus::Unversioned,
        }
    };

    Ok(ResolvedTool {
        spec: spec.clone(),
        status,
        is_git_repo: checkout_path.join(".git").exists(),
        // Listed last because this *moves* `checkout_path` into the struct;
        // anything that needs to borrow it has to come first.
        checkout_path,
    })
}

/// Read a checkout's own idea of its version.
///
/// Veistra components are either Rust crates or npm packages, so those two
/// manifests cover the field. A repo with neither — an empty scaffold, say —
/// returns `None` rather than an error, because "not built yet" is a normal
/// state during pre-alpha, not a failure.
fn probe_version(dir: &Path) -> Option<String> {
    // The `?` operator inside these helpers returns `None` early on any miss,
    // so a missing or malformed file just means "no version found here".
    read_cargo_version(&dir.join("Cargo.toml"))
        .or_else(|| read_npm_version(&dir.join("package.json")))
}

fn read_cargo_version(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let doc: toml::Value = raw.parse().ok()?;
    doc.get("package")?
        .get("version")?
        .as_str()
        .map(str::to_owned)
}

fn read_npm_version(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&raw).ok()?;
    doc.get("version")?.as_str().map(str::to_owned)
}

/// Collapse `.` and `..` segments lexically.
///
/// Deliberately *not* `Path::canonicalize`: that hits the filesystem (so it
/// fails for paths that don't exist yet, like a tool nobody has cloned) and on
/// Windows it returns `\\?\`-prefixed extended-length paths, which look alarming
/// in a UI. This is purely textual.
fn normalize(path: &Path) -> PathBuf {
    let mut components = path.components().peekable();

    // A Windows path may start with a prefix like `C:`. Seed the buffer with it
    // so the loop below never tries to `pop()` past the drive letter.
    let mut out = match components.peek() {
        Some(c @ Component::Prefix(..)) => {
            let c = *c;
            components.next();
            PathBuf::from(c.as_os_str())
        }
        _ => PathBuf::new(),
    };

    for component in components {
        match component {
            Component::Prefix(..) => unreachable!("a prefix can only lead a path"),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(segment) => out.push(segment),
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `CARGO_MANIFEST_DIR`, preferring the value Cargo puts in the
    /// environment of a test binary it launches over the one baked in at
    /// compile time.
    ///
    /// Several worktrees sharing one `CARGO_TARGET_DIR` (a deliberate
    /// convention for agents working this repo) hold identical sources, so
    /// Cargo can reuse a test binary compiled in a worktree that has since
    /// been removed, carrying that worktree's absolute path. Reading the
    /// environment first avoids resolving fixtures against a directory that
    /// no longer exists; the check below catches the rarer case where a
    /// stale binary somehow still ran, and names the problem instead of
    /// leaving a bare `NotFound` for the next agent to puzzle over.
    fn manifest_dir() -> PathBuf {
        let dir = PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR")
                .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string()),
        );
        assert!(
            dir.is_dir(),
            "CARGO_MANIFEST_DIR resolved to {}, which does not exist -- this looks like a \
             stale cross-worktree build (a test binary compiled in a worktree that has \
             since been removed and reused from a shared CARGO_TARGET_DIR); rerun \
             `cargo test` from this worktree to force a rebuild",
            dir.display()
        );
        dir
    }

    #[test]
    fn normalize_collapses_parent_segments() {
        let input = Path::new("C:/code/helve/orchestrator/../engine");
        assert_eq!(normalize(input), PathBuf::from("C:/code/helve/engine"));
    }

    #[test]
    fn normalize_drops_current_dir_segments() {
        let input = Path::new("C:/code/./helve");
        assert_eq!(normalize(input), PathBuf::from("C:/code/helve"));
    }

    /// Parses the repo's actual veistra.toml and resolves it. Catches a typo in a
    /// pinned version, an unknown key, or a malformed `[[tool]]` table at
    /// `cargo test` time instead of at app launch.
    #[test]
    fn the_shipped_manifest_parses_and_resolves() {
        let path = manifest_dir()
            .parent()
            .expect("src-tauri always has a parent")
            .join("veistra.toml");

        let manifest = crate::manifest::Manifest::load(&path).expect("veistra.toml should parse");
        let snapshot =
            resolve(&path, &manifest).expect("every pinned version should be valid semver");

        // veistra.toml's `[[tool]]` array is empty today — Schematify's two predecessors,
        // its only two entries, were reclassified as in-repo apps (see
        // `apps/README.md`) and nothing has taken their place yet. That is a
        // legitimate state for the manifest, not a broken fixture, so this test
        // no longer asserts non-emptiness; the assertion below still catches
        // `ENABLED_TOOLS` silently widening or narrowing what it lets through.
        //
        // `snapshot.tools` is `manifest.tools` narrowed by `ENABLED_TOOLS`, not
        // a straight pass-through — see that constant's doc comment. Asserting
        // the exact count, rather than just "resolve didn't error", is what
        // would actually catch the filter silently resolving everything (or
        // nothing) it shouldn't.
        let expected = manifest
            .tools
            .iter()
            .filter(|t| ENABLED_TOOLS.contains(&t.id.as_str()))
            .count();
        assert_eq!(
            snapshot.tools.len(),
            expected,
            "ENABLED_TOOLS filtering changed"
        );

        // Every tool resolves to a path under the checkout root, and ids are unique.
        let mut ids: Vec<&str> = snapshot.tools.iter().map(|t| t.spec.id.as_str()).collect();
        ids.sort_unstable();
        let unique = ids.len();
        ids.dedup();
        assert_eq!(unique, ids.len(), "duplicate tool id in veistra.toml");

        for tool in &snapshot.tools {
            assert!(
                tool.checkout_path.starts_with(&snapshot.checkout_root),
                "{} resolved outside the checkout root",
                tool.spec.id
            );
        }
    }

    #[test]
    fn probe_version_is_none_for_a_bare_directory() {
        let dir = std::env::temp_dir().join("veistra-probe-empty-test");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(probe_version(&dir), None);
        let _ = std::fs::remove_dir(&dir);
    }

    /// A tool id absent from `ENABLED_TOOLS` never reaches `resolve_one` — it
    /// has to not appear in the snapshot at all, not appear there tagged
    /// `Missing` or `Unversioned`. Built against a synthetic manifest, not the
    /// shipped one, so this stays meaningful regardless of which ids
    /// `ENABLED_TOOLS` names on a given day.
    #[test]
    fn only_allowlisted_tools_reach_the_snapshot() {
        use crate::manifest::StackInfo;
        use crate::tool::ToolKind;

        fn spec(id: &str) -> ToolSpec {
            ToolSpec {
                id: id.to_string(),
                name: id.to_string(),
                kind: ToolKind::DevTool,
                repo: "https://example.invalid/repo".to_string(),
                version: "0.1.0".to_string(),
                description: String::new(),
                path: None,
            }
        }

        let manifest = Manifest {
            stack: StackInfo {
                name: "Test".to_string(),
                version: "0.0.0".to_string(),
                checkout_root: ".".to_string(),
            },
            tools: vec![spec("definitely-not-a-real-tool-id"), spec("also-not-real")],
        };

        let snapshot = resolve(Path::new("veistra.toml"), &manifest).expect("resolves");
        assert!(
            snapshot.tools.is_empty(),
            "neither synthetic id is on ENABLED_TOOLS, so neither should resolve"
        );
    }
}
