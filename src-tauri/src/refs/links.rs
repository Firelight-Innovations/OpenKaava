//! Links for the tests that prove a reference never follows one out of the
//! project. A folder link needs no privilege anywhere, being a junction on
//! Windows, so those tests always run. A file link needs one on Windows: where
//! it cannot be made the test says so, and in CI, where it can, that fails.

use std::path::Path;

/// Link the file `at` to `target`, or say why not and answer false.
pub fn file(target: &Path, at: &Path) -> bool {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, at);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(target, at);
    if let Err(e) = &made {
        assert!(
            std::env::var_os("CI").is_none(),
            "CI can make file links, so this test must run there: {e}"
        );
        eprintln!("skipped the file-link half: this machine cannot make one: {e}");
    }
    made.is_ok()
}

/// Link the folder `at` to `target`: a symlink, or a junction on Windows.
pub fn folder(target: &Path, at: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, at).unwrap();
    #[cfg(windows)]
    {
        // `cmd` reads a `/` inside a path as the start of a switch.
        let native = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(native(at))
            .arg(native(target))
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
    }
}
