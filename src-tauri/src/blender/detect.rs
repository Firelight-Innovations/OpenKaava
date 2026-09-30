//! Finding a Blender executable.
//!
//! The order is the order of trust: the path the user typed into settings,
//! then the `BLENDER` variable, then whatever `PATH` resolves, then the places
//! installers put it (Program Files, Steam, `/Applications`). The first that
//! exists wins, and [`candidates`] is pure over a [`Host`] so the whole search
//! is tested against a fake filesystem instead of the machine's.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Where a found executable came from, for the viewer to say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Setting,
    Env,
    Path,
    ProgramFiles,
    Steam,
    Standard,
}

/// What the search needs to ask the machine. A trait so tests answer from a map.
pub trait Host {
    fn env(&self, name: &str) -> Option<String>;
    fn is_file(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
    /// Immediate child directory names of `dir`; empty when unreadable.
    fn child_dirs(&self, dir: &Path) -> Vec<String>;
    fn read_text(&self, path: &Path) -> Option<String>;
}

pub struct RealHost;

impl Host for RealHost {
    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    }
    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
    fn child_dirs(&self, dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }
    fn read_text(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

fn exe_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["blender.exe"]
    } else {
        &["blender"]
    }
}

/// The numbers in a directory name, compared as numbers, so `Blender 4.10`
/// sorts above `Blender 4.2` and both above `Blender 3.6`.
fn version_key(name: &str) -> Vec<u32> {
    name.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect()
}

/// Steam library folders, from `libraryfolders.vdf` in each Steam root. The
/// file is Valve's KeyValues text; the only lines wanted are `"path"  "..."`.
pub fn steam_libraries(host: &dyn Host, steam_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut libraries: Vec<PathBuf> = steam_roots.to_vec();
    for root in steam_roots {
        let vdf = root.join("steamapps").join("libraryfolders.vdf");
        let Some(text) = host.read_text(&vdf) else {
            continue;
        };
        for line in text.lines() {
            let mut quoted = line.split('"').skip(1).step_by(2);
            if quoted.next() == Some("path") {
                if let Some(value) = quoted.next() {
                    // VDF escapes backslashes.
                    libraries.push(PathBuf::from(value.replace("\\\\", "\\")));
                }
            }
        }
    }
    libraries
}

/// Every place a Blender executable might be, best first, whether or not it
/// exists. Callers filter with [`Host::is_file`].
pub fn candidates(host: &dyn Host, configured: &str) -> Vec<(Source, PathBuf)> {
    let mut out: Vec<(Source, PathBuf)> = Vec::new();

    let configured = configured.trim();
    if !configured.is_empty() {
        out.push((Source::Setting, resolve_dir_or_file(host, configured)));
    }
    if let Some(value) = host.env("BLENDER") {
        out.push((Source::Env, resolve_dir_or_file(host, value.trim())));
    }
    if let Some(path) = host.env("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in exe_names() {
                out.push((Source::Path, dir.join(name)));
            }
        }
    }

    if cfg!(windows) {
        let mut program_dirs: Vec<PathBuf> = Vec::new();
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(dir) = host.env(var) {
                let dir = PathBuf::from(dir);
                if !program_dirs.contains(&dir) {
                    program_dirs.push(dir);
                }
            }
        }
        for program in &program_dirs {
            let foundation = program.join("Blender Foundation");
            let mut versions = host.child_dirs(&foundation);
            versions.sort_by_key(|name| std::cmp::Reverse(version_key(name)));
            for name in versions {
                out.push((
                    Source::ProgramFiles,
                    foundation.join(name).join("blender.exe"),
                ));
            }
        }
        let steam_roots: Vec<PathBuf> = program_dirs.iter().map(|p| p.join("Steam")).collect();
        for library in steam_libraries(host, &steam_roots) {
            out.push((
                Source::Steam,
                library
                    .join("steamapps")
                    .join("common")
                    .join("Blender")
                    .join("blender.exe"),
            ));
        }
    } else {
        out.push((
            Source::Standard,
            PathBuf::from("/Applications/Blender.app/Contents/MacOS/Blender"),
        ));
        for fixed in [
            "/usr/bin/blender",
            "/usr/local/bin/blender",
            "/snap/bin/blender",
        ] {
            out.push((Source::Standard, PathBuf::from(fixed)));
        }
    }
    out
}

/// A `BLENDER`/setting value may name the executable or the folder holding it.
fn resolve_dir_or_file(host: &dyn Host, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if host.is_dir(&path) {
        for name in exe_names() {
            let inside = path.join(name);
            if host.is_file(&inside) {
                return inside;
            }
        }
    }
    path
}

/// The first candidate that exists, and whether the configured path was tried
/// and missing (so the viewer can say "your setting points at nothing").
pub fn find(host: &dyn Host, configured: &str) -> Found {
    let all = candidates(host, configured);
    let configured_missing = all
        .iter()
        .find(|(source, _)| *source == Source::Setting)
        .is_some_and(|(_, path)| !host.is_file(path));
    let hit = all.into_iter().find(|(_, path)| host.is_file(path));
    Found {
        hit,
        configured_missing,
    }
}

pub struct Found {
    pub hit: Option<(Source, PathBuf)>,
    pub configured_missing: bool,
}

/// `"Blender 4.2.3 LTS\n\tbuild date: ..."` to `("4.2.3", 4)`.
pub fn parse_version(stdout: &str) -> Option<(String, u32)> {
    let line = stdout
        .lines()
        .find(|l| l.trim_start().starts_with("Blender "))?;
    let token = line
        .trim_start()
        .trim_start_matches("Blender ")
        .split_whitespace()
        .next()?;
    let major = token.split('.').next()?.parse().ok()?;
    Some((token.to_string(), major))
}

/// Ask an executable for its version. Bounded: a hung binary is not Blender.
pub fn probe_version(path: &Path) -> Option<(String, u32)> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(path);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    super::no_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        match child.try_wait().ok()? {
            Some(_) => break,
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
    let mut text = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut text).ok()?;
    parse_version(&text)
}

/// Whole-word summary for the viewer: what was found and how sure we are.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub found: bool,
    pub path: Option<String>,
    pub source: Option<Source>,
    pub version: Option<String>,
    pub major: Option<u32>,
    /// Blender 4.x is what the pipeline is written and tested against.
    pub supported: bool,
    pub configured_missing: bool,
}

/// Versions already probed this run, keyed by path — starting Blender to ask
/// its version takes a second, and `blender-viewer/state` is polled.
#[derive(Default)]
pub struct VersionCache(std::sync::Mutex<BTreeMap<PathBuf, Option<(String, u32)>>>);

impl VersionCache {
    pub fn get(&self, path: &Path) -> Option<(String, u32)> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(path.to_path_buf())
            .or_insert_with(|| probe_version(path))
            .clone()
    }
    pub fn forget(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

pub fn detect(host: &dyn Host, configured: &str, versions: &VersionCache) -> Detected {
    let Found {
        hit,
        configured_missing,
    } = find(host, configured);
    match hit {
        None => Detected {
            found: false,
            path: None,
            source: None,
            version: None,
            major: None,
            supported: false,
            configured_missing,
        },
        Some((source, path)) => {
            let version = versions.get(&path);
            Detected {
                found: true,
                path: Some(path.display().to_string()),
                source: Some(source),
                supported: version.as_ref().is_some_and(|(_, major)| *major == 4),
                major: version.as_ref().map(|(_, m)| *m),
                version: version.map(|(v, _)| v),
                configured_missing,
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[derive(Default)]
    pub(crate) struct FakeHost {
        pub env: BTreeMap<String, String>,
        pub files: BTreeSet<PathBuf>,
        pub dirs: BTreeMap<PathBuf, Vec<String>>,
        pub text: BTreeMap<PathBuf, String>,
    }

    impl Host for FakeHost {
        fn env(&self, name: &str) -> Option<String> {
            self.env.get(name).cloned()
        }
        fn is_file(&self, path: &Path) -> bool {
            self.files.contains(path)
        }
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.contains_key(path)
        }
        fn child_dirs(&self, dir: &Path) -> Vec<String> {
            self.dirs.get(dir).cloned().unwrap_or_default()
        }
        fn read_text(&self, path: &Path) -> Option<String> {
            self.text.get(path).cloned()
        }
    }

    fn exe() -> &'static str {
        exe_names()[0]
    }

    #[test]
    fn the_configured_path_beats_everything_else() {
        let mut host = FakeHost::default();
        let mine = PathBuf::from("/opt/mine").join(exe());
        let env_one = PathBuf::from("/opt/env").join(exe());
        host.files.insert(mine.clone());
        host.files.insert(env_one.clone());
        host.env
            .insert("BLENDER".into(), env_one.display().to_string());

        let found = find(&host, &mine.display().to_string());
        assert_eq!(found.hit, Some((Source::Setting, mine)));
        assert!(!found.configured_missing);
    }

    #[test]
    fn a_missing_configured_path_is_reported_and_the_search_carries_on() {
        let mut host = FakeHost::default();
        let env_one = PathBuf::from("/opt/env").join(exe());
        host.files.insert(env_one.clone());
        host.env
            .insert("BLENDER".into(), env_one.display().to_string());

        let found = find(&host, "/nowhere/blender");
        assert!(found.configured_missing);
        assert_eq!(found.hit, Some((Source::Env, env_one)));
    }

    #[test]
    fn the_blender_variable_may_name_the_folder() {
        let mut host = FakeHost::default();
        let dir = PathBuf::from("/opt/blender-4.2");
        host.dirs.insert(dir.clone(), vec![]);
        host.files.insert(dir.join(exe()));
        host.env.insert("BLENDER".into(), dir.display().to_string());

        assert_eq!(find(&host, "").hit, Some((Source::Env, dir.join(exe()))));
    }

    #[test]
    fn path_entries_are_searched() {
        let mut host = FakeHost::default();
        let bin = PathBuf::from("/tools/bin");
        host.files.insert(bin.join(exe()));
        host.env.insert(
            "PATH".into(),
            std::env::join_paths([PathBuf::from("/other"), bin.clone()])
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(find(&host, "").hit, Some((Source::Path, bin.join(exe()))));
    }

    #[test]
    fn nothing_found_is_none_not_a_guess() {
        assert!(find(&FakeHost::default(), "").hit.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn program_files_prefers_the_newest_version_by_number() {
        let mut host = FakeHost::default();
        let pf = PathBuf::from("C:/Program Files");
        host.env
            .insert("ProgramFiles".into(), pf.display().to_string());
        let foundation = pf.join("Blender Foundation");
        host.dirs.insert(
            foundation.clone(),
            vec![
                "Blender 4.2".into(),
                "Blender 4.10".into(),
                "Blender 3.6".into(),
            ],
        );
        for v in ["Blender 4.2", "Blender 4.10", "Blender 3.6"] {
            host.files.insert(foundation.join(v).join("blender.exe"));
        }
        assert_eq!(
            find(&host, "").hit,
            Some((
                Source::ProgramFiles,
                foundation.join("Blender 4.10").join("blender.exe")
            ))
        );
    }

    #[cfg(windows)]
    #[test]
    fn steam_libraries_come_from_the_vdf_including_other_drives() {
        let mut host = FakeHost::default();
        let pf86 = PathBuf::from("C:/Program Files (x86)");
        host.env
            .insert("ProgramFiles(x86)".into(), pf86.display().to_string());
        let steam = pf86.join("Steam");
        host.text.insert(
            steam.join("steamapps").join("libraryfolders.vdf"),
            "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\Games\\\\SteamLibrary\"\n\t}\n}\n"
                .into(),
        );
        let blender = PathBuf::from("D:\\Games\\SteamLibrary")
            .join("steamapps")
            .join("common")
            .join("Blender")
            .join("blender.exe");
        host.files.insert(blender.clone());
        assert_eq!(find(&host, "").hit, Some((Source::Steam, blender)));
    }

    #[test]
    fn version_output_is_parsed() {
        assert_eq!(
            parse_version("Blender 4.2.3 LTS\n\tbuild date: 2024-11-19\n"),
            Some(("4.2.3".to_string(), 4))
        );
        assert_eq!(
            parse_version("Blender 3.6.5"),
            Some(("3.6.5".to_string(), 3))
        );
        assert_eq!(parse_version("not blender at all"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn directory_names_sort_numerically() {
        assert!(version_key("Blender 4.10") > version_key("Blender 4.2"));
        assert!(version_key("Blender 4.2") > version_key("Blender 3.6"));
    }
}
