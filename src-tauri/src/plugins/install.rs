//! Turning a repository reference into an installed plugin.
//!
//! `remote.rs` is the pure half — GitHub, checksums, zips, no `AppHandle` — and
//! this is the half that knows about application state: where downloads land,
//! what the frontend is told while one is in flight, and where the token lives.
//! Splitting them is what lets the fiddly parsing and unpacking be tested
//! without a running app.

use super::remote::{self, RemoteError, Repo};
use super::{store, InstallError, Registry, ResolvedPlugin};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use veistra_tool_manifest::ToolManifest;

/// Progress for one install, emitted repeatedly at the same event name.
///
/// One event rather than a channel per install: there is more than one window,
/// and every one of them should be able to show what is happening without
/// having subscribed before it started.
pub const PROGRESS_EVENT: &str = "plugins:install-progress";

/// Where the OS credential store keeps the GitHub token.
///
/// The bundle identifier, written out by hand — `keyring` has no equivalent of
/// `app_config_dir()` to derive it. That copy is why `userdata::identity`
/// exists and why `scripts/check-identity.mjs` checks this line: a rename that
/// moved the config directory and left this behind would orphan the token
/// without orphaning anything else, which is the shape of failure nobody
/// notices until a private install asks for a credential that is still there
/// under a name nothing looks up any more.
pub const KEYRING_SERVICE: &str = "com.firelightinnovations.veistra";
const KEYRING_ACCOUNT: &str = "github-token";

/// How far along one install is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Asking GitHub which release is current.
    Resolving,
    Downloading,
    /// Checking the bytes against the published checksum.
    Verifying,
    Unpacking,
    Done,
    Failed,
}

/// One progress report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// What is being installed. The catalog id when there is one, else the
    /// repository slug — this is what the frontend keys a row on.
    pub key: String,
    /// A human-facing name, as good a one as is known at this point.
    pub name: String,
    pub phase: Phase,
    /// Bytes so far, and the total. `total` is 0 when the server sent no
    /// length, which the frontend renders as indeterminate rather than as 0%.
    pub received: u64,
    pub total: u64,
    /// Set only on `Failed`, and it is the sentence to show the person.
    pub error: Option<String>,
}

fn report(app: &AppHandle, progress: &Progress) {
    let _ = app.emit(PROGRESS_EVENT, progress);
}

/// The stored GitHub token, if there is one.
///
/// A missing token is the ordinary case, not an error: every public repository
/// installs without one. Failures reading the credential store are treated the
/// same way, deliberately — a locked or unavailable keychain should degrade to
/// "anonymous", which still works for everything public.
pub fn token() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .ok()?
        .get_password()
        .ok()
        .filter(|token| !token.trim().is_empty())
}

/// Store a GitHub token, or clear it when given an empty string.
pub fn set_token(value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())?;
    if value.trim().is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry.set_password(value.trim()).map_err(|e| e.to_string())
}

/// Whether a token is stored. Never returns the token itself — the frontend has
/// no use for the value and every reason not to hold it.
pub fn has_token() -> bool {
    token().is_some()
}

/// Move a token stored under a superseded identifier onto [`KEYRING_SERVICE`].
///
/// The credential-store half of `userdata::adopt`, and it has to be a read,
/// a write and a delete rather than a rename because `keyring::Entry` has no
/// rename. Called only from adoption, which has already established that this
/// build's own directory was unused.
///
/// **Refuses to overwrite a token that is already here**, which is the same
/// rule adoption follows for the files: a credential this build has been given
/// is newer than one an older name was left holding.
///
/// Quiet throughout. Every failure ends with the user re-entering a token they
/// entered once before, which is a smaller cost than a launch that stops to
/// report a locked keychain.
pub fn adopt_token(superseded: &str) -> bool {
    if superseded == KEYRING_SERVICE || has_token() {
        return false;
    }

    let Ok(old) = keyring::Entry::new(superseded, KEYRING_ACCOUNT) else {
        return false;
    };
    let Ok(secret) = old.get_password() else {
        return false;
    };

    if set_token(&secret).is_err() {
        return false;
    }
    let _ = old.delete_credential();
    true
}

/// Where downloaded plugins live: one directory per package id.
fn plugins_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("plugins"))
}

/// Install from a repository reference — a URL, or `owner/name`.
///
/// `expected_id` is set when the install came from the library, where the
/// catalog already claims which package this is. A release whose manifest
/// disagrees is refused rather than installed under the name it claims, since
/// the whole point of the catalog entry is that it names a known thing.
pub fn from_repo(
    app: &AppHandle,
    input: &str,
    expected_id: Option<&str>,
    private_hint: bool,
) -> Result<ResolvedPlugin, InstallError> {
    let key = expected_id.unwrap_or(input).to_string();
    let mut progress = Progress {
        key: key.clone(),
        name: key.clone(),
        phase: Phase::Resolving,
        received: 0,
        total: 0,
        error: None,
    };

    let result = run(app, input, expected_id, private_hint, &mut progress);

    match &result {
        Ok(resolved) => {
            progress.phase = Phase::Done;
            progress.name = resolved.name.clone();
            report(app, &progress);
        }
        Err(err) => {
            progress.phase = Phase::Failed;
            progress.error = Some(err.to_string());
            report(app, &progress);
        }
    }
    result
}

/// The install itself. Split out so `from_repo` can report the outcome of every
/// path through it in one place rather than at each `?`.
fn run(
    app: &AppHandle,
    input: &str,
    expected_id: Option<&str>,
    private_hint: bool,
    progress: &mut Progress,
) -> Result<ResolvedPlugin, InstallError> {
    let repo = Repo::parse(input).ok_or(RemoteError::BadRepo(input.to_string()))?;
    let token = token();

    report(app, progress);
    let release = remote::resolve(&repo, token.as_deref(), private_hint)?;

    progress.phase = Phase::Downloading;
    report(app, progress);

    // A local copy the closure can move into, since `progress` is borrowed for
    // the duration of the call and the callback needs to send too.
    let app_for_chunks = app.clone();
    let mut chunk_report = progress.clone();
    let bytes = remote::download(&release.asset_url, token.as_deref(), |received, total| {
        chunk_report.received = received;
        chunk_report.total = total;
        report(&app_for_chunks, &chunk_report);
    })?;

    let verified = match &release.checksum_url {
        Some(url) => {
            progress.phase = Phase::Verifying;
            report(app, progress);
            let sidecar = remote::download(url, token.as_deref(), |_, _| {})?;
            let published = remote::parse_checksum(&String::from_utf8_lossy(&sidecar))
                .ok_or_else(|| RemoteError::Unpack("the checksum file is unreadable".into()))?;
            let actual = remote::sha256_hex(&bytes);
            if actual != published {
                return Err(RemoteError::Checksum {
                    expected: published,
                    actual,
                }
                .into());
            }
            Some(actual)
        }
        None => None,
    };

    progress.phase = Phase::Unpacking;
    report(app, progress);

    let root = plugins_dir(app).ok_or_else(|| {
        RemoteError::Unpack("this machine has no application config directory".into())
    })?;
    // Unpack beside the destination rather than into it. A half-written install
    // that fails a manifest check should never be something the registry could
    // pick up, and a rename into place is the only step that is atomic enough
    // to make that true.
    let staging = root.join(format!(
        ".staging-{}",
        sanitize(&key_of(expected_id, &repo))
    ));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| RemoteError::Unpack(e.to_string()))?;

    let unpacked = (|| {
        remote::unpack(&bytes, &staging)?;
        remote::manifest_root(&staging).ok_or(RemoteError::NotAPlugin)
    })();
    let unpacked = match unpacked {
        Ok(path) => path,
        Err(err) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(err.into());
        }
    };

    let manifest = match ToolManifest::load(&unpacked) {
        Ok(manifest) => manifest,
        Err(err) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(InstallError::NotAPlugin(err));
        }
    };
    let id = manifest.tool.id.clone();

    if let Some(expected) = expected_id {
        if expected != id {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(RemoteError::IdMismatch {
                expected: expected.to_string(),
                found: id,
            }
            .into());
        }
    }
    if crate::apps::is_app(&id) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(InstallError::ShadowsAnApp { id });
    }

    // Reinstalling over an existing download is an upgrade, and is allowed —
    // unlike a folder install, where two records for one id would point at two
    // different working trees and the second would silently win.
    let registry = app.state::<Registry>();
    if let Some(existing) = registry.records().into_iter().find(|r| r.id == id) {
        if !existing.source.is_owned() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(InstallError::AlreadyInstalled {
                id,
                at: existing.source.path().clone(),
            });
        }
    }

    let destination = root.join(sanitize(&id));
    let _ = std::fs::remove_dir_all(&destination);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| RemoteError::Unpack(e.to_string()))?;
    }
    std::fs::rename(&unpacked, &destination).map_err(|e| RemoteError::Unpack(e.to_string()))?;
    let _ = std::fs::remove_dir_all(&staging);

    registry.insert(
        app,
        store::Record {
            id: id.clone(),
            source: store::Source::Release {
                path: destination,
                repo: repo.slug(),
                tag: release.tag,
                sha256: verified,
            },
            enabled: true,
        },
    );
    super::changed(app);

    super::resolve_all(&registry)
        .into_iter()
        .find(|(record, _)| record.id == id)
        .and_then(|(_, resolved)| resolved.ok())
        // Unreachable in practice: the record was inserted a line ago and its
        // manifest parsed a few lines before that. Answered rather than
        // unwrapped anyway, per STANDARDS §5.
        .ok_or(InstallError::Remote(RemoteError::NotAPlugin))
}

/// Install the catalog's `default` apps, once, on a machine that has never had
/// a plugin store.
///
/// Runs on its own thread and returns immediately: this is called from setup,
/// and a first launch must not wait on the network to show a window. Every
/// window learns what happened the same way it learns about any other install —
/// `PROGRESS_EVENT` while each one runs, `CHANGED_EVENT` when the set moves.
///
/// **Every failure here is quiet.** A first run may have no network at all, or
/// may be a build whose catalog names a repository that has not published a
/// release yet, and neither is the user's problem. The app stays listed in the
/// library as something they can install by hand, which is the same place a
/// successful skip would leave them. Greeting somebody with two red failures
/// because they opened Veistra on a plane is a worse first impression than
/// starting with fewer apps.
pub fn seed_defaults(app: &AppHandle) {
    if store::exists(app) {
        return;
    }
    let wanted: Vec<(String, String, bool)> = super::catalog::entries()
        .iter()
        .filter(|entry| entry.default)
        .map(|entry| (entry.id.clone(), entry.repo.clone(), entry.private))
        .collect();
    if wanted.is_empty() {
        return;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        for (id, repo, private) in wanted {
            // Sequential rather than concurrent. Two downloads racing would
            // interleave their progress on one event stream, and the first run
            // is the moment least worth being clever on.
            match from_repo(&handle, &repo, Some(&id), private) {
                Ok(resolved) => {
                    println!(
                        "veistra: installed {} {} by default",
                        resolved.id, resolved.version
                    )
                }
                Err(err) => eprintln!("veistra: skipped the default app `{id}`: {err}"),
            }
        }
    });
}

fn key_of(expected_id: Option<&str>, repo: &Repo) -> String {
    expected_id
        .map(str::to_string)
        .unwrap_or_else(|| repo.slug())
}

/// Make a string safe to be one path segment.
///
/// A package id already matches `^[a-z][a-z0-9-]*$`, so this changes nothing for
/// a valid one. It is here for the staging directory, whose name can come from a
/// repository slug the person typed.
fn sanitize(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_leaves_a_valid_package_id_alone() {
        assert_eq!(sanitize("acme"), "acme");
        assert_eq!(sanitize("veistra-acme"), "veistra-acme");
    }

    #[test]
    fn sanitize_flattens_a_slug_into_one_segment() {
        assert_eq!(
            sanitize("Firelight-Innovations/Veistra-Acme"),
            "Firelight-Innovations-Veistra-Acme"
        );
        assert!(!sanitize("../../etc").contains('.'));
        assert!(!sanitize("a/b").contains('/'));
        assert!(!sanitize("a\\b").contains('\\'));
    }

    #[test]
    fn a_key_prefers_the_catalog_id_over_the_slug() {
        let repo = Repo::parse("owner/name").expect("parses");
        assert_eq!(key_of(Some("acme"), &repo), "acme");
        assert_eq!(key_of(None, &repo), "owner/name");
    }

    #[test]
    fn phase_serializes_as_the_frontend_reads_it() {
        let json = serde_json::to_string(&Phase::Downloading).expect("serializes");
        assert_eq!(json, "\"downloading\"");
    }
}
