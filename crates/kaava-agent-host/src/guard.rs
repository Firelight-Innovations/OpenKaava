//! Where an agent may work (handoff §0.5 and §3.4.3).
//!
//! Two checks, both here so the host enforces them itself rather than trusting
//! the orchestrator to have:
//!
//! - [`Worktree`] is the only way to name a working directory, and it can only
//!   be built from a linked git worktree — a directory whose `.git` is a file.
//!   A main checkout's `.git` is a directory, so no session can start there.
//! - [`outside`] answers a permission request: every path it names is resolved
//!   against the worktree, symlinks followed, and any that lands outside is
//!   grounds to refuse it without asking the user.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

/// A linked git worktree's root, canonical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    root: PathBuf,
}

/// Why a directory is not a [`Worktree`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotAWorktree {
    /// There is no such directory.
    #[error("{0} does not exist")]
    Missing(PathBuf),
    /// Its `.git` is a directory: this is a main checkout.
    #[error("{0} is a main checkout, and agents never run on main")]
    MainCheckout(PathBuf),
    /// It has no `.git` at all.
    #[error("{0} is not a git worktree")]
    NotGit(PathBuf),
}

impl Worktree {
    /// `path`, if it is the root of a linked worktree.
    pub fn new(path: &Path) -> Result<Self, NotAWorktree> {
        let root = path
            .canonicalize()
            .map_err(|_| NotAWorktree::Missing(path.to_path_buf()))?;
        let git = root.join(".git");
        if git.is_dir() {
            return Err(NotAWorktree::MainCheckout(path.to_path_buf()));
        }
        if !git.is_file() {
            return Err(NotAWorktree::NotGit(path.to_path_buf()));
        }
        Ok(Self { root })
    }

    /// The root, canonical.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The root as a person would write it: on Windows, without the `\\?\`
    /// that canonicalizing adds. This is what the agent is handed as its
    /// working directory — `cmd.exe`, which runs an npm shim, refuses a
    /// verbatim one and silently starts in `C:\Windows` instead.
    pub fn path(&self) -> PathBuf {
        plain(&self.root)
    }

    /// `path` resolved as [`Worktree::resolve`] does, written as
    /// [`Worktree::path`] writes the root.
    pub fn display(&self, path: &str) -> String {
        plain(&self.resolve(path)).to_string_lossy().into_owned()
    }

    /// `path` resolved against the root: the longest part that exists is
    /// canonicalized first, so a symlink inside the worktree that points out
    /// of it is seen for where it points, and only then are `.` and `..` in
    /// the rest folded. Folding first would let `link/..` cancel out on paper
    /// while the kernel follows `link`.
    pub fn resolve(&self, path: &str) -> PathBuf {
        // The root is canonical, so on Windows it is verbatim (`\\?\C:\...`),
        // and a verbatim path takes `/` as part of a name rather than a
        // separator: `src/../../x` would be one harmless-looking file name.
        let path = if cfg!(windows) {
            path.replace('/', "\\")
        } else {
            path.to_string()
        };
        resolve_physical(&self.root.join(path))
    }

    /// Whether `path` resolves inside the worktree.
    pub fn contains(&self, path: &str) -> bool {
        self.resolve(path).starts_with(&self.root)
    }
}

/// Every path a `session/request_permission` names: its tool call's
/// locations, the file fields of its raw input, and its diffs. Deduplicated,
/// in the order found.
pub fn request_paths(tool_call: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    let mut push = |p: &str| add(&mut paths, p);
    for location in array(tool_call, "locations") {
        if let Some(p) = location.get("path").and_then(Value::as_str) {
            push(p);
        }
    }
    if let Some(input) = tool_call.get("rawInput") {
        for key in ["file_path", "path", "notebook_path"] {
            if let Some(p) = input.get(key).and_then(Value::as_str) {
                push(p);
            }
        }
    }
    for block in array(tool_call, "content") {
        if block.get("type").and_then(Value::as_str) == Some("diff") {
            if let Some(p) = block.get("path").and_then(Value::as_str) {
                push(p);
            }
        }
    }
    paths
}

/// Every path a `session/request_permission` reaches: [`request_paths`], the
/// folder a command would run in, and each path and pattern of any extra
/// sandbox access it asks for. This is what the guard checks, and more than
/// the tab shows: a command's folder is almost always the worktree itself.
///
/// Codex asks for sandbox access as a permission profile, with a command
/// (`additionalPermissions`) or on its own (`permissions`). A glob pattern is
/// checked by its text, so one rooted outside the worktree is outside. A
/// named scope, such as the whole disk, names no path; the user is asked.
pub fn request_scope(tool_call: &Value) -> Vec<String> {
    let mut paths = request_paths(tool_call);
    let mut push = |p: &str| add(&mut paths, p);
    let input = tool_call.get("rawInput").unwrap_or(&Value::Null);
    if let Some(cwd) = input.get("cwd").and_then(Value::as_str) {
        push(cwd);
    }
    for key in ["permissions", "additionalPermissions"] {
        let Some(files) = input.get(key).and_then(|p| p.get("fileSystem")) else {
            continue;
        };
        for access in ["read", "write"] {
            for p in array(files, access).filter_map(Value::as_str) {
                push(p);
            }
        }
        for path in array(files, "entries").filter_map(|e| e.get("path")) {
            let text = match path.get("type").and_then(Value::as_str) {
                Some("path") => path.get("path"),
                Some("glob_pattern") => path.get("pattern"),
                _ => None,
            };
            if let Some(p) = text.and_then(Value::as_str) {
                push(p);
            }
        }
    }
    paths
}

/// The paths among `paths` that resolve outside `worktree`.
pub fn outside(worktree: &Worktree, paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter(|p| !worktree.contains(p))
        .cloned()
        .collect()
}

/// `p` added to `paths` unless it is empty or already there.
fn add(paths: &mut Vec<String>, p: &str) {
    if !p.is_empty() && !paths.iter().any(|seen| seen == p) {
        paths.push(p.to_string());
    }
}

fn array<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// `path` without a leading `\\?\`, unless what follows is a UNC share.
fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// `.` and `..` removed without touching the disk. A `..` above the root is
/// kept as the root, which is outside any worktree.
fn fold(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The longest leading run of `path`'s components that exists, canonicalized,
/// with the rest folded onto it. What does not exist holds no symlink, so
/// folding it on paper is what the kernel would do.
fn resolve_physical(path: &Path) -> PathBuf {
    let components: Vec<Component> = path.components().collect();
    for k in (1..=components.len()).rev() {
        let prefix: PathBuf = components[..k].iter().collect();
        if let Ok(real) = prefix.canonicalize() {
            return fold(&real.join(components[k..].iter().collect::<PathBuf>()));
        }
    }
    fold(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A directory laid out as a linked worktree, and one beside it.
    fn layout() -> (tempfile::TempDir, Worktree) {
        let dir = tempfile::tempdir().unwrap();
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join("src")).unwrap();
        std::fs::write(tree.join(".git"), "gitdir: elsewhere\n").unwrap();
        std::fs::create_dir_all(dir.path().join("main/.git")).unwrap();
        let worktree = Worktree::new(&tree).unwrap();
        (dir, worktree)
    }

    #[test]
    fn a_main_checkout_is_not_a_worktree() {
        let (dir, _) = layout();
        let main = dir.path().join("main");
        assert_eq!(
            Worktree::new(&main),
            Err(NotAWorktree::MainCheckout(main.clone()))
        );
        let plain = dir.path();
        assert!(matches!(Worktree::new(plain), Err(NotAWorktree::NotGit(_))));
        assert!(matches!(
            Worktree::new(&dir.path().join("nope")),
            Err(NotAWorktree::Missing(_))
        ));
    }

    #[test]
    fn paths_inside_are_allowed_and_paths_outside_are_not() {
        let (dir, tree) = layout();
        let root = tree.root().to_string_lossy().into_owned();
        assert!(tree.contains("src/new.rs"), "a new file inside");
        assert!(
            tree.contains(&format!("{root}/src/lib.rs")),
            "absolute inside"
        );
        assert!(!tree.contains("../main/README.md"), "a sibling checkout");
        assert!(!tree.contains("src/../../escape.txt"), "dot-dot out");
        assert!(
            !tree.contains("nope/../../escape.txt"),
            "dot-dot out through a folder that does not exist"
        );
        assert!(tree.contains("nope/../src/ok.rs"), "and back in again");
        let main = dir.path().join("main").join("file.txt");
        assert!(!tree.contains(&main.to_string_lossy()), "absolute outside");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_worktree_is_outside() {
        let (dir, tree) = layout();
        std::os::unix::fs::symlink(dir.path().join("main"), tree.root().join("link")).unwrap();
        assert!(!tree.contains("link/file.txt"));
    }

    /// `link/..` is `main`'s parent to the kernel, not the worktree root.
    #[cfg(unix)]
    #[test]
    fn dot_dot_after_a_symlink_follows_the_symlink() {
        let (dir, tree) = layout();
        std::fs::create_dir_all(dir.path().join("main/sub")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("main/sub"), tree.root().join("link")).unwrap();
        assert!(!tree.contains("link/../x.txt"));
    }

    /// A directory junction, which needs no privilege to make and is how a
    /// repository on Windows can point out of itself.
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_worktree_is_outside() {
        let (dir, tree) = layout();
        junction(&tree.path().join("link"), &dir.path().join("main"));
        assert!(!tree.contains("link/file.txt"));
        assert!(!tree.contains("link\\file.txt"));
    }

    /// Unlike a Unix kernel, Win32 folds `..` out of a path before it reaches
    /// the file system, so `link/..` is the worktree again even when `link` is
    /// a junction. The write below shows where Windows puts it; the guard must
    /// agree.
    #[cfg(windows)]
    #[test]
    fn dot_dot_after_a_junction_folds_as_windows_folds_it() {
        let (dir, tree) = layout();
        std::fs::create_dir_all(dir.path().join("main/sub")).unwrap();
        junction(
            &tree.path().join("link"),
            &dir.path().join("main").join("sub"),
        );
        let through = format!("{}\\link\\..\\x.txt", dir.path().join("tree").display());
        std::fs::write(&through, "x").unwrap();
        assert!(dir.path().join("tree").join("x.txt").exists());
        assert!(!dir.path().join("main").join("x.txt").exists());
        assert!(tree.contains("link/../x.txt"), "the guard agrees");
        assert!(
            tree.contains("src/../x.txt"),
            "and a plain folder still folds"
        );
    }

    /// The root is verbatim (`\\?\C:\...`) on Windows, where `/` is part of a
    /// name rather than a separator, so each shape of absolute path has to
    /// land where the kernel would put it.
    #[cfg(windows)]
    #[test]
    fn windows_absolute_paths_resolve_as_the_kernel_would() {
        let (_dir, tree) = layout();
        let root = tree.root().to_string_lossy().into_owned();
        let plain = root.trim_start_matches(r"\\?\").to_string();
        assert!(
            tree.contains(&format!("{plain}\\src\\lib.rs")),
            "drive path"
        );
        assert!(tree.contains(&format!("{}/src/lib.rs", plain.replace('\\', "/"))));
        assert!(
            tree.contains(&format!("{root}\\src\\lib.rs")),
            "verbatim path"
        );
        assert!(
            !tree.contains("C:/Windows/System32/x.dll"),
            "another folder"
        );
        assert!(!tree.contains(r"C:\Windows\System32\x.dll"));
        assert!(
            !tree.contains(r"\\?\C:\Windows\x.dll"),
            "verbatim elsewhere"
        );
        // A loopback address, so checking it asks no name server anything.
        assert!(!tree.contains(r"\\127.0.0.1\share\x.txt"), "a share");
        assert!(
            !tree.contains(r"\\?\UNC\127.0.0.1\share\x.txt"),
            "a verbatim share"
        );
        assert!(
            !tree.contains(&format!("{plain}\\..\\x.txt")),
            "dot-dot out of a drive path"
        );
    }

    #[test]
    fn request_paths_come_from_locations_input_and_diffs() {
        let call = json!({
            "locations": [{"path": "/w/a.rs"}, {"path": "/w/a.rs"}],
            "rawInput": {"file_path": "/w/b.rs", "command": "ls"},
            "content": [
                {"type": "diff", "path": "/w/c.rs", "newText": "x"},
                {"type": "content", "content": {"type": "text", "text": "hi"}}
            ]
        });
        assert_eq!(request_paths(&call), vec!["/w/a.rs", "/w/b.rs", "/w/c.rs"]);
        assert!(request_paths(&json!({"rawInput": {"command": "ls"}})).is_empty());
    }

    #[test]
    fn a_codex_command_is_checked_where_it_runs_and_for_what_it_asks() {
        let call = json!({
            "locations": [{"path": "/w/a.rs"}],
            "rawInput": {
                "command": "cargo build",
                "cwd": "/elsewhere",
                "additionalPermissions": {"fileSystem": {
                    "write": ["/w/target"],
                    "entries": [
                        {"access": "write", "path": {"type": "path", "path": "/w/out"}},
                        {"access": "read", "path": {"type": "glob_pattern", "pattern": "/etc/**"}},
                        {"access": "write", "path": {"type": "special", "value": {"kind": "root"}}}
                    ]
                }}
            }
        });
        assert_eq!(request_paths(&call), vec!["/w/a.rs"]);
        assert_eq!(
            request_scope(&call),
            vec!["/w/a.rs", "/elsewhere", "/w/target", "/w/out", "/etc/**"]
        );
    }

    #[test]
    fn a_codex_sandbox_request_is_checked_for_each_path_it_grants() {
        let (_dir, tree) = layout();
        let call = json!({
            "rawInput": {
                "cwd": "src",
                "permissions": {"fileSystem": {"read": ["src/lib.rs"], "entries": [
                    {"access": "write", "path": {"type": "glob_pattern", "pattern": "../**"}}
                ]}}
            }
        });
        let scope = request_scope(&call);
        assert_eq!(outside(&tree, &scope), vec!["../**".to_string()]);
    }

    #[test]
    fn outside_lists_only_the_escapes() {
        let (_dir, tree) = layout();
        let paths = vec!["src/ok.rs".to_string(), "../escape.rs".to_string()];
        assert_eq!(outside(&tree, &paths), vec!["../escape.rs".to_string()]);
    }
}
