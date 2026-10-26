//! Where a tool's frontend is served from, and how.
//!
//! A tool mounts into the tool window as an iframe on its own origin — see
//! `docs/tool-protocol.md` §3. That leaves one question the shell has to answer
//! before it can render anything: what URL goes in the `src`.
//!
//! There are two answers, and which one applies is not a preference:
//!   * **In development**, the tool's own Vite server, declared as `frontend.dev-url` in
//!     `veistra-tool.toml`. Pointing at it means the tool's hot reload works *inside the real
//!     shell*, which is the whole reason a tool author would run the orchestrator at all.
//!   * **In a release build**, the tool's built `frontend.dist` directory, served over the custom
//!     `veistra-tool://` scheme registered below. There is no dev server in a shipped app, and
//!     loading a built bundle off `file://` would put every tool on the same opaque origin — the
//!     exact thing the protocol's origin checks depend on not happening.
//!
//! Everything else — a checkout that isn't there, a manifest that doesn't
//! parse — resolves to `Unavailable` with a reason. The shell renders that as a
//! state rather than as an iframe pointing at nothing.

use crate::error::Result;
use crate::plugins;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use veistra_tool_manifest::ToolManifest;

/// The scheme detached and docked tool frames are served on in release builds.
/// Tauri rewrites this per-platform (`veistra-tool://…` on macOS and Linux,
/// `http://veistra-tool.localhost/…` on Windows); the frontend never constructs
/// one of these by hand, it only ever uses what this module hands back.
pub const SCHEME: &str = "veistra-tool";

/// What the tool window should do about a given tool.
///
/// Serialized with an internal `state` tag so it lands in TypeScript as a
/// discriminated union, the same shape as `ToolStatus` — narrow on `state` and
/// the extra fields come with it.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ToolFrontend {
    /// Point the iframe here. The tool's own dev server, or its bundle.
    Mountable { url: String },
    /// Nothing to mount, and why. The shell shows this, it does not retry.
    Unavailable { reason: String },
}

/// Resolve one surface's frontend.
///
/// `id` is whatever the shell is holding in an app id's position, which is one
/// of two things: a first-party app id (`home`), or a plugin surface address
/// (`acme.specs`). Both arrive here because the switcher does not distinguish
/// them — see `plugins::split_address`.
pub fn resolve(app: &AppHandle, id: &str) -> Result<ToolFrontend> {
    // A first-party app resolves before anything is consulted, and cannot fail.
    // It ships in this binary rather than in a checkout, so none of the states
    // below can apply to one: there is nothing to install, nothing to build, and
    // no manifest of its own to be malformed. See `apps::entry_url`.
    if crate::apps::is_app(id) {
        return Ok(ToolFrontend::Mountable {
            url: crate::apps::entry_url(id),
        });
    }

    let Some((package_id, surface_id)) = plugins::split_address(id) else {
        return Ok(ToolFrontend::Unavailable {
            reason: format!("`{id}` names neither an app nor a plugin surface"),
        });
    };

    let registry = app.state::<plugins::Registry>();
    let Some(checkout) = registry.path_of(package_id) else {
        return Ok(ToolFrontend::Unavailable {
            reason: format!("`{package_id}` is not installed"),
        });
    };

    if !checkout.is_dir() {
        // A folder install whose working tree has moved or been deleted. Worded
        // for a person, and naming the path because the fix is to put it back or
        // install it again from wherever it went.
        return Ok(ToolFrontend::Unavailable {
            reason: format!("nothing at {}", checkout.display()),
        });
    }

    let manifest = match ToolManifest::load(&checkout) {
        Ok(m) => m,
        Err(err) => {
            return Ok(ToolFrontend::Unavailable {
                reason: format!("veistra-tool.toml: {err}"),
            })
        }
    };

    let Some(surface) = manifest.surface(surface_id) else {
        // Reachable without anything being broken: a saved layout holds a
        // surface the plugin has since dropped from its manifest. That is a
        // state to render, not an error to raise.
        return Ok(ToolFrontend::Unavailable {
            reason: format!("`{package_id}` no longer has a `{surface_id}` surface"),
        });
    };

    // Every surface in a package is a document in that package's one bundle, so
    // the surface contributes a path *within* the frontend rather than a
    // frontend of its own. See `FrontendSection` for why the bundle is declared
    // once per package.
    let within = surface
        .path
        .as_deref()
        .and_then(Path::to_str)
        .unwrap_or_default();

    // `cfg!(debug_assertions)` rather than a runtime flag: a release build must
    // not be able to point a tool frame at localhost, no matter what a manifest
    // in a checkout says.
    if cfg!(debug_assertions) {
        if let Some(dev_url) = manifest
            .frontend
            .as_ref()
            .and_then(|f| f.dev_url.as_deref())
        {
            return Ok(ToolFrontend::Mountable {
                url: join_url(dev_url, within),
            });
        }
    }

    let Some(dist) = manifest.resolve_dist(&checkout) else {
        return Ok(ToolFrontend::Unavailable {
            reason: format!("`{package_id}` declares no frontend to serve"),
        });
    };

    if !dist.join(within).join("index.html").is_file() {
        return Ok(ToolFrontend::Unavailable {
            reason: "the plugin's frontend has not been built".to_string(),
        });
    }

    Ok(ToolFrontend::Mountable {
        url: format!(
            "{SCHEME}://localhost/{package_id}/{}index.html",
            trailing_slashed(within)
        ),
    })
}

/// Append a bundle-relative path to a dev server's base URL.
///
/// Kept textual rather than reaching for a URL crate: both halves have already
/// been validated — `dev-url` by the author writing it and `path` by
/// `veistra-tool-manifest`'s relative-path check — and the only thing that can go
/// wrong is a doubled or missing slash between them.
fn join_url(base: &str, within: &str) -> String {
    if within.is_empty() {
        return base.to_string();
    }
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        trailing_slashed(within)
    )
}

/// `""` stays empty; anything else gets exactly one trailing slash.
///
/// A surface path names a *directory* inside the bundle, and the document served
/// from it is its `index.html`. Without the slash `specs` + `index.html` would
/// concatenate into `specsindex.html`.
fn trailing_slashed(within: &str) -> String {
    if within.is_empty() {
        return String::new();
    }
    format!("{}/", within.trim_end_matches('/').replace('\\', "/"))
}

/// Serve a file out of a plugin's built `dist` directory.
///
/// Registered on the builder in `lib.rs`. The path arrives as
/// `/<package-id>/<rest>`; the package id is looked up in the installed
/// registry, so a request can only ever reach a directory somebody actually
/// installed.
///
/// Note the id here is the **package**, not a surface address. Every surface in
/// a package is served out of that package's one bundle, and which surface a
/// request belongs to is already folded into `rest` by `resolve` above — so this
/// never has to know that surfaces exist.
pub fn serve(app: &AppHandle, path: &str) -> (u16, &'static str, Vec<u8>) {
    let trimmed = path.trim_start_matches('/');
    let Some((id, rest)) = trimmed.split_once('/') else {
        return (400, "text/plain", b"malformed plugin asset path".to_vec());
    };

    let Some(checkout) = app.state::<plugins::Registry>().path_of(id) else {
        return (404, "text/plain", b"unknown plugin".to_vec());
    };
    let Ok(manifest) = ToolManifest::load(&checkout) else {
        return (404, "text/plain", b"unreadable plugin manifest".to_vec());
    };

    let Some(dist) = manifest.resolve_dist(&checkout) else {
        return (404, "text/plain", b"plugin has no frontend".to_vec());
    };
    let Some(file) = safe_join(&dist, rest) else {
        // A `..` segment, an absolute path, or a symlink pointing out of the
        // checkout. Refusing rather than clamping: a request that tried to
        // leave the directory is not a request worth guessing the intent of.
        return (
            403,
            "text/plain",
            b"outside the tool's dist directory".to_vec(),
        );
    };

    match std::fs::read(&file) {
        Ok(bytes) => (200, mime_for(&file), bytes),
        Err(_) => (404, "text/plain", b"not found".to_vec()),
    }
}

/// Join `rest` onto `root` and prove the result is still inside it.
///
/// Canonicalising both sides is what makes this safe against `..` *and* against
/// symlinks — a purely textual check would pass a link inside `dist` that
/// points at the user's home directory.
fn safe_join(root: &Path, rest: &str) -> Option<PathBuf> {
    let candidate = root.join(rest);
    let root = root.canonicalize().ok()?;
    let candidate = candidate.canonicalize().ok()?;
    candidate.starts_with(&root).then_some(candidate)
}

/// Enough of a MIME table for a built web frontend. Anything unrecognised is
/// served as bytes rather than guessed at — a wrong `Content-Type` on a script
/// fails in a much more confusing way than a missing one.
fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}
