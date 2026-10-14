//! Which agent to run, and how to start it.
//!
//! A harness is resolved into a [`LaunchSpec`] — a program, its arguments and
//! its extra environment — and the session runs whatever spec it is handed.
//! That is also how the tests run `src/bin/mock-agent.rs`: as a spec, with no
//! harness of its own.
//!
//! Claude (handoff §5.2): the unmodified `claude` binary, signed in by the
//! user, driven through the ACP adapter `claude-agent-acp`, which the user
//! installs with npm. The adapter is told where the user's `claude` is through
//! `CLAUDE_CODE_EXECUTABLE`, so it never falls back to a copy of its own.
//! Nothing else is passed: no flag, no token, no settings file.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::event::Hint;

/// An agent the tab can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Harness {
    /// Claude, through `claude-agent-acp`.
    Claude,
}

/// The ACP adapter for Claude, as npm installs it on PATH.
pub const CLAUDE_ADAPTER: &str = "claude-agent-acp";

/// The adapter version this build was tested against. Recorded with the
/// `claude` version in `docs/agent-host-versions.md`; another version still
/// runs, with [`Hint::AdapterVersion`] on its status.
pub const CLAUDE_ADAPTER_VERSION: &str = "0.90.0";

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
}

/// The Claude spec, or the reason there is none. `path` and `pathext` are the
/// caller's `PATH` and `PATHEXT`, passed in so a test never reads the machine's.
pub fn claude_spec(path: Option<&OsStr>, pathext: Option<&OsStr>) -> Result<LaunchSpec, Hint> {
    let claude = which("claude", path, pathext).ok_or(Hint::ClaudeMissing)?;
    let adapter = which(CLAUDE_ADAPTER, path, pathext).ok_or(Hint::AdapterMissing)?;
    Ok(LaunchSpec {
        harness: Harness::Claude,
        program: adapter,
        args: Vec::new(),
        env: vec![(
            "CLAUDE_CODE_EXECUTABLE".to_string(),
            claude.to_string_lossy().into_owned(),
        )],
        expected_version: Some(CLAUDE_ADAPTER_VERSION),
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
        assert_eq!(claude_spec(path, ext), Err(Hint::ClaudeMissing));

        let claude = touch(dir.path(), &exe("claude"));
        assert_eq!(claude_spec(path, ext), Err(Hint::AdapterMissing));

        let adapter = touch(dir.path(), &exe(CLAUDE_ADAPTER));
        let spec = claude_spec(path, ext).unwrap();
        assert_eq!(spec.program, adapter);
        assert!(spec.args.is_empty(), "a .cmd shim must get no arguments");
        assert_eq!(
            spec.env,
            vec![(
                "CLAUDE_CODE_EXECUTABLE".to_string(),
                claude.to_string_lossy().into_owned()
            )]
        );
    }

    #[test]
    fn nothing_is_found_without_a_path() {
        assert_eq!(which("claude", None, None), None);
        assert_eq!(claude_spec(None, None), Err(Hint::ClaudeMissing));
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
