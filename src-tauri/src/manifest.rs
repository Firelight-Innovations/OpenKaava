//! Locating and parsing veistra.toml.

use crate::error::{AppError, Result};
use crate::tool::ToolSpec;
use serde::Deserialize;
use std::path::{Path, PathBuf};
// `Manager` is the trait that puts `.path()` on `AppHandle`. Rust only exposes a
// trait's methods where the trait is in scope, which is why it's imported here
// even though the name never appears below.
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct Manifest {
    pub stack: StackInfo,
    /// The `[[tool]]` array-of-tables. TOML reads better singular, Rust reads
    /// better plural, so we rename across the boundary.
    #[serde(default, rename = "tool")]
    pub tools: Vec<ToolSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct StackInfo {
    pub name: String,
    pub version: String,
    #[serde(default = "default_checkout_root")]
    pub checkout_root: String,
}

fn default_checkout_root() -> String {
    "..".to_string()
}

impl Manifest {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path).map_err(|source| AppError::Io {
            path: path.display().to_string(),
            source,
        })?;

        toml::from_str(&raw).map_err(|source| AppError::Toml {
            path: path.display().to_string(),
            source,
        })
    }
}

/// Find veistra.toml, trying the most specific location first.
///
/// This matters because `tauri dev` runs the binary with its working directory
/// set to `src-tauri/`, while a bundled release runs from wherever the user
/// installed it — so "just look in the current directory" would break in both.
///
/// Order is deliberate: an explicit override beats a manifest the user dropped
/// next to the app, which beats the copy baked into the bundle.
pub fn locate(app: &AppHandle) -> Result<PathBuf> {
    let mut tried: Vec<PathBuf> = Vec::new();

    // 1. Explicit override. Useful for tests, and for pointing a dev build at a
    //    different stack checkout without editing anything.
    if let Ok(raw) = std::env::var("VEISTRA_MANIFEST") {
        let candidate = PathBuf::from(raw);
        if candidate.is_file() {
            return Ok(candidate);
        }
        tried.push(candidate);
    }

    // 2. Dev builds: the repo root is the parent of `src-tauri/`.
    //    `CARGO_MANIFEST_DIR` is baked in at compile time, so this holds no
    //    matter what the process's working directory happens to be.
    #[cfg(debug_assertions)]
    if let Some(repo_root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        let candidate = repo_root.join("veistra.toml");
        if candidate.is_file() {
            return Ok(candidate);
        }
        tried.push(candidate);
    }

    // 3. A manifest the user placed beside the installed executable. This is the
    //    escape hatch that makes an installed build usable: the bundled copy in
    //    step 4 points at paths that only exist on a dev machine.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("veistra.toml");
            if candidate.is_file() {
                return Ok(candidate);
            }
            tried.push(candidate);
        }
    }

    // 4. The copy bundled into the app by `tauri.conf.json`'s `bundle.resources`.
    //    Resources have to be found through Tauri's path API rather than guessed
    //    relative to the exe — the layout differs per platform (next to the
    //    binary on Windows, inside `Contents/Resources` in a macOS .app).
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join("veistra.toml");
        if candidate.is_file() {
            return Ok(candidate);
        }
        tried.push(candidate);
    }

    let looked_in = tried
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(AppError::ManifestNotFound(looked_in))
}
