//! Whether a program name names something Windows will actually run.
//!
//! `CreateProcess` given a file that is not a valid image does not simply
//! return an error. For a file that starts `MZ` and has no PE header behind it,
//! `kernel32` puts up a modal **"Unsupported 16-Bit Application"** box and
//! blocks the calling thread until somebody presses OK — on 64-bit Windows,
//! where nothing can run a 16-bit image and the dialog's advice is useless.
//!
//! That is a dialog this application can be made to show without ever writing
//! one, from a launch-time spawn on the setup thread, which is what issue #36
//! reported: a splash that sat there until a box was dismissed. So a candidate
//! is read before it is run, and one that is not a PE image is skipped rather
//! than handed to the operating system to complain about.
//!
//! Reading the header rather than trusting the extension, because the extension
//! is exactly what is wrong in the case this exists for.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The two bytes every DOS-and-later image starts with.
const DOS_MAGIC: &[u8; 2] = b"MZ";

/// Where the DOS header keeps the offset of the PE header.
const E_LFANEW: u64 = 0x3c;

/// What sits at that offset in a real Win32 image.
const PE_MAGIC: &[u8; 4] = b"PE\0\0";

/// Nothing sane puts its PE header past this, and an absurd `e_lfanew` read out
/// of a truncated file is the case this bound exists for.
const MAX_E_LFANEW: u32 = 1 << 20;

/// Where `program` would be found, or `None` if it would not be found at all.
///
/// A path with a separator in it is taken as it is. A bare name is looked for
/// in `PATH`, in the order `PATH` gives — which is the order `CreateProcess`
/// searches too, after the application directory and the system directories it
/// also consults. Not reproducing those last two is deliberate: they hold
/// Windows' own binaries, which are not the files that fail this check, and a
/// second search order that disagreed with the real one would be worse than
/// none.
///
/// `PATHEXT` is not applied either, so a bare `bash` with no extension resolves
/// to nothing here and is spawned unchecked. Every candidate this build offers
/// carries its extension; the one that might not is a `VEISTRA_SHELL` somebody
/// set by hand, and letting that through unchecked is the same degradation as
/// a program that is not installed.
pub fn resolve(program: &str) -> Option<PathBuf> {
    let named = Path::new(program);
    if named.components().count() > 1 {
        return named.is_file().then(|| named.to_path_buf());
    }

    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join(program))
                .collect::<Vec<_>>()
        })
        .find(|candidate| candidate.is_file())
}

/// Whether the file at `path` is an image `CreateProcess` will accept.
///
/// Deliberately conservative in one direction only: a file this cannot read
/// answers `false`, because the point is to avoid handing the operating system
/// something it will complain about modally, and a file we cannot open is one
/// the spawn was not going to succeed with either.
pub fn is_image(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };

    let mut dos = [0u8; 2];
    if file.read_exact(&mut dos).is_err() || &dos != DOS_MAGIC {
        return false;
    }

    if file.seek(SeekFrom::Start(E_LFANEW)).is_err() {
        return false;
    }
    let mut offset = [0u8; 4];
    if file.read_exact(&mut offset).is_err() {
        return false;
    }
    let offset = u32::from_le_bytes(offset);
    if offset > MAX_E_LFANEW {
        return false;
    }

    if file.seek(SeekFrom::Start(u64::from(offset))).is_err() {
        return false;
    }
    let mut pe = [0u8; 4];
    file.read_exact(&mut pe).is_ok() && &pe == PE_MAGIC
}

/// Why `program` must not be spawned, or `None` if it may be.
///
/// Windows only. On the other two platforms a bad image fails `execvp` with an
/// error the caller already handles, and there is no dialog to prevent — so the
/// check is not merely unnecessary there, it would be a second thing to keep
/// right for no gain.
#[cfg(windows)]
pub fn unrunnable(program: &str) -> Option<String> {
    let Some(found) = resolve(program) else {
        // Not on PATH at all, which is the ordinary "this shell is not
        // installed" case. Let the spawn produce its own error rather than
        // inventing a second vocabulary for the same thing.
        return None;
    };

    (!is_image(&found)).then(|| {
        format!(
            "{} is not a Windows program image; Windows would show \
             \"Unsupported 16-Bit Application\" rather than fail",
            found.display()
        )
    })
}

#[cfg(not(windows))]
pub fn unrunnable(_program: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("veistra-runnable-{tag}-{at}"));
        std::fs::create_dir_all(&dir).expect("the temp directory is writable");
        dir
    }

    fn written(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        let mut file = std::fs::File::create(&path).expect("creates");
        file.write_all(bytes).expect("writes");
        path
    }

    /// The test that would have caught #36. An `MZ` with nothing behind it is
    /// the shape Windows answers with a modal box instead of an error.
    #[test]
    fn an_mz_with_no_pe_header_is_not_an_image() {
        let dir = scratch("mz-only");
        let mut bytes = vec![0u8; 0x40];
        bytes[0] = b'M';
        bytes[1] = b'Z';
        // `e_lfanew` pointing at a header that is not there.
        bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());

        assert!(!is_image(&written(&dir, "old.exe", &bytes)));
    }

    #[test]
    fn a_file_that_is_not_an_image_at_all_is_not_one() {
        let dir = scratch("not-an-image");
        assert!(!is_image(&written(&dir, "empty.exe", b"")));
        assert!(!is_image(&written(&dir, "script.exe", b"#!/bin/sh\n")));
        assert!(!is_image(&dir.join("missing.exe")));
    }

    /// The positive case, against a file that is certainly a real image: the
    /// test binary itself. Windows only, because "is this a PE" is the wrong
    /// question to ask of an ELF or a Mach-O — answering `false` there is
    /// correct rather than interesting, which is also why `unrunnable` does
    /// nothing off Windows.
    #[cfg(windows)]
    #[test]
    fn a_real_executable_is_an_image() {
        let me = std::env::current_exe().expect("a test binary has a path");
        assert!(is_image(&me), "{} is a PE", me.display());
    }

    /// A path with a separator is taken as written; a bare name goes to `PATH`.
    #[test]
    fn a_path_is_taken_as_written_and_a_bare_name_is_searched() {
        let dir = scratch("resolve");
        let there = written(&dir, "there.exe", b"MZ");

        assert_eq!(resolve(&there.to_string_lossy()), Some(there));
        assert_eq!(resolve(&dir.join("nowhere.exe").to_string_lossy()), None);
        assert_eq!(resolve("veistra-no-such-program-9f3a"), None);
    }

    /// A program that is simply not installed is not this module's business:
    /// the spawn's own error already says so, and a second vocabulary for it
    /// would be one more thing to keep in step.
    #[test]
    fn a_program_that_is_not_installed_is_not_reported_as_unrunnable() {
        assert_eq!(unrunnable("veistra-no-such-program-9f3a"), None);
    }
}
