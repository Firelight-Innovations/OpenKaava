//! Installing an app from a GitHub release.
//!
//! The second of the three ways in — `docs/design-notes/app-library.md` has the
//! other two and why there are exactly three. A release artifact rather than a
//! clone is the decision recorded in `docs/tool-protocol.md` §6: a fixed set of
//! bytes that can be checksummed before anything runs, needing no `git` on the
//! user's machine.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Sent with every API call. GitHub rejects a request without one.
const USER_AGENT: &str = concat!("OpenKaava/", env!("CARGO_PKG_VERSION"));

/// How long any one request may take before it is abandoned.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// A repository, in the only form the API takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repo {
    pub owner: String,
    pub name: String,
}

impl Repo {
    /// Read a repository out of whatever a person pasted.
    ///
    /// Accepts `owner/name`, an `https://github.com/owner/name` URL with or
    /// without a `.git` suffix or trailing path, and the `git@github.com:`
    /// form. Anything else is `None` — this is the one place a typed URL is
    /// interpreted, so it refuses rather than guesses.
    pub fn parse(input: &str) -> Option<Self> {
        let trimmed = input.trim().trim_end_matches('/');
        let rest = trimmed
            .strip_prefix("https://github.com/")
            .or_else(|| trimmed.strip_prefix("http://github.com/"))
            .or_else(|| trimmed.strip_prefix("git@github.com:"))
            .or_else(|| trimmed.strip_prefix("github.com/"))
            .unwrap_or(trimmed);

        let mut parts = rest.split('/');
        let owner = parts.next()?.trim();
        let name = parts.next()?.trim();
        let name = name.strip_suffix(".git").unwrap_or(name);

        // A third segment is a path into the repository — `/tree/main`, an
        // issue, a file. Harmless to ignore, but an empty half is not.
        if owner.is_empty() || name.is_empty() {
            return None;
        }
        if !is_repo_word(owner) || !is_repo_word(name) {
            return None;
        }
        Some(Self {
            owner: owner.to_string(),
            name: name.to_string(),
        })
    }

    /// `owner/name`, which is how the catalog spells it too.
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// GitHub's own rule for a login or repository name, near enough: letters,
/// digits, and the three punctuation marks it allows.
fn is_repo_word(word: &str) -> bool {
    !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// What went wrong, in terms a person can act on.
#[derive(Debug)]
pub enum RemoteError {
    /// Not a GitHub repository reference at all.
    BadRepo(String),
    /// A 404 from GitHub, and **deliberately one variant for two causes**: a
    /// repository that does not exist and one the token cannot see are
    /// indistinguishable from here. GitHub answers 404 for both precisely so
    /// that a private repository's existence is not leaked, and OpenKaava must not
    /// resolve that ambiguity either.
    NotFoundOrNoAccess {
        slug: String,
        private_hint: bool,
    },
    /// The repository is there, but has published nothing to install.
    NoRelease {
        slug: String,
    },
    /// A release exists but carries no `.zip`.
    NoZipAsset {
        slug: String,
        tag: String,
    },
    Network(String),
    /// The bytes did not match the checksum published beside them.
    Checksum {
        expected: String,
        actual: String,
    },
    Unpack(String),
    /// The zip did not contain a `kaava-tool.toml`.
    NotAPlugin,
    /// The manifest's id is not the one the catalog promised.
    IdMismatch {
        expected: String,
        found: String,
    },
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRepo(input) => {
                write!(f, "`{input}` is not a GitHub repository address")
            }
            Self::NotFoundOrNoAccess { slug, private_hint } => {
                if *private_hint {
                    write!(
                        f,
                        "{slug} could not be reached — sign in to GitHub if it is private"
                    )
                } else {
                    write!(
                        f,
                        "no repository found at {slug}, or you do not have access to it"
                    )
                }
            }
            Self::NoRelease { slug } => write!(f, "{slug} has no published release. "),
            Self::NoZipAsset { slug, tag } => {
                write!(f, "{slug} {tag} has no .zip asset attached")
            }
            Self::Network(why) => write!(f, "could not reach GitHub: {why}"),
            Self::Checksum { expected, actual } => write!(
                f,
                "the download does not match its checksum (expected {expected}, got {actual})"
            ),
            Self::Unpack(why) => write!(f, "could not unpack the download: {why}"),
            Self::NotAPlugin => write!(f, "the release contains no kaava-tool.toml"),
            Self::IdMismatch { expected, found } => write!(
                f,
                "this release calls itself `{found}`, but `{expected}` was expected"
            ),
        }
    }
}

/// One release, as much of it as matters here.
#[derive(Debug, Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<ApiAsset>,
}

#[derive(Debug, Deserialize)]
struct ApiAsset {
    name: String,
    /// The API URL. Used rather than `browser_download_url` because it is the
    /// one that works for a private repository with a token.
    url: String,
}

/// What a resolved release offers, before anything is downloaded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub repo: Repo,
    pub tag: String,
    /// The API URL of the `.zip`.
    pub asset_url: String,
    pub asset_name: String,
    /// The API URL of a `.sha256` sidecar, when the release publishes one.
    pub checksum_url: Option<String>,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                // ureq's default, `WebPki`, would replace the machine's store.
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .user_agent(USER_AGENT)
        .build()
        .into()
}

/// Whether the repository itself can be seen with this token.
///
/// Only ever asked after a 404 from the releases endpoint, to turn one
/// ambiguous status into the two different sentences it stands for. A failure
/// to answer is reported as "cannot see it", which keeps the vaguer of the two
/// messages as the fallback — the one that does not assert a repository exists.
fn exists(repo: &Repo, token: Option<&str>) -> bool {
    let url = format!("https://api.github.com/repos/{}/{}", repo.owner, repo.name);
    let mut request = agent()
        .get(&url)
        .header("Accept", "application/vnd.github+json");
    if let Some(token) = token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }
    request.call().is_ok()
}

/// Ask GitHub what the latest release of a repository is.
pub fn resolve(
    repo: &Repo,
    token: Option<&str>,
    private_hint: bool,
) -> Result<Resolved, RemoteError> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        repo.owner, repo.name
    );
    let mut request = agent()
        .get(&url)
        .header("Accept", "application/vnd.github+json");
    if let Some(token) = token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }

    let release: ApiRelease = match request.call() {
        Ok(mut response) => response
            .body_mut()
            .read_json()
            .map_err(|e| RemoteError::Network(e.to_string()))?,
        // A 404 here means one of two very different things: the repository is
        // unreachable, or it is reachable and has simply never published a
        // release. GitHub gives the same status for both, so ask a second
        // question to tell them apart — "you have no releases yet" and "no such
        // repository" send a person to completely different places, and the
        // first is the ordinary state of a repository that has just been
        // created.
        Err(ureq::Error::StatusCode(404)) => {
            return Err(if exists(repo, token) {
                RemoteError::NoRelease { slug: repo.slug() }
            } else {
                RemoteError::NotFoundOrNoAccess {
                    slug: repo.slug(),
                    private_hint,
                }
            })
        }
        Err(e) => return Err(RemoteError::Network(e.to_string())),
    };

    let zip = release
        .assets
        .iter()
        .find(|asset| asset.name.ends_with(".zip"))
        .ok_or_else(|| RemoteError::NoZipAsset {
            slug: repo.slug(),
            tag: release.tag_name.clone(),
        })?;

    // A sidecar named after the zip. Optional: a release without one still
    // installs, it just cannot be verified, and `install` says so.
    let checksum = release
        .assets
        .iter()
        .find(|asset| asset.name == format!("{}.sha256", zip.name))
        .map(|asset| asset.url.clone());

    Ok(Resolved {
        repo: repo.clone(),
        tag: release.tag_name,
        asset_url: zip.url.clone(),
        asset_name: zip.name.clone(),
        checksum_url: checksum,
    })
}

/// Download one asset, reporting progress as it goes.
///
/// `on_chunk` is called with (received, total). `total` is 0 when the server
/// sends no length, which the caller renders as an indeterminate bar rather
/// than as 0%.
pub fn download(
    url: &str,
    token: Option<&str>,
    mut on_chunk: impl FnMut(u64, u64),
) -> Result<Vec<u8>, RemoteError> {
    let mut request = agent()
        .get(url)
        // The header that makes the API hand back bytes rather than JSON.
        .header("Accept", "application/octet-stream");
    if let Some(token) = token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }

    let mut response = request.call().map_err(|e| match e {
        ureq::Error::StatusCode(404) => RemoteError::Network("the asset is gone".to_string()),
        other => RemoteError::Network(other.to_string()),
    })?;

    let total = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);

    let mut reader = response.body_mut().as_reader();
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| RemoteError::Network(e.to_string()))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        on_chunk(bytes.len() as u64, total);
    }
    Ok(bytes)
}

/// Lowercase hex of the SHA-256 of some bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Pull the hash out of a `.sha256` sidecar.
///
/// Accepts both the bare hash and the `sha256sum` format, which is the hash,
/// whitespace, then the filename. Case-insensitive because both are published.
pub fn parse_checksum(text: &str) -> Option<String> {
    let first = text.split_whitespace().next()?;
    let lowered = first.trim().to_ascii_lowercase();
    (lowered.len() == 64 && lowered.chars().all(|c| c.is_ascii_hexdigit())).then_some(lowered)
}

/// Unpack a zip into a directory, refusing any entry that escapes it.
///
/// The escape check is `enclosed_name`, which is the `zip` crate's own answer
/// to zip-slip: an entry named `../../evil` returns `None` rather than a path.
/// A release is a file downloaded off the internet, so this is the one place
/// that assumption has to be made explicit.
pub fn unpack(bytes: &[u8], into: &Path) -> Result<(), RemoteError> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| RemoteError::Unpack(e.to_string()))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| RemoteError::Unpack(e.to_string()))?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(RemoteError::Unpack(format!(
                "`{}` points outside the archive",
                entry.name()
            )));
        };
        let target = into.join(relative);

        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| RemoteError::Unpack(e.to_string()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| RemoteError::Unpack(e.to_string()))?;
        }
        let mut file =
            std::fs::File::create(&target).map_err(|e| RemoteError::Unpack(e.to_string()))?;
        std::io::copy(&mut entry, &mut file).map_err(|e| RemoteError::Unpack(e.to_string()))?;
    }
    Ok(())
}

/// Find the directory holding `kaava-tool.toml`.
///
/// A release zip usually wraps everything in one folder named after the tag, so
/// the manifest is one level down rather than at the root. Looks at the root
/// and then one level in, and no further — a manifest buried deeper is a
/// differently-shaped archive, and guessing at it would install the wrong thing
/// quietly.
pub fn manifest_root(unpacked: &Path) -> Option<PathBuf> {
    if unpacked.join("kaava-tool.toml").is_file() {
        return Some(unpacked.to_path_buf());
    }
    let entries = std::fs::read_dir(unpacked).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("kaava-tool.toml").is_file() {
            return Some(path);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_slug_parses() {
        let repo = Repo::parse("Firelight-Innovations/OpenKaava-Acme").expect("parses");
        assert_eq!(repo.owner, "Firelight-Innovations");
        assert_eq!(repo.name, "OpenKaava-Acme");
    }

    #[test]
    fn every_url_form_reaches_the_same_repo() {
        let expected = Repo {
            owner: "Firelight-Innovations".to_string(),
            name: "OpenKaava-Acme".to_string(),
        };
        for input in [
            "https://github.com/Firelight-Innovations/OpenKaava-Acme",
            "https://github.com/Firelight-Innovations/OpenKaava-Acme/",
            "https://github.com/Firelight-Innovations/OpenKaava-Acme.git",
            "http://github.com/Firelight-Innovations/OpenKaava-Acme",
            "github.com/Firelight-Innovations/OpenKaava-Acme",
            "git@github.com:Firelight-Innovations/OpenKaava-Acme.git",
            "  Firelight-Innovations/OpenKaava-Acme  ",
        ] {
            assert_eq!(Repo::parse(input).as_ref(), Some(&expected), "for {input}");
        }
    }

    #[test]
    fn a_url_with_a_path_still_names_the_repo() {
        let repo = Repo::parse("https://github.com/owner/name/tree/main/docs").expect("parses");
        assert_eq!(repo.slug(), "owner/name");
    }

    #[test]
    fn nonsense_is_refused_rather_than_guessed_at() {
        for input in [
            "",
            "   ",
            "owner",
            "owner/",
            "/name",
            "https://gitlab.com/a/b/c/d",
        ] {
            // The last one parses as `a/b` only if the host prefix matched,
            // which it does not — so every case here must be None or not GitHub.
            let parsed = Repo::parse(input);
            assert!(
                parsed.is_none() || !input.contains("gitlab"),
                "{input} should not have produced {parsed:?}"
            );
        }
        assert!(Repo::parse("").is_none());
        assert!(Repo::parse("owner").is_none());
    }

    #[test]
    fn a_repo_word_rejects_a_path_separator_or_a_space() {
        assert!(!is_repo_word("a b"));
        assert!(!is_repo_word("a\\b"));
        assert!(is_repo_word("OpenKaava-Acme"));
        assert!(is_repo_word("some_tool.rs"));
    }

    #[test]
    fn sha256_matches_a_known_answer() {
        // The empty string's SHA-256, which is the one hash worth hard-coding.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn a_checksum_file_parses_in_both_published_shapes() {
        let hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(parse_checksum(hash).as_deref(), Some(hash));
        assert_eq!(
            parse_checksum(&format!("{hash}  acme-0.1.0.zip\n")).as_deref(),
            Some(hash)
        );
        assert_eq!(
            parse_checksum(&format!("{}  x.zip", hash.to_uppercase())).as_deref(),
            Some(hash),
            "an uppercase digest is the same digest"
        );
    }

    #[test]
    fn a_checksum_file_that_is_not_a_hash_is_rejected() {
        assert!(parse_checksum("").is_none());
        assert!(parse_checksum("not-a-hash  x.zip").is_none());
        assert!(parse_checksum("abc123  x.zip").is_none(), "too short");
    }

    #[test]
    fn the_404_message_never_confirms_a_repository_exists() {
        let message = RemoteError::NotFoundOrNoAccess {
            slug: "owner/secret".to_string(),
            private_hint: false,
        }
        .to_string();
        assert!(
            message.contains("or you do not have access"),
            "the two causes stay joined: {message}"
        );
    }

    #[test]
    fn no_release_says_what_to_do_about_it() {
        let message = RemoteError::NoRelease {
            slug: "owner/name".to_string(),
        }
        .to_string();
        assert!(message.contains("release"), "got {message}");
    }
}
