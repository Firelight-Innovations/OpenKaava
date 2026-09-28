//! Access tokens from the user's own `gcloud`, cached in memory.
//!
//! `docs/cloud-services.md` §2: OpenKaava holds no keys. It asks
//! `gcloud auth print-access-token`, keeps the answer for most of its hour, and
//! forgets it the moment Google says it stopped working. The token never goes
//! to disk, to a log, or into an error message.

use super::{Result, Trouble};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Tokens last about an hour. Refreshing ten minutes early costs one `gcloud`
/// run and avoids a call failing mid-poll on a token that just expired.
const LIFETIME: Duration = Duration::from_secs(50 * 60);

#[derive(Default)]
pub struct Tokens {
    access: Mutex<Option<(String, Instant)>>,
}

impl Tokens {
    /// A token that was good a moment ago, or a fresh one from `gcloud`.
    pub fn access(&self) -> Result<String> {
        let mut slot = self.access.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((token, at)) = slot.as_ref() {
            if at.elapsed() < LIFETIME {
                return Ok(token.clone());
            }
        }
        let token = print_token(&["auth", "print-access-token"])?;
        *slot = Some((token.clone(), Instant::now()));
        Ok(token)
    }

    /// Drop the cached token after a 401, so the retry asks `gcloud` again.
    pub fn forget(&self) {
        *self.access.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn print_token(args: &[&str]) -> Result<String> {
    // `gcloud` on Windows is `gcloud.cmd`, which `Command` does not find by the
    // bare name — it only appends `.exe`.
    let program = if cfg!(windows) {
        "gcloud.cmd"
    } else {
        "gcloud"
    };
    let mut command = Command::new(program);
    command.args(args);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command.output().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            Trouble::GcloudMissing
        } else {
            Trouble::Unreachable {
                detail: format!("could not run gcloud: {err}"),
            }
        }
    })?;

    if !output.status.success() {
        return Err(classify_failure(&String::from_utf8_lossy(&output.stderr)));
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err(Trouble::SignedOut {
            detail: "gcloud printed no token".into(),
        });
    }
    Ok(token)
}

/// What a failed `gcloud auth print-*-token` means, from its stderr.
///
/// The phrases are gcloud's own. Anything unrecognised is `Unreachable` with
/// the first line of stderr, which never contains a token — a failed print
/// has none to leak.
pub fn classify_failure(stderr: &str) -> Trouble {
    let lower = stderr.to_ascii_lowercase();
    let signed_out = [
        "gcloud auth login",
        "no credentialed accounts",
        "do not currently have an active account",
        "reauthentication",
        "refresh token",
        "invalid_grant",
    ];
    let first = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("gcloud failed")
        .to_string();
    if signed_out.iter().any(|p| lower.contains(p)) {
        Trouble::SignedOut { detail: first }
    } else {
        Trouble::Unreachable { detail: first }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_account_is_signed_out() {
        let t = classify_failure(
            "ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected.\nPlease run:\n\n  $ gcloud auth login",
        );
        assert!(matches!(t, Trouble::SignedOut { .. }), "{t:?}");
    }

    #[test]
    fn an_expired_login_is_signed_out() {
        let t = classify_failure(
            "ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed.",
        );
        assert!(matches!(t, Trouble::SignedOut { .. }), "{t:?}");
    }

    #[test]
    fn anything_else_is_unreachable_with_the_first_line() {
        let t = classify_failure("\nERROR: network is unreachable\nmore");
        assert_eq!(
            t,
            Trouble::Unreachable {
                detail: "ERROR: network is unreachable".into()
            }
        );
    }
}
