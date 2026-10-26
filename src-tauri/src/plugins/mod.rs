//! Installed plugins: what is on this machine, and what each one can show.
//!
//! A **plugin** is a checkout carrying a `veistra-tool.toml`. One of them is a
//! *package* holding zero or more *surfaces*, and a surface is the thing that
//! reaches the switcher bar — `crates/veistra-tool-manifest` is the format and
//! `docs/tool-protocol.md` §1 is the spec.
//!
//! Deliberately not `discovery.rs`, and the manifest behind a record is re-read
//! rather than cached — which is what the reload loop is built on.
//! `docs/design-notes/backend-plugins.md` has the argument for both.

pub mod broker;
pub mod catalog;
pub mod install;
pub mod remote;
pub mod store;
pub mod watch;

pub use broker::Broker;
pub use watch::Watchers;

use crate::sync::MutexExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use veistra_tool_manifest::{ManifestError, Presentation, ToolManifest};
// `Manager` is the trait that puts `.state()` on `AppHandle`, and `Emitter` the
// one that puts `.emit()` there. Rust only exposes a trait's methods where the
// trait is in scope, which is why both names are imported and neither appears
// spelled out below.
use tauri::{AppHandle, Emitter, Manager};

pub use store::{Record, Source};

/// Emitted whenever the installed set changes: an install, an uninstall, an
/// enable/disable, or a reload.
///
/// The switcher and the Apps menu are built from `apps::openables`, which reads
/// the installed manifests off disk — so they need telling when to ask again.
/// A push rather than a poll for the ordinary reason, and a *bare* event rather
/// than one carrying the new list because there is more than one window: giving
/// each of them a payload assembled once would mean deciding whose registry
/// state it described.
pub const CHANGED_EVENT: &str = "plugins:changed";

/// The separator between a package id and a surface id in a surface address.
///
/// A character neither id can contain — both match `^[a-z][a-z0-9-]*$` — which
/// is what makes `split_once` on it exact rather than a guess, and what keeps a
/// plugin surface from ever colliding with a first-party app id like `home`.
/// Asked for by Home's *Install App* button, listened for by the shell.
///
/// An app cannot reach the shell's React tree — it is an iframe on another
/// origin — so "show me the library" travels the only way it can: the app calls
/// its own Rust half, which emits this, and `App.tsx` opens the screen. The
/// same shape `veistra/open` uses, and for the same reason.
pub const LIBRARY_OPEN_EVENT: &str = "library:open";

pub const ADDRESS_SEPARATOR: char = '.';

/// One installed package, resolved against its checkout right now.
///
/// Everything past `id` and `path` comes from the manifest on disk, so this is a
/// snapshot rather than a record — ask again after a rebuild and the answer may
/// differ. That is intended; see the module doc.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPlugin {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub path: PathBuf,
    pub enabled: bool,
    /// The surfaces this package offers, addresses already built.
    pub surfaces: Vec<ResolvedSurface>,
    /// Whether the package declares a core. The shell shows a backend-only
    /// plugin differently from a broken one, and without this the two look the
    /// same: no surfaces either way.
    pub has_core: bool,
}

/// One surface of one installed package, as the shell needs to see it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSurface {
    /// `<package>.<surface>` — the id the shell uses everywhere an app id goes.
    pub address: String,
    pub name: String,
    pub description: String,
    /// Whether this surface is offered in the menus.
    pub listed: bool,
}

/// Why a checkout could not be made into a plugin.
#[derive(Debug)]
pub enum ResolveError {
    /// The directory is gone, or was never there. Usual cause: a folder install
    /// pointing at a working tree that has since moved.
    Missing(PathBuf),
    /// There is a directory, but its manifest does not load.
    Manifest(ManifestError),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(path) => write!(f, "nothing at {}", path.display()),
            Self::Manifest(err) => write!(f, "veistra-tool.toml: {err}"),
        }
    }
}

/// Build the address the shell knows a surface by.
pub fn address(package_id: &str, surface_id: &str) -> String {
    format!("{package_id}{ADDRESS_SEPARATOR}{surface_id}")
}

/// Split an address back into its halves, or `None` if it is not one.
///
/// Total rather than panicking, because the input is an app id that arrived from
/// the frontend or out of a saved layout — a first-party `home` is a perfectly
/// ordinary thing to pass here and simply is not a surface address.
pub fn split_address(address: &str) -> Option<(&str, &str)> {
    address.split_once(ADDRESS_SEPARATOR)
}

/// The installed set. Managed state, registered in `lib.rs`.
///
/// A `Vec` behind a `Mutex` rather than a `RwLock` over a map: the list is short,
/// read on menu draws rather than in a hot loop, and install order is the order
/// the switcher offers plugins in — which a map would lose.
///
/// **No method here returns a guard**, the same invariant `mcp::Registry` and
/// `settings::Registry` hold. Every one takes the lock, copies what it needs and
/// drops it, so no caller can hold this across an `.await` or a call into a
/// plugin's core.
#[derive(Default)]
pub struct Registry {
    records: Mutex<Vec<Record>>,
}

impl Registry {
    /// Load the saved records into memory. Called once, during setup.
    pub fn hydrate(&self, app: &AppHandle) {
        *self.records.lock_or_panic() = store::load(app).plugins;
    }

    /// Every record, in install order. The raw list — nothing is read off disk.
    pub fn records(&self) -> Vec<Record> {
        self.records.lock_or_panic().clone()
    }

    /// Whether a package id is installed, enabled or not.
    pub fn contains(&self, id: &str) -> bool {
        self.records.lock_or_panic().iter().any(|r| r.id == id)
    }

    /// Where a package's checkout is, if it is installed.
    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        self.records
            .lock_or_panic()
            .iter()
            .find(|r| r.id == id)
            .map(|r| r.source.path().clone())
    }

    /// Add a record and persist. The caller has already validated the checkout.
    ///
    /// Replaces an existing record with the same id rather than shadowing it,
    /// for the reason `mcp::Registry::register` gives: two entries answering to
    /// one name leave every lookup silently picking whichever came first.
    pub fn insert(&self, app: &AppHandle, record: Record) {
        {
            let mut records = self.records.lock_or_panic();
            match records.iter().position(|r| r.id == record.id) {
                Some(at) => records[at] = record,
                None => records.push(record),
            }
        }
        self.persist(app);
    }

    /// Forget a package. `true` if there was one to forget.
    ///
    /// The record only — a folder install points at a directory the person
    /// already had, and this application does not delete what it did not create.
    /// See [`Source`].
    pub fn remove(&self, app: &AppHandle, id: &str) -> bool {
        let removed = {
            let mut records = self.records.lock_or_panic();
            match records.iter().position(|r| r.id == id) {
                Some(at) => {
                    records.remove(at);
                    true
                }
                None => false,
            }
        };
        if removed {
            self.persist(app);
        }
        removed
    }

    /// Turn a package's surfaces on or off. `true` if there was one to change.
    pub fn set_enabled(&self, app: &AppHandle, id: &str, enabled: bool) -> bool {
        let changed = {
            let mut records = self.records.lock_or_panic();
            match records.iter_mut().find(|r| r.id == id) {
                Some(record) => {
                    record.enabled = enabled;
                    true
                }
                None => false,
            }
        };
        if changed {
            self.persist(app);
        }
        changed
    }

    fn persist(&self, app: &AppHandle) {
        let plugins = self.records.lock_or_panic().clone();
        store::save(app, &store::Stored { plugins });
    }
}

/// Resolve every installed package against the disk, dropping the ones that no
/// longer load.
///
/// A plugin whose checkout has moved or whose manifest has broken is **skipped
/// rather than reported** here, because this feeds the switcher and the Apps
/// menu — surfaces that cannot be mounted must not be offered. The install list
/// wants the failures instead, and gets them from [`resolve_all`].
pub fn resolve_enabled(registry: &Registry) -> Vec<ResolvedPlugin> {
    resolve_all(registry)
        .into_iter()
        .filter_map(|(_, result)| result.ok())
        .filter(|plugin| plugin.enabled)
        .collect()
}

/// Resolve every installed package, keeping the failures.
///
/// Paired with the record so a caller can name the plugin that failed — a
/// [`ResolveError`] on its own cannot say which install it came from, and
/// "veistra-tool.toml: missing field `id`" with no plugin attached is a message
/// nobody can act on.
pub fn resolve_all(registry: &Registry) -> Vec<(Record, Result<ResolvedPlugin, ResolveError>)> {
    registry
        .records()
        .into_iter()
        .map(|record| {
            let resolved = resolve_one(&record, record.source.path());
            (record, resolved)
        })
        .collect()
}

fn resolve_one(record: &Record, path: &Path) -> Result<ResolvedPlugin, ResolveError> {
    if !path.is_dir() {
        return Err(ResolveError::Missing(path.to_path_buf()));
    }

    let manifest = ToolManifest::load(path).map_err(ResolveError::Manifest)?;

    // The manifest's own id has to be the one we filed it under. They can only
    // disagree if the checkout changed identity since it was installed, and
    // continuing would mean surfaces addressed under a package id that no
    // uninstall can name.
    if manifest.tool.id != record.id {
        return Err(ResolveError::Manifest(ManifestError::InvalidId {
            id: manifest.tool.id,
        }));
    }

    Ok(ResolvedPlugin {
        surfaces: manifest
            .surfaces
            .iter()
            .map(|surface| ResolvedSurface {
                address: address(&manifest.tool.id, &surface.id),
                name: surface.name.clone().unwrap_or_else(|| surface.id.clone()),
                description: surface.description.clone(),
                listed: matches!(surface.present, Presentation::Pane),
            })
            .collect(),
        name: manifest
            .tool
            .name
            .clone()
            .unwrap_or_else(|| manifest.tool.id.clone()),
        description: manifest.tool.description.clone(),
        version: manifest.tool.version.to_string(),
        id: manifest.tool.id,
        path: path.to_path_buf(),
        enabled: record.enabled,
        has_core: manifest.core.is_some(),
    })
}

/// One row in the plugin management screen: a record, and either what its
/// manifest says or why it could not be read.
///
/// A flat struct with an `error` rather than a tagged union, because every row
/// draws the same way whichever it is — the id and the path come from the record
/// and are known even for a plugin that will not load, and those two are exactly
/// what a person needs to find the broken one. A union would make the id
/// unreachable in the arm that most needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRow {
    pub id: String,
    pub path: PathBuf,
    pub enabled: bool,
    /// What resolved, or `None` when `error` says why not.
    pub resolved: Option<ResolvedPlugin>,
    /// Why this plugin did not load. `None` when it did.
    pub error: Option<String>,
    /// Whether its core is running right now.
    pub running: bool,
}

impl PluginRow {
    /// The row for a plugin that resolved.
    pub fn installed(resolved: ResolvedPlugin, app: &AppHandle) -> Self {
        Self {
            id: resolved.id.clone(),
            path: resolved.path.clone(),
            enabled: resolved.enabled,
            running: app.state::<Broker>().is_running(&resolved.id),
            resolved: Some(resolved),
            error: None,
        }
    }
}

/// Every installed plugin, failures kept. What the management screen draws.
pub fn rows(app: &AppHandle) -> Vec<PluginRow> {
    resolve_all(&app.state::<Registry>())
        .into_iter()
        .map(|(record, result)| {
            let path = record.source.path();
            match result {
                Ok(resolved) => PluginRow::installed(resolved, app),
                Err(err) => PluginRow {
                    id: record.id.clone(),
                    path: path.clone(),
                    enabled: record.enabled,
                    resolved: None,
                    error: Some(err.to_string()),
                    // A plugin that will not resolve cannot have been started,
                    // because the broker resolves the same manifest to spawn it.
                    running: false,
                },
            }
        })
        .collect()
}

/// Turn a plugin's surfaces on or off without forgetting it.
///
/// Disabling stops the core too. A backend left running for a plugin whose
/// surfaces are all hidden is a process nothing can reach and nothing will close
/// until the application exits.
pub fn set_enabled(app: &AppHandle, id: &str, enabled: bool) -> bool {
    let did_change = app.state::<Registry>().set_enabled(app, id, enabled);
    if did_change {
        if !enabled {
            app.state::<Broker>().stop(id);
        }
        changed(app);
    }
    did_change
}

/// Why an install was refused.
///
/// Every variant names something the person can go and fix, because this is
/// shown in the dialog they just used rather than logged. A directory that is
/// simply not a plugin is the common case and is worded as a statement about the
/// folder rather than as an error about them.
#[derive(Debug)]
pub enum InstallError {
    /// No `veistra-tool.toml`, or one that does not parse.
    NotAPlugin(ManifestError),
    /// A package with this id is already installed, from somewhere else.
    AlreadyInstalled { id: String, at: PathBuf },
    /// The id collides with a surface this build ships. `home` and `files` are
    /// resolved before the registry is consulted, so a plugin claiming one would
    /// be permanently unreachable rather than merely confusing.
    ShadowsAnApp { id: String },
    /// Something went wrong between here and GitHub. Its own type because every
    /// variant of it is a sentence a person can act on, and flattening them into
    /// this enum would lose that.
    Remote(remote::RemoteError),
}

impl From<remote::RemoteError> for InstallError {
    fn from(err: remote::RemoteError) -> Self {
        Self::Remote(err)
    }
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAPlugin(err) => {
                write!(f, "this folder is not a plugin — veistra-tool.toml: {err}")
            }
            Self::AlreadyInstalled { id, at } => write!(
                f,
                "`{id}` is already installed from {}; remove that one first",
                at.display()
            ),
            Self::ShadowsAnApp { id } => write!(
                f,
                "`{id}` is the id of an app this build ships, so a plugin cannot use it"
            ),
            Self::Remote(err) => write!(f, "{err}"),
        }
    }
}

/// Install a checkout already on this machine — the development path.
///
/// Validates before it records, so the registry never holds something that could
/// not be resolved a moment later. What it deliberately does *not* check is
/// whether the plugin is **built**: an unbuilt checkout is the normal state
/// while writing one, and refusing it would mean installing your own plugin only
/// after the first successful `cargo build`. `tool_frontend` and the broker each
/// report that when it matters.
pub fn install_folder(app: &AppHandle, path: &Path) -> Result<ResolvedPlugin, InstallError> {
    let manifest = ToolManifest::load(path).map_err(InstallError::NotAPlugin)?;
    let id = manifest.tool.id.clone();

    if crate::apps::is_app(&id) {
        return Err(InstallError::ShadowsAnApp { id });
    }

    let registry = app.state::<Registry>();
    if let Some(at) = registry.path_of(&id) {
        if at != path {
            return Err(InstallError::AlreadyInstalled { id, at });
        }
    }

    let record = Record {
        id: id.clone(),
        source: Source::Folder {
            path: path.to_path_buf(),
        },
        enabled: true,
    };
    registry.insert(app, record.clone());

    // Re-installing over the same id may point at a different build; a core
    // still running from the old one would answer for it. Stopping is enough —
    // the broker spawns lazily, so the next call starts whatever is there now.
    app.state::<Broker>().stop(&id);
    changed(app);

    resolve_one(&record, path)
        .map_err(|_| InstallError::NotAPlugin(ManifestError::InvalidId { id }))
}

/// Forget a package, stopping its core first.
pub fn uninstall(app: &AppHandle, id: &str) -> bool {
    // Before the record goes, because the broker resolves a checkout through the
    // registry — stopping afterwards would have nothing to look up and would
    // leave the process running until exit.
    app.state::<Broker>().stop(id);

    // Read the source before the record goes, because whether the directory is
    // ours to delete is recorded *on* the record. A folder install points at a
    // working tree the person already had and must survive; a downloaded
    // release was put there by this application and would otherwise be left
    // behind with nothing referring to it.
    let owned = app
        .state::<Registry>()
        .records()
        .into_iter()
        .find(|record| record.id == id)
        .filter(|record| record.source.is_owned())
        .map(|record| record.source.path().clone());

    let removed = app.state::<Registry>().remove(app, id);
    if removed {
        if let Some(directory) = owned {
            if let Err(e) = std::fs::remove_dir_all(&directory) {
                // Not fatal, and deliberately not a failed uninstall: the
                // record is gone, which is what was asked for. A directory left
                // behind is untidy, not broken.
                eprintln!("veistra: could not delete {}: {e}", directory.display());
            }
        }
        changed(app);
    }
    removed
}

/// Re-read a plugin from disk: stop its core, and tell every window to re-ask.
///
/// The whole reload story for a plugin under development, and it is this small
/// because nothing anywhere caches a manifest. The frontend half needs no help
/// at all — a surface pointed at the plugin's own dev server has Vite's hot
/// reload running inside the real shell already.
pub fn reload(app: &AppHandle, id: &str) -> bool {
    if !app.state::<Registry>().contains(id) {
        return false;
    }
    app.state::<Broker>().stop(id);
    changed(app);
    true
}

/// Everything that has to happen after the installed set moves.
///
/// One function rather than two calls at each of the four mutation sites,
/// because those two would drift: `watch::Watchers::sync`'s own doc says three
/// callers each maintaining half a watch set is how a watcher gets left running
/// on a plugin nobody has any more, and the same argument applies to forgetting
/// the event.
///
/// Safe to reach from a watcher thread — which it does, by way of [`reload`].
/// `sync` is idempotent and takes its lock fresh; the debounce loop holds
/// nothing while it calls out.
fn changed(app: &AppHandle) {
    app.state::<Watchers>().sync(app);

    if let Err(e) = app.emit(CHANGED_EVENT, ()) {
        eprintln!("veistra: could not announce the plugin change: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_the_two_ids_joined() {
        assert_eq!(address("acme", "specs"), "acme.specs");
    }

    #[test]
    fn an_address_splits_back_into_its_halves() {
        assert_eq!(split_address("acme.specs"), Some(("acme", "specs")));
    }

    /// A first-party app id is not an address, and asking must not panic —
    /// `home` and `files` are passed through the same lookups as a plugin
    /// surface.
    #[test]
    fn a_bare_app_id_is_not_an_address() {
        assert_eq!(split_address("home"), None);
        assert_eq!(split_address("files"), None);
    }

    /// The separator cannot appear in either half, so a package called
    /// `a` with a surface `b.c` is unrepresentable — which is why
    /// `veistra-tool-manifest` validates both ids and this only has to split once.
    #[test]
    fn the_separator_is_outside_the_id_alphabet() {
        assert!(!ADDRESS_SEPARATOR.is_ascii_lowercase());
        assert!(!ADDRESS_SEPARATOR.is_ascii_digit());
        assert_ne!(ADDRESS_SEPARATOR, '-');
    }

    #[test]
    fn a_missing_checkout_resolves_to_missing_rather_than_a_manifest_error() {
        let record = Record {
            id: "ghost".to_string(),
            source: Source::Folder {
                path: PathBuf::from("C:/definitely/not/here"),
            },
            enabled: true,
        };

        match resolve_one(&record, Path::new("C:/definitely/not/here")) {
            Err(ResolveError::Missing(path)) => {
                assert_eq!(path, PathBuf::from("C:/definitely/not/here"));
            }
            other => panic!("expected Missing, got {other:?}"),
        }
    }
}
