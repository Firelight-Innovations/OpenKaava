//! OpenKaava Cloud from the desktop side: the Google Cloud reads (and the one
//! write) behind the Agents app and the views that follow it.
//!
//! `docs/cloud-services.md` is the contract. This module owns three rules from
//! it so no app has to remember them:
//!
//! - **No keys.** Every call carries a token from the user's own `gcloud`, held
//!   in memory only ([`auth`]). Nothing here writes a token anywhere.
//! - **A missing or signed-out `gcloud` is a state, not a network error.**
//!   [`Trouble`] names it, and the frontend draws the fix.
//! - **Nothing starts on its own.** The only write is [`compute::start`], and
//!   only an app method a person pressed a button for may call it.
//!
//! [`Source::Fixture`] answers every read from a local folder instead, for
//! tests and for building UI while the cloud is down.

pub mod auth;
pub mod compute;
mod http;
pub mod storage;

use kaava_rpc::{RpcError, INTERNAL_ERROR};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

/// The one project OpenKaava Cloud lives in. `KAAVA_GCP_PROJECT` overrides it.
pub const DEFAULT_PROJECT: &str = "veistra-prod";

/// Where agent VMs write their session records. `docs/cloud-services.md` §5.
pub const SESSIONS_BUCKET: &str = "veistra-prod-sessions";

/// Points every read at a local folder instead of Google Cloud.
pub const FIXTURES_ENV: &str = "KAAVA_CLOUD_FIXTURES";

/// Where the answers come from for one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Live {
        project: String,
    },
    /// `<root>/<bucket>/<object>` for storage, `<root>/compute/instances.json`
    /// for machines.
    Fixture {
        root: PathBuf,
    },
}

impl Source {
    /// Read at call time rather than once at startup, so pointing a running
    /// build at fixtures needs no restart of anything but the call.
    pub fn from_env() -> Self {
        match std::env::var_os(FIXTURES_ENV) {
            Some(root) if !root.is_empty() => Source::Fixture { root: root.into() },
            _ => Source::Live {
                project: std::env::var("KAAVA_GCP_PROJECT")
                    .ok()
                    .filter(|p| !p.is_empty())
                    .unwrap_or_else(|| DEFAULT_PROJECT.to_string()),
            },
        }
    }

    /// `"live"` or `"fixture"`, for the frontend to label what it is showing.
    pub fn kind(&self) -> &'static str {
        match self {
            Source::Live { .. } => "live",
            Source::Fixture { .. } => "fixture",
        }
    }

    pub fn project(&self) -> &str {
        match self {
            Source::Live { project } => project,
            Source::Fixture { .. } => "fixture",
        }
    }
}

/// Everything that can stop a cloud call, in the words the frontend needs to
/// pick a screen. Serialized as `data` on the `RpcError`, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Trouble {
    /// `gcloud` is not on `PATH`. The fix is installing the Google Cloud CLI.
    GcloudMissing,
    /// `gcloud` is there but has no usable login. The fix is `gcloud auth login`.
    SignedOut { detail: String },
    /// Signed in, but this identity may not read what was asked.
    Denied { detail: String },
    /// The bucket, object or machine does not exist — usually "not deployed".
    Missing { what: String },
    /// No answer: offline, DNS, a timeout, or `gcloud` failing for another reason.
    Unreachable { detail: String },
    /// Google answered with an error none of the above describes.
    Api { status: u16, detail: String },
    /// A fixture file is missing or malformed.
    Fixture { detail: String },
}

impl Trouble {
    pub fn message(&self) -> String {
        match self {
            Trouble::GcloudMissing => {
                "the Google Cloud CLI (gcloud) is not installed or not on PATH".into()
            }
            Trouble::SignedOut { .. } => "gcloud is not signed in — run `gcloud auth login`".into(),
            Trouble::Denied { detail } => format!("Google Cloud refused the request: {detail}"),
            Trouble::Missing { what } => format!("{what} does not exist"),
            Trouble::Unreachable { detail } => format!("Google Cloud did not answer: {detail}"),
            Trouble::Api { status, detail } => format!("Google Cloud error {status}: {detail}"),
            Trouble::Fixture { detail } => format!("cloud fixture: {detail}"),
        }
    }
}

impl From<Trouble> for RpcError {
    fn from(trouble: Trouble) -> Self {
        let data = serde_json::to_value(&trouble).unwrap_or(Value::Null);
        RpcError::with_data(INTERNAL_ERROR, trouble.message(), data)
    }
}

pub type Result<T> = std::result::Result<T, Trouble>;

/// Process-wide cloud state: the token cache and anything an app keeps to
/// avoid downloading an object twice. Managed once in `lib.rs`.
#[derive(Default)]
pub struct Cloud {
    pub tokens: auth::Tokens,
    pub cache: storage::Cache,
}

/// `2026-09-28T15:12:40Z` from seconds since the Unix epoch — Google's own
/// timestamp shape, so a fixture's times read like a live bucket's.
pub fn rfc3339(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let secs = unix_secs.rem_euclid(86_400);
    // Howard Hinnant's days-from-civil, inverted.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        (secs / 60) % 60,
        secs % 60
    )
}

/// Whether `part` is safe as one path segment of an object name or a folder
/// under a fixture root: no separators, no `..`, nothing empty.
pub fn is_plain_segment(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_matches_known_instants() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_790_608_360), "2026-09-28T15:12:40Z");
    }

    #[test]
    fn a_trouble_reaches_the_frontend_tagged_by_kind() {
        let err: RpcError = Trouble::SignedOut {
            detail: "no account".into(),
        }
        .into();
        let data = err.data.expect("data");
        assert_eq!(data["kind"], "signedOut");
        assert!(err.message.contains("gcloud auth login"));
    }

    #[test]
    fn plain_segments_refuse_traversal() {
        assert!(is_plain_segment("kaava-worker"));
        assert!(is_plain_segment("0b6c1f7e-1234"));
        for bad in ["", ".", "..", "a/b", "a\\b", "x y"] {
            assert!(!is_plain_segment(bad), "{bad:?} must be refused");
        }
    }
}
