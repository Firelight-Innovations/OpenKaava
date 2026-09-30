//! Which coding harness is running in a terminal, and how to write a file
//! reference it understands.
//!
//! Quoting a path for the *shell* is `quoting.rs`. This is the layer above it:
//! inside `claude` the line is read as prose and `@` mentions, and a path quoted
//! for PowerShell is noise there. See `docs/design/KAAVA-AGENT-CONTEXT.md` §4.3.
//!
//! Detection is on demand (a drop, a paste), never a timer: walk the shell's
//! descendants once and match by executable name and command line. A per-tab
//! override always wins, because a process match is a guess and the user knows.

use crate::quoting::{quote_all, ShellFamily};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Harness {
    Claude,
    Codex,
    Gemini,
    /// A plain shell: today's shell-quoted absolute paths, unchanged.
    Shell,
}

impl Harness {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "gemini" => Some(Self::Gemini),
            "shell" => Some(Self::Shell),
            _ => None,
        }
    }

    /// A coding harness, as opposed to a shell: what decides whether a drop is
    /// copied into the context store or inserted as the path it was.
    pub fn is_agent(self) -> bool {
        !matches!(self, Self::Shell)
    }
}

/// What detection found in a terminal.
#[derive(Debug, Clone, PartialEq)]
pub struct Detected {
    pub harness: Harness,
    /// The harness process's own working directory, when the OS would say. The
    /// only safe base for a relative path: the shell's spawn directory is not
    /// where the user `cd`d before typing `claude`.
    pub cwd: Option<PathBuf>,
}

/// One process, reduced to what matching needs.
#[derive(Debug, Clone)]
pub struct Proc {
    pub name: String,
    pub cmd: Vec<String>,
    pub cwd: Option<PathBuf>,
}

/// Which harness, if any, one process is.
///
/// Native binaries match on the executable stem. The npm installs run as
/// `node`/`bun` with the harness's package in the script path, so those are
/// matched on the command line — and only there, so an unrelated `node` never
/// counts.
pub fn classify(p: &Proc) -> Option<Harness> {
    let stem = Path::new(&p.name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match stem.as_str() {
        "claude" => return Some(Harness::Claude),
        "codex" => return Some(Harness::Codex),
        "gemini" => return Some(Harness::Gemini),
        _ => {}
    }
    if matches!(stem.as_str(), "node" | "bun" | "deno") {
        let joined = p.cmd.join(" ").replace('\\', "/").to_ascii_lowercase();
        if joined.contains("claude-code") {
            return Some(Harness::Claude);
        }
        if joined.contains("@openai/codex") {
            return Some(Harness::Codex);
        }
        if joined.contains("gemini-cli") || joined.contains("@google/gemini") {
            return Some(Harness::Gemini);
        }
    }
    None
}

/// The nearest matching descendant wins; `descendants` is parent-first.
pub fn detect(descendants: &[Proc]) -> Option<Detected> {
    descendants.iter().find_map(|p| {
        classify(p).map(|harness| Detected {
            harness,
            cwd: p.cwd.clone(),
        })
    })
}

/// Every descendant of `root_pid`, parents before children.
pub fn descendants(root_pid: u32) -> Vec<Proc> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet),
    );

    let mut out = Vec::new();
    let mut frontier = vec![root_pid];
    let mut seen = std::collections::HashSet::from([root_pid]);
    while let Some(parent) = frontier.pop() {
        for (pid, p) in sys.processes() {
            if p.parent().is_some_and(|pp| pp.as_u32() == parent) && seen.insert(pid.as_u32()) {
                out.push(Proc {
                    name: p.name().to_string_lossy().into_owned(),
                    cmd: p
                        .cmd()
                        .iter()
                        .map(|c| c.to_string_lossy().into_owned())
                        .collect(),
                    cwd: p.cwd().map(Path::to_path_buf),
                });
                frontier.insert(0, pid.as_u32());
            }
        }
    }
    out
}

/// The text to insert at the prompt for these absolute paths.
///
/// No newline ever, one trailing space, control characters skipped — the same
/// guarantees as `quoting::quote_all`, which the plain-shell case simply is.
///
/// `base` is the harness's working directory. A path under it is written
/// relative (shorter, and it survives a moved worktree); anything else, and
/// everything when `base` is unknown, stays absolute. Forward slashes on every
/// platform: all three harnesses accept them on Windows.
pub fn reference(
    harness: Harness,
    family: ShellFamily,
    base: Option<&Path>,
    paths: &[String],
) -> String {
    if harness == Harness::Shell {
        return quote_all(family, paths);
    }
    let mut out = String::new();
    for path in paths.iter().filter(|p| !p.chars().any(char::is_control)) {
        let shown = base
            .and_then(|b| crate::context::relative_to(b, Path::new(path)))
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| path.replace('\\', "/"));
        out.push_str(&mention(harness, &shown));
        out.push(' ');
    }
    out
}

/// `@path` for Claude Code and Gemini; a bare path for Codex, whose `@` is a
/// fuzzy search rather than an attachment. A name with whitespace is wrapped in
/// double quotes, which is the form Claude Code's mention parser accepts.
fn mention(harness: Harness, path: &str) -> String {
    let spaced = path.chars().any(char::is_whitespace);
    let body = if spaced {
        format!("\"{path}\"")
    } else {
        path.to_string()
    };
    match harness {
        Harness::Codex => body,
        _ => format!("@{body}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(name: &str, cmd: &[&str]) -> Proc {
        Proc {
            name: name.into(),
            cmd: cmd.iter().map(|s| s.to_string()).collect(),
            cwd: None,
        }
    }

    #[test]
    fn native_binaries_are_matched_by_name() {
        assert_eq!(classify(&proc("claude.exe", &[])), Some(Harness::Claude));
        assert_eq!(classify(&proc("Codex.EXE", &[])), Some(Harness::Codex));
        assert_eq!(classify(&proc("gemini", &[])), Some(Harness::Gemini));
        assert_eq!(classify(&proc("pwsh.exe", &[])), None);
    }

    #[test]
    fn npm_installs_are_matched_by_script_path_not_by_node() {
        let claude = proc(
            "node.exe",
            &[
                "node",
                r"C:\Users\b\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js",
            ],
        );
        assert_eq!(classify(&claude), Some(Harness::Claude));
        let codex = proc(
            "node",
            &["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"],
        );
        assert_eq!(classify(&codex), Some(Harness::Codex));
        let gemini = proc(
            "node",
            &["node", "/x/node_modules/@google/gemini-cli/dist/index.js"],
        );
        assert_eq!(classify(&gemini), Some(Harness::Gemini));
        assert_eq!(classify(&proc("node", &["node", "server.js"])), None);
    }

    #[test]
    fn the_nearest_descendant_wins_and_carries_its_cwd() {
        let mut inner = proc("claude.exe", &[]);
        inner.cwd = Some(PathBuf::from("/work/game"));
        let found = detect(&[proc("conhost.exe", &[]), inner]).unwrap();
        assert_eq!(found.harness, Harness::Claude);
        assert_eq!(found.cwd, Some(PathBuf::from("/work/game")));
        assert!(detect(&[proc("git.exe", &[])]).is_none());
    }

    fn base() -> PathBuf {
        PathBuf::from(if cfg!(windows) {
            "C:/work/game"
        } else {
            "/work/game"
        })
    }

    fn under(rel: &str) -> String {
        format!("{}/{rel}", base().to_string_lossy())
    }

    #[test]
    fn claude_gets_an_at_mention_relative_to_its_own_cwd() {
        let paths = vec![under(".kaava/context/20260930-shot-ab12.png")];
        let text = reference(
            Harness::Claude,
            ShellFamily::PowerShell,
            Some(&base()),
            &paths,
        );
        assert_eq!(text, "@.kaava/context/20260930-shot-ab12.png ");
    }

    #[test]
    fn a_path_outside_the_cwd_or_with_no_cwd_stays_absolute_with_forward_slashes() {
        let out = if cfg!(windows) {
            r"C:\elsewhere\a.png"
        } else {
            "/elsewhere/a.png"
        };
        let text = reference(
            Harness::Claude,
            ShellFamily::Posix,
            Some(&base()),
            &[out.to_string()],
        );
        assert_eq!(text, format!("@{} ", out.replace('\\', "/")));
        let none = reference(Harness::Claude, ShellFamily::Posix, None, &[under("a.png")]);
        assert_eq!(none, format!("@{} ", under("a.png")));
    }

    #[test]
    fn whitespace_in_a_path_is_quoted_inside_the_mention() {
        let text = reference(
            Harness::Claude,
            ShellFamily::Posix,
            Some(&base()),
            &[under("my shot.png")],
        );
        assert_eq!(text, "@\"my shot.png\" ");
    }

    #[test]
    fn codex_gets_a_bare_path_and_gemini_an_at_mention() {
        let p = vec![under("a.png")];
        assert_eq!(
            reference(Harness::Codex, ShellFamily::Posix, Some(&base()), &p),
            "a.png "
        );
        assert_eq!(
            reference(Harness::Gemini, ShellFamily::Posix, Some(&base()), &p),
            "@a.png "
        );
    }

    #[test]
    fn a_plain_shell_is_todays_quoting_exactly() {
        let paths = vec!["C:/My Files/a.png".to_string(), "b.png".to_string()];
        for family in [
            ShellFamily::PowerShell,
            ShellFamily::Cmd,
            ShellFamily::Posix,
        ] {
            assert_eq!(
                reference(Harness::Shell, family, Some(&base()), &paths),
                quote_all(family, &paths)
            );
        }
        assert_eq!(
            reference(Harness::Shell, ShellFamily::PowerShell, None, &paths),
            "'C:/My Files/a.png' b.png "
        );
    }

    #[test]
    fn a_reference_never_carries_a_newline_or_other_control_character() {
        let paths = vec![
            "ok.png".to_string(),
            "bad\n.png".to_string(),
            "bad\u{1b}[2J.png".to_string(),
        ];
        for h in [
            Harness::Claude,
            Harness::Codex,
            Harness::Gemini,
            Harness::Shell,
        ] {
            let text = reference(h, ShellFamily::Posix, None, &paths);
            assert!(!text.chars().any(char::is_control), "{h:?}");
            assert!(text.contains("ok.png"));
            assert!(!text.contains("bad"));
        }
    }

    #[test]
    fn the_override_names_parse() {
        assert_eq!(Harness::parse("claude"), Some(Harness::Claude));
        assert_eq!(Harness::parse("shell"), Some(Harness::Shell));
        assert_eq!(Harness::parse("auto"), None);
    }
}
