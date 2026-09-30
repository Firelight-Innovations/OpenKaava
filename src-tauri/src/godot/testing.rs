//! Test-only fixtures shared by the Godot modules: a fake `godot` program.

use std::path::{Path, PathBuf};

/// A fake `godot`: answers `--version`, and otherwise prints to both
/// streams and either exits or lingers, depending on `linger`.
pub fn fake_godot(dir: &Path, linger: bool) -> PathBuf {
    #[cfg(windows)]
    {
        let path = dir.join("fake-godot.cmd");
        let wait = if linger {
            "ping -n 60 127.0.0.1 >nul\r\n"
        } else {
            ""
        };
        let script = format!(
            "@echo off\r\nif \"%1\"==\"--version\" (\r\n  echo 4.3.stable.fake\r\n  exit /b 0\r\n)\r\n\
             echo Godot Engine v4.3.stable.fake\r\necho ERROR: something broke\r\n\
             echo    at: thing (a.cpp:1) 1>&2\r\necho WARNING: careful 1>&2\r\necho args: %*\r\n{wait}exit /b 3\r\n"
        );
        std::fs::write(&path, script).unwrap();
        path
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-godot.sh");
        let wait = if linger { "sleep 60\n" } else { "" };
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 4.3.stable.fake; exit 0; fi\n\
             echo Godot Engine v4.3.stable.fake\necho 'ERROR: something broke'\n\
             echo '   at: thing (a.cpp:1)' >&2\necho 'WARNING: careful' >&2\necho \"args: $@\"\n{wait}exit 3\n"
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }
}
