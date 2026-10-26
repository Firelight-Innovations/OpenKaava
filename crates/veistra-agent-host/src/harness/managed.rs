//! Adapters installed alongside this development checkout, never in the project an agent edits.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use super::{which, Descriptor, Harness};

/// Prefer the user's PATH; the local Codex install is an explicit, pinned fallback.
pub(super) fn adapter(
    descriptor: &Descriptor,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Option<PathBuf> {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    resolve(descriptor, path, pathext, &checkout)
}

fn resolve(
    descriptor: &Descriptor,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
    checkout: &Path,
) -> Option<PathBuf> {
    which(descriptor.adapter.program, path, pathext).or_else(|| {
        if descriptor.harness != Harness::Codex {
            return None;
        }
        let bin = checkout.join("node_modules/.agent-adapters/codex/node_modules/.bin");
        which(descriptor.adapter.program, Some(bin.as_os_str()), pathext)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::{CLAUDE, CODEX};

    fn touch(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join(if cfg!(windows) {
            format!("{name}.cmd")
        } else {
            name.to_string()
        });
        std::fs::write(&file, "").unwrap();
        file
    }

    #[test]
    fn a_local_adapter_makes_codex_available_without_a_global_install() {
        let checkout = tempfile::tempdir().unwrap();
        let bin = checkout
            .path()
            .join("node_modules/.agent-adapters/codex/node_modules/.bin");
        let local = touch(&bin, "codex-acp");
        assert_eq!(resolve(&CODEX, None, None, checkout.path()), Some(local));
    }

    #[test]
    fn an_adapter_on_path_keeps_precedence() {
        let checkout = tempfile::tempdir().unwrap();
        let bin = checkout
            .path()
            .join("node_modules/.agent-adapters/codex/node_modules/.bin");
        touch(&bin, "codex-acp");
        let global = tempfile::tempdir().unwrap();
        let wanted = touch(global.path(), "codex-acp");
        assert_eq!(
            resolve(
                &CODEX,
                Some(global.path().as_os_str()),
                None,
                checkout.path()
            ),
            Some(wanted)
        );
    }

    #[test]
    fn no_fallback_is_invented_for_other_harnesses_or_an_uninstalled_codex() {
        let checkout = tempfile::tempdir().unwrap();
        let bin = checkout
            .path()
            .join("node_modules/.agent-adapters/codex/node_modules/.bin");
        touch(&bin, "claude-agent-acp");
        assert_eq!(resolve(&CLAUDE, None, None, checkout.path()), None);
        assert_eq!(resolve(&CODEX, None, None, checkout.path()), None);
    }
}
