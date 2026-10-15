//! What a reference may reach. Every rule here is a refusal, and every refusal
//! is a sentence the person or agent can read.
//!
//! Three gates, in order: the path's spelling ([`check_relative`]), where it
//! really lands once symlinks and junctions are followed, and what kind of file
//! it is (secrets are never served, gitignored files are named but not read).

use ignore::gitignore::GitignoreBuilder;
use ignore::Match;
use std::path::{Path, PathBuf};

/// Names Windows reserves in every directory, whatever the extension.
const DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
/// Longer relative paths are refused rather than handed to a long-path API.
const MAX_PATH_CHARS: usize = 1024;

/// Refuse a relative path whose spelling could escape the root or confuse
/// Windows: empty segments, `.` and `..`, drive letters, `\`, `:` (alternate
/// data streams), reserved device names, and trailing dots or spaces.
pub fn check_relative(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("the reference names no path".into());
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err(format!("a path is at most {MAX_PATH_CHARS} characters"));
    }
    if path.contains('\\') || path.contains(':') {
        return Err(format!(
            "`{path}` must be relative to the project, with `/` separators and no drive"
        ));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!(
                "`{path}` must stay inside the project: no empty, `.` or `..` segments"
            ));
        }
        if segment.ends_with('.') || segment.ends_with(' ') {
            return Err(format!("`{segment}` ends in a dot or a space"));
        }
        let stem = segment.split('.').next().unwrap_or(segment);
        if DEVICE_NAMES.contains(&stem.to_ascii_lowercase().as_str()) {
            return Err(format!("`{segment}` is a reserved device name"));
        }
    }
    Ok(())
}

/// A path inside the root, as it really is on disk.
#[derive(Debug, Clone)]
pub struct Contained {
    /// The root, canonical.
    pub root: PathBuf,
    /// The target, canonical: every symlink and junction followed.
    pub abs: PathBuf,
    /// `abs` relative to `root`, `/`-separated. Differs from the path asked
    /// for when a link inside the project points elsewhere in it.
    pub rel: String,
}

/// Find `rel` under `root` and prove it is still there once links are
/// followed. Both sides are canonicalised, so a junction or symlink that
/// leads out of the project is refused, not followed.
pub fn contain(root: &Path, rel: &str) -> Result<Contained, String> {
    check_relative(rel)?;
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("the project folder cannot be read: {e}"))?;
    let abs = std::fs::canonicalize(root.join(rel)).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("there is no `{rel}` in this project"),
        _ => format!("`{rel}` cannot be read: {e}"),
    })?;
    let inner = abs.strip_prefix(&root).map_err(|_| {
        format!("`{rel}` is a link that leads outside the project, so it is not followed")
    })?;
    let rel = inner
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    Ok(Contained { root, abs, rel })
}

/// Whether a root-relative path ([`Contained::rel`]) is inside Kaava's context store.
pub fn inside_store(rel: &str) -> bool {
    rel.to_ascii_lowercase().starts_with(".kaava/context/")
}

/// Templates that look like `.env` files and hold no secrets by convention.
const ENV_TEMPLATES: &[&str] = &[".example", ".sample", ".template", ".dist", ".defaults"];
/// Folders whose contents are credentials or repository internals.
const SECRET_DIRS: &[&str] = &[
    ".git", ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker",
];
/// Extensions of private keys and key stores.
const KEY_EXTENSIONS: &[&str] = &[
    "pem", "key", "p12", "pfx", "jks", "keystore", "p8", "ppk", "kdbx",
];
/// Whole file names that hold credentials.
const CREDENTIAL_NAMES: &[&str] = &[
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
    ".htpasswd",
    ".pgpass",
    ".my.cnf",
    "keystore.properties",
    "export_credentials.cfg",
];

/// Which secrets rule, if any, a root-relative path falls under. The answer
/// is the rule's name, for the sentence that says why nothing was shown.
pub fn secret_rule(rel: &str) -> Option<&'static str> {
    let lower = rel.replace('\\', "/").to_ascii_lowercase();
    let mut segments: Vec<&str> = lower.split('/').filter(|s| !s.is_empty()).collect();
    let name = segments.pop()?;
    if segments.iter().any(|s| SECRET_DIRS.contains(s)) || SECRET_DIRS.contains(&name) {
        return Some("credential and repository folders (.git, .ssh, .aws and the like)");
    }
    let is_env =
        name == ".env" || name == ".envrc" || name.starts_with(".env.") || name.ends_with(".env");
    if is_env && !ENV_TEMPLATES.iter().any(|t| name.ends_with(t)) {
        return Some(".env files");
    }
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e);
    if KEY_EXTENSIONS.contains(&ext) {
        return Some("private keys and key stores");
    }
    // `ssh-keygen -f` names keys anything; an `id_` name with no extension is
    // the usual shape of one.
    let ssh_key = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
        .iter()
        .any(|k| name.starts_with(k))
        || (name.starts_with("id_") && !name.contains('.'));
    if ssh_key && !name.ends_with(".pub") {
        return Some("SSH private keys");
    }
    let credential = CREDENTIAL_NAMES.contains(&name)
        || name.starts_with("credentials")
        || name.starts_with("secrets.")
        || name.starts_with("client_secret")
        || name.ends_with("kubeconfig")
        || name.contains(".tfvars")
        || name.contains(".tfstate");
    credential.then_some("credential files")
}

/// Which secrets rule a file's first bytes fall under. A private key keeps
/// its header whatever the file is called, so a renamed key is still caught.
pub fn secret_content(head: &[u8]) -> Option<&'static str> {
    let text = String::from_utf8_lossy(head);
    let key = text.lines().map(str::trim).any(|line| {
        let pem = line.starts_with("-----BEGIN ")
            && (line.ends_with("PRIVATE KEY-----") || line.ends_with("PRIVATE KEY BLOCK-----"));
        pem || line.starts_with("PuTTY-User-Key-File-")
    });
    key.then_some("private keys and key stores")
}

/// Whether `abs` (canonical, under the canonical `root`) is excluded by a
/// `.gitignore` between it and the root. The deepest file that has an
/// opinion wins, as in git; `.git/info/exclude` is read at the root.
pub fn ignored(root: &Path, abs: &Path) -> bool {
    let is_dir = abs.is_dir();
    let mut dir = abs.parent();
    while let Some(d) = dir.filter(|d| d.starts_with(root)) {
        let mut builder = GitignoreBuilder::new(d);
        let mut any = false;
        if d == root {
            let exclude = d.join(".git").join("info").join("exclude");
            any |= exclude.is_file() && builder.add(&exclude).is_none();
        }
        let file = d.join(".gitignore");
        any |= file.is_file() && builder.add(&file).is_none();
        if any {
            if let Ok(matcher) = builder.build() {
                match matcher.matched_path_or_any_parents(abs, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
        }
        if d == root {
            break;
        }
        dir = d.parent();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_project_paths_pass() {
        for ok in [
            "a.rs",
            "scripts/player.gd",
            "art/hero sheet.png",
            ".gitignore",
            "levels/v1.2/map.tscn",
            "console.log",
        ] {
            assert!(check_relative(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn spellings_that_leave_the_root_or_trip_windows_are_refused() {
        for bad in [
            "",
            "/etc/passwd",
            "a//b",
            "a/./b",
            "../x",
            "a/..",
            "C:/x",
            "a\\b",
            "file.txt:secret",
            "con",
            "aux.txt",
            "dir/COM1.log",
            "trailing.",
            "trailing ",
        ] {
            assert!(check_relative(bad).is_err(), "{bad:?} passed");
        }
        assert!(check_relative(&"a/".repeat(600)).is_err());
    }

    #[test]
    fn secrets_match_their_rule_and_templates_do_not() {
        let cases = [
            (".env", Some(".env files")),
            ("server/.env.production", Some(".env files")),
            ("deploy/prod.env", Some(".env files")),
            (".envrc", Some(".env files")),
            (".env.example", None),
            ("config/.env.sample", None),
            ("certs/server.PEM", Some("private keys and key stores")),
            (
                "android/release.keystore",
                Some("private keys and key stores"),
            ),
            (
                "home/.ssh/config",
                Some("credential and repository folders (.git, .ssh, .aws and the like)"),
            ),
            (
                ".git/config",
                Some("credential and repository folders (.git, .ssh, .aws and the like)"),
            ),
            ("keys/id_ed25519", Some("SSH private keys")),
            ("keys/id_ed25519.pub", None),
            ("keys/id_work", Some("SSH private keys")),
            ("keys/id_ecdsa_sk", Some("SSH private keys")),
            ("keys/id_work.pub", None),
            ("scripts/id_card.gd", None),
            ("ops/kubeconfig", Some("credential files")),
            ("ops/prod.kubeconfig", Some("credential files")),
            (".pgpass", Some("credential files")),
            ("home/.my.cnf", Some("credential files")),
            ("infra/terraform.tfstate.backup", Some("credential files")),
            ("infra/prod.tfvars.json", Some("credential files")),
            (".godot/export_credentials.cfg", Some("credential files")),
            ("client_secret_123.json", Some("credential files")),
            ("infra/prod.tfvars", Some("credential files")),
            (".npmrc", Some("credential files")),
            (".gitignore", None),
            ("scripts/environment.gd", None),
            ("docs/keys.md", None),
        ];
        for (path, rule) in cases {
            assert_eq!(secret_rule(path), rule, "{path}");
        }
    }

    #[test]
    fn a_private_key_is_known_by_its_header() {
        for key in [
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n",
            "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n  -----BEGIN EC PRIVATE KEY-----\n",
            "-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3Bl\r\n",
            "-----BEGIN PGP PRIVATE KEY BLOCK-----\n",
            "PuTTY-User-Key-File-3: ssh-ed25519\n",
        ] {
            assert_eq!(
                secret_content(key.as_bytes()),
                Some("private keys and key stores"),
                "{key}"
            );
        }
        for plain in [
            "-----BEGIN CERTIFICATE-----\nMIIB\n",
            "-----BEGIN PUBLIC KEY-----\n",
            "A key file starts with `-----BEGIN RSA PRIVATE KEY-----`.\n",
            "",
        ] {
            assert_eq!(secret_content(plain.as_bytes()), None, "{plain}");
        }
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn contain_answers_with_the_real_path_and_refuses_what_is_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        write(dir.path(), "a/b.txt", "x");
        let found = contain(dir.path(), "a/b.txt").unwrap();
        assert_eq!(found.rel, "a/b.txt");
        assert!(found.abs.starts_with(&found.root));
        assert!(contain(dir.path(), "a/missing.txt")
            .unwrap_err()
            .contains("no `a/missing.txt`"));
        assert!(contain(dir.path(), "../outside").is_err());
    }

    #[test]
    fn the_deepest_gitignore_with_an_opinion_wins() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        write(&root, ".gitignore", "*.log\nbuild/\n");
        write(&root, "keep/.gitignore", "!wanted.log\n");
        write(&root, ".git/info/exclude", "local.cfg\n");
        for (rel, expected) in [
            ("debug.log", true),
            ("keep/wanted.log", false),
            ("keep/other.log", true),
            ("build/deep/out.bin", true),
            ("local.cfg", true),
            ("src/main.gd", false),
        ] {
            write(&root, rel, "x");
            assert_eq!(ignored(&root, &root.join(rel)), expected, "{rel}");
        }
    }
}
