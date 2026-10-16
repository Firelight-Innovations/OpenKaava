//! Which agent to run, and how to start it.
//!
//! Every harness Kaava can run is a [`Descriptor`] in [`REGISTRY`]: its name,
//! the program the user installs and signs in to, and the ACP adapter that
//! drives it. The host reads the registry, and the tab reads it through
//! `agent-tab/harnesses`, so a new harness needs no change to the host. How to
//! add one: `docs/agent-harnesses.md`.
//!
//! A descriptor is resolved into a [`LaunchSpec`] — a program, its arguments
//! and its extra environment — and the session runs whatever spec it is
//! handed. That is also how the tests run `src/bin/mock-agent.rs`: as a spec,
//! with no harness of its own.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::event::{HarnessInfo, Hint};

mod claude;

pub use claude::CLAUDE;

/// An agent the tab can run. Each has one [`Descriptor`] in [`REGISTRY`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Harness {
    /// Claude, through `claude-agent-acp`.
    Claude,
}

impl Harness {
    /// Its descriptor.
    pub fn descriptor(self) -> &'static Descriptor {
        match self {
            Harness::Claude => &CLAUDE,
        }
    }
}

/// The variable that stops `cmd.exe` and the Windows loader from searching the
/// current directory for a bare command name.
pub const NO_CWD_SEARCH: &str = "NoDefaultCurrentDirectoryInExePath";

/// Every harness, in the order the tab lists them.
pub static REGISTRY: &[&Descriptor] = &[&CLAUDE];

/// One harness: what the UI calls it, how to find and start it, and how the
/// user sets it up. Kaava runs the user's own binary, signed in by the user.
#[derive(Debug, PartialEq, Eq)]
pub struct Descriptor {
    /// Which harness this describes.
    pub harness: Harness,
    /// Its name in the UI: "Claude", "Codex", "Pi" (handoff §0).
    pub name: &'static str,
    /// The program the user installs and signs in to, as found on PATH.
    pub cli: &'static str,
    /// The variable that tells the adapter where `cli` is, so it never runs
    /// a copy of its own.
    pub cli_env: &'static str,
    /// The ACP adapter Kaava spawns.
    pub adapter: AcpAdapter,
    /// What the user runs in a terminal to sign in. Kaava never runs it.
    pub sign_in: &'static str,
    /// More variables for the adapter's environment. Never a credential.
    pub env: &'static [(&'static str, &'static str)],
    /// What Kaava holds every session of it to.
    pub policy: Policy,
    /// How the host talks to it, which picks the [`crate::Adapter`] that runs it.
    pub protocol: Protocol,
    /// What the tab may offer for it.
    pub capabilities: Capabilities,
}

impl Descriptor {
    /// What `agent-tab/harnesses` answers for it, with `hint` saying what
    /// stands in its way.
    pub fn info(&self, hint: Option<Hint>) -> HarnessInfo {
        HarnessInfo {
            harness: self.harness,
            name: self.name.to_string(),
            hint,
            setup: Setup {
                cli: self.cli.to_string(),
                sign_in: self.sign_in.to_string(),
                adapter_install: self.adapter.install(),
                adapter_version: self.adapter.version.to_string(),
            },
            capabilities: self.capabilities,
        }
    }
}

/// The commands that set a harness up, for the tab's hint sentences to name.
/// The user runs each in a terminal; Kaava never does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// The harness's own program.
    pub cli: String,
    /// The command that signs in.
    pub sign_in: String,
    /// The command that installs the tested adapter.
    pub adapter_install: String,
    /// The adapter version this build was tested with.
    pub adapter_version: String,
}

/// The wire protocol between the host and a harness's process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// The Agent Client Protocol on stdio (design AGT-002), run by `Session`.
    /// A harness without it gets a translating adapter and a variant here.
    Acp,
}

/// What a harness can do beyond the basics, so the tab can hide what is `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Add to a running turn without stopping it.
    pub steer: bool,
    /// Branch a thread.
    pub fork: bool,
    /// Switch between the agent's modes.
    pub modes: bool,
}

/// What Kaava holds a harness's sessions to, whatever the user's own settings
/// for that harness would choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// The mode id every session is put in before its first prompt: the one
    /// that asks before acting. A session that will not switch to it does not
    /// run.
    pub ask_first: &'static str,
}

/// An ACP adapter, as npm installs it on PATH.
#[derive(Debug, PartialEq, Eq)]
pub struct AcpAdapter {
    /// Its program on PATH.
    pub program: &'static str,
    /// Its npm package.
    pub package: &'static str,
    /// The version this build was tested against, recorded in
    /// `docs/agent-host-versions.md`. Another version still runs, with
    /// [`Hint::AdapterVersion`] on its status.
    pub version: &'static str,
}

impl AcpAdapter {
    /// The command that installs the tested version. `--omit=optional` skips
    /// any copy of the harness bundled with it: Kaava runs the user's own.
    pub fn install(&self) -> String {
        format!("npm i -g --omit=optional {}@{}", self.package, self.version)
    }
}

/// How long an agent may take to answer a setting change. A model switch is
/// a round trip to the harness's CLI, so this is not short.
const SETTING_TIMEOUT: Duration = Duration::from_secs(30);

/// How to start one agent process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    /// Which harness this is, for the status line.
    pub harness: Harness,
    /// The program, as a full path. Never resolved again at spawn.
    pub program: PathBuf,
    /// Its arguments. Empty for every real harness: a Windows `.cmd` shim
    /// goes through `cmd.exe`, and with no arguments there is nothing for its
    /// quoting rules to get wrong.
    pub args: Vec<String>,
    /// Variables added to the inherited environment.
    pub env: Vec<(String, String)>,
    /// The adapter version this build expects, if it checks one.
    pub expected_version: Option<&'static str>,
    /// What the session is held to.
    pub policy: Policy,
    /// How long the agent may take to answer a setting change before the tab
    /// is told it has not. The change keeps its place in the queue either way.
    pub setting_timeout: Duration,
}

/// The spec for `harness`, or the reason there is none. `path` and `pathext`
/// are the caller's `PATH` and `PATHEXT`, passed in so a test never reads the
/// machine's.
pub fn spec(
    harness: Harness,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Result<LaunchSpec, Hint> {
    let descriptor = harness.descriptor();
    let cli = which(descriptor.cli, path, pathext).ok_or(Hint::HarnessMissing)?;
    let adapter = which(descriptor.adapter.program, path, pathext).ok_or(Hint::AdapterMissing)?;
    let mut env = vec![
        (
            descriptor.cli_env.to_string(),
            cli.to_string_lossy().into_owned(),
        ),
        // The adapter runs in the user's worktree, which is untrusted
        // repository content. An npm shim ends in a bare `node`, and
        // `cmd.exe` looks in the current directory before PATH for a bare
        // name unless this is set, so a `node.cmd` at a repository's root
        // would run the moment the user pressed Send, before any permission
        // request could stop it. Every harness's adapter is an npm shim.
        (NO_CWD_SEARCH.to_string(), "1".to_string()),
    ];
    env.extend(
        descriptor
            .env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string())),
    );
    Ok(LaunchSpec {
        harness,
        program: adapter,
        args: Vec::new(),
        env,
        expected_version: Some(descriptor.adapter.version),
        policy: descriptor.policy,
        setting_timeout: SETTING_TIMEOUT,
    })
}

/// The first file named `name` on `path`, trying each `pathext` extension on
/// Windows (`.COM;.EXE;.BAT;.CMD` when unset) and the bare name elsewhere.
pub fn which(name: &str, path: Option<&OsStr>, pathext: Option<&OsStr>) -> Option<PathBuf> {
    let path = path?;
    let extensions = extensions(pathext);
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| {
            extensions
                .iter()
                .map(|ext| candidate(&dir, name, ext))
                .find(|file| file.is_file())
        })
}

fn candidate(dir: &Path, name: &str, ext: &OsStr) -> PathBuf {
    let mut file = OsString::from(name);
    file.push(ext);
    dir.join(file)
}

fn extensions(pathext: Option<&OsStr>) -> Vec<OsString> {
    if !cfg!(windows) {
        return vec![OsString::new()];
    }
    let list = pathext
        .and_then(OsStr::to_str)
        .unwrap_or(".COM;.EXE;.BAT;.CMD");
    list.split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| OsString::from(ext.to_ascii_lowercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, file: &str) -> PathBuf {
        let path = dir.join(file);
        std::fs::write(&path, b"").unwrap();
        path
    }

    fn exe(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.cmd")
        } else {
            name.to_string()
        }
    }

    #[test]
    fn claude_needs_both_the_binary_and_the_adapter() {
        let dir = tempfile::tempdir().unwrap();
        let path = Some(dir.path().as_os_str());
        let ext = Some(OsStr::new(".EXE;.CMD"));
        assert_eq!(spec(Harness::Claude, path, ext), Err(Hint::HarnessMissing));

        let claude = touch(dir.path(), &exe("claude"));
        assert_eq!(spec(Harness::Claude, path, ext), Err(Hint::AdapterMissing));

        let adapter = touch(dir.path(), &exe("claude-agent-acp"));
        let spec = spec(Harness::Claude, path, ext).unwrap();
        assert_eq!(spec.program, adapter);
        assert!(spec.args.is_empty(), "a .cmd shim must get no arguments");
        assert_eq!(
            spec.env,
            vec![
                (
                    "CLAUDE_CODE_EXECUTABLE".to_string(),
                    claude.to_string_lossy().into_owned()
                ),
                (
                    "NoDefaultCurrentDirectoryInExePath".to_string(),
                    "1".to_string()
                ),
            ],
            "the worktree is never searched for the `node` a shim runs"
        );
        assert_eq!(spec.expected_version, Some("0.90.0"));
        assert_eq!(spec.policy.ask_first, "default");
    }

    #[test]
    fn every_harness_has_one_descriptor_that_names_it() {
        for descriptor in REGISTRY {
            assert_eq!(descriptor.harness.descriptor(), *descriptor);
            let same = REGISTRY.iter().filter(|d| d.harness == descriptor.harness);
            assert_eq!(
                same.count(),
                1,
                "{:?} is registered twice",
                descriptor.harness
            );
        }
    }

    /// Every variant of [`Harness`], read off the type itself rather than a
    /// list kept by hand. ts-rs writes a unit enum as a union of its serde
    /// names, and serde reads each name back.
    fn every_variant() -> Vec<Harness> {
        <Harness as ts_rs::TS>::inline(&ts_rs::Config::new())
            .split('|')
            .map(|name| serde_json::from_str(name.trim()).unwrap())
            .collect()
    }

    #[test]
    fn every_variant_has_a_row_in_the_registry() {
        let variants = every_variant();
        assert!(variants.contains(&Harness::Claude), "{variants:?}");
        for harness in variants {
            assert!(
                REGISTRY.iter().any(|d| d.harness == harness),
                "{harness:?} has a descriptor but no row in REGISTRY"
            );
        }
    }

    #[test]
    fn a_name_is_the_short_one() {
        for d in REGISTRY {
            assert!(!d.name.contains(' '), "handoff §0: {} is too long", d.name);
        }
    }

    #[test]
    fn info_carries_what_the_hint_sentences_name() {
        let info = CLAUDE.info(Some(Hint::SignedOut));
        assert_eq!(info.harness, Harness::Claude);
        assert_eq!(info.name, "Claude");
        assert_eq!(info.hint, Some(Hint::SignedOut));
        assert_eq!(info.setup.cli, "claude");
        assert_eq!(info.setup.sign_in, "claude");
        assert_eq!(info.setup.adapter_install, CLAUDE.adapter.install());
        assert_eq!(info.setup.adapter_version, "0.90.0");
        assert_eq!(info.capabilities, CLAUDE.capabilities);
    }

    #[test]
    fn the_adapter_installs_pinned_without_its_bundled_harness() {
        assert_eq!(
            CLAUDE.adapter.install(),
            "npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.90.0"
        );
    }

    #[test]
    fn nothing_is_found_without_a_path() {
        assert_eq!(which("claude", None, None), None);
        assert_eq!(spec(Harness::Claude, None, None), Err(Hint::HarnessMissing));
    }

    #[test]
    fn the_first_directory_on_the_path_wins() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let want = touch(first.path(), &exe("claude"));
        touch(second.path(), &exe("claude"));
        let path = std::env::join_paths([first.path(), second.path()]).unwrap();
        assert_eq!(
            which("claude", Some(&path), Some(OsStr::new(".CMD"))),
            Some(want)
        );
    }
}
