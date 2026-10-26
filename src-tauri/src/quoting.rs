//! Writing a path so that the shell on the other end reads it as one word.
//!
//! Dropping files onto a terminal has to put *text* at the prompt, and text is
//! where the shells stop agreeing: `cmd.exe` understands only double quotes,
//! PowerShell escapes a quote by doubling it, POSIX by leaving the string and
//! re-entering it. Getting that wrong turns `C:\Program Files\x` into two
//! arguments, which is the bug this whole feature exists to avoid.
//!
//! It lives in Rust rather than in the frontend that handles the drop because
//! only Rust knows which shell a session is talking to — `pty::open` picked it
//! from a setting and a fallback list, and never told the emulator. Guessing
//! from the tab's title would be guessing from a string the running program is
//! free to overwrite.
//!
//! Adapted from Orca; the attribution sits on [`needs_quoting`], with its rule.

/// The quoting dialects, which are fewer than the shells.
///
/// Rejected: one variant per shell. `bash`, `zsh`, `sh`, `fish` and `nu` all
/// read a single-quoted string as literal text, so splitting them would be five
/// names for one rule and five places to fix a bug in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFamily {
    /// `pwsh`, `powershell`. Single quotes, and a literal one is doubled.
    PowerShell,
    /// `cmd`. Double quotes, and no escape for anything at all.
    Cmd,
    /// Everything else, including the unknown. See [`ShellFamily::of`].
    Posix,
}

impl ShellFamily {
    /// Which dialect a shell's short name speaks.
    ///
    /// The name is the executable's stem, as `pty::candidate` computes it, so
    /// `C:\Program Files\Git\bin\bash.exe` arrives here as `bash`.
    ///
    /// An unrecognised name is [`ShellFamily::Posix`] rather than an error or a
    /// per-platform default. POSIX single-quoting is the rule the widest set of
    /// shells agree on — `fish` and `nu` included, and PowerShell differs from
    /// it only in how a literal quote is escaped, which almost no path contains.
    /// The one shell it would be wrong for is `cmd`, and `cmd` is matched by
    /// name. Defaulting to the *platform's* shell would be worse: on Windows
    /// that is PowerShell, so a user who set `VEISTRA_SHELL` to something exotic
    /// would get the rule for a shell they are deliberately not running.
    pub fn of(shell_name: &str) -> Self {
        match shell_name.trim().to_ascii_lowercase().as_str() {
            "pwsh" | "powershell" => Self::PowerShell,
            "cmd" => Self::Cmd,
            _ => Self::Posix,
        }
    }
}

/// One path, quoted for this dialect — or handed back untouched when it needs
/// no quoting at all.
///
/// Quoting only when it is needed, rather than always, because a person reads
/// this text: it lands at their prompt, in their terminal, and `src/main.rs` is
/// what they expect to see there. It also matters for the case this feature is
/// really aimed at — a coding agent's prompt rather than a shell's — where the
/// agent reads the line as prose and stray quotes are noise it has to see past.
/// Quoting is applied where a shell would otherwise mis-read the path, and
/// nowhere else.
pub fn quote(family: ShellFamily, path: &str) -> String {
    if !needs_quoting(family, path) {
        return path.to_string();
    }

    match family {
        // Literal from the first quote to the second, with one exception: two
        // quotes in a row mean one quote.
        ShellFamily::PowerShell => format!("'{}'", path.replace('\'', "''")),

        // `cmd` has no escape inside a quoted string, so there is nothing to
        // substitute. A `"` in the path would be unquotable — and is also an
        // illegal character in a Windows filename, so no such path can reach
        // here from a file the user actually has. What *is* a real limitation:
        // `%VAR%` still expands inside double quotes, and the batch-file escape
        // (`%%`) does not work at an interactive prompt. A path containing
        // percent signs is therefore inserted as written and may expand.
        ShellFamily::Cmd => format!("\"{path}\""),

        // Leave the string, emit an escaped quote, re-enter it. The classic
        // `'\''`, which is the only way to get a single quote into a
        // single-quoted POSIX string.
        ShellFamily::Posix => format!("'{}'", path.replace('\'', r"'\''")),
    }
}

/// Every path, quoted, space-separated, with one trailing space — the whole
/// insertion for one drop.
///
/// A space is the separator every one of these shells splits on, so a
/// multi-file drop lands as several arguments to whatever the user types next.
/// The *trailing* one is there so what they type next is a new word rather than
/// a suffix on the last path; Orca appends the same one per path, for what
/// reads as the same reason.
///
/// What is deliberately absent is a newline. A newline is the character that
/// would turn an insertion into an execution, and this feature runs nothing —
/// so a path carrying one is **skipped**, along with anything else in the
/// control range, rather than quoted and hoped for. Quoting does not contain a
/// newline in every dialect: `cmd` has no multi-line quoted string, so one
/// inside `"..."` ends the line and runs it. Windows forbids these characters
/// in a filename, so this is a guarantee rather than a case anyone will hit;
/// it is written down because the guarantee is the point of the feature.
pub fn quote_all(family: ShellFamily, paths: &[String]) -> String {
    let mut out = String::new();
    for path in paths.iter().filter(|p| !has_control(p)) {
        out.push_str(&quote(family, path));
        out.push(' ');
    }
    out
}

/// Anything the terminal would read as an instruction rather than a character.
fn has_control(path: &str) -> bool {
    path.chars().any(char::is_control)
}

/// Characters a path may contain and still be safe bare, per dialect.
///
/// Stated as an allow-list rather than a list of metacharacters to avoid: a
/// forgotten metacharacter is a silently broken command line, where a forgotten
/// safe character is one unnecessary pair of quotes.
///
/// This rule — an allow-list, quote only what fails it, `'\''` for POSIX and
/// `"..."` for Windows — is adapted from `shellEscapePath` in Orca's
/// `src/renderer/src/components/terminal-pane/pane-helpers.ts` (MIT,
/// (c) Lovecast Inc.; see THIRD-PARTY-NOTICES). What is not theirs: Orca has
/// two dialects and treats every Windows shell as `cmd`, where this has three,
/// because Veistra spawns PowerShell by default and PowerShell reads the `$` and
/// backtick in a `cmd`-quoted path.
fn needs_quoting(family: ShellFamily, path: &str) -> bool {
    if path.is_empty() {
        return true;
    }

    // A path that starts with `-` reads as an option to whatever it is handed
    // to, in every one of these shells. Quoting does not actually fix that —
    // `'-rf'` is still `-rf` to the program — but it is the honest signal that
    // the token is meant as a value, and it stops PowerShell binding it as a
    // parameter name.
    if path.starts_with('-') {
        return true;
    }

    match family {
        ShellFamily::PowerShell => !path.chars().all(is_safe_powershell),
        ShellFamily::Cmd => !path.chars().all(is_safe_cmd),
        ShellFamily::Posix => !path.chars().all(is_safe_posix),
    }
}

/// PowerShell's set, which is the narrowest. `[` and `]` are excluded because
/// they are wildcard syntax to every path-taking cmdlet, and `@`, `$`, `{`, `}`
/// and backtick because the parser reads them before anything else does.
fn is_safe_powershell(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | '\\' | ':' | '+' | '=')
}

/// `cmd`'s set. Narrower than it looks because `^`, `&`, `|`, `<`, `>`, `(`,
/// `)` and `%` are all live at an interactive prompt.
fn is_safe_cmd(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | '\\' | ':' | '+' | '=')
}

/// The POSIX set, which is the one `shlex` uses. Note what is *not* here:
/// backslash, because it is an escape character, which is exactly why a Windows
/// path handed to Git Bash has to be quoted.
fn is_safe_posix(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(c, '_' | '.' | '-' | '/' | ':' | '@' | '%' | '+' | '=' | ',')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_name_maps_to_its_dialect() {
        assert_eq!(ShellFamily::of("pwsh"), ShellFamily::PowerShell);
        assert_eq!(ShellFamily::of("powershell"), ShellFamily::PowerShell);
        assert_eq!(ShellFamily::of("cmd"), ShellFamily::Cmd);
        assert_eq!(ShellFamily::of("bash"), ShellFamily::Posix);
        assert_eq!(ShellFamily::of("zsh"), ShellFamily::Posix);
    }

    /// The stem of whatever `VEISTRA_SHELL` names, and the casing Windows uses
    /// for it, both have to land on the right dialect.
    #[test]
    fn the_name_is_matched_case_insensitively() {
        assert_eq!(ShellFamily::of("PowerShell"), ShellFamily::PowerShell);
        assert_eq!(ShellFamily::of("CMD"), ShellFamily::Cmd);
    }

    /// The default is the rule the most shells agree on, not the platform's.
    #[test]
    fn an_unknown_shell_is_quoted_the_posix_way() {
        assert_eq!(ShellFamily::of("fish"), ShellFamily::Posix);
        assert_eq!(ShellFamily::of("nu"), ShellFamily::Posix);
        assert_eq!(ShellFamily::of(""), ShellFamily::Posix);
    }

    /// The common case, and the reason quoting is conditional: an ordinary
    /// path arrives at the prompt looking like a path.
    #[test]
    fn an_ordinary_path_is_left_alone() {
        for family in [
            ShellFamily::PowerShell,
            ShellFamily::Cmd,
            ShellFamily::Posix,
        ] {
            assert_eq!(quote(family, "src/main.rs"), "src/main.rs");
        }
    }

    #[test]
    fn a_windows_path_is_bare_for_the_windows_shells() {
        assert_eq!(
            quote(ShellFamily::PowerShell, r"C:\src\main.rs"),
            r"C:\src\main.rs"
        );
        assert_eq!(
            quote(ShellFamily::Cmd, r"C:\src\main.rs"),
            r"C:\src\main.rs"
        );
    }

    /// A backslash is an escape character to a POSIX shell, so Git Bash gets
    /// the same Windows path quoted even though nothing in it looks unsafe.
    #[test]
    fn a_windows_path_is_quoted_for_a_posix_shell() {
        assert_eq!(
            quote(ShellFamily::Posix, r"C:\src\main.rs"),
            r"'C:\src\main.rs'"
        );
    }

    #[test]
    fn a_space_is_quoted_in_every_dialect() {
        assert_eq!(
            quote(ShellFamily::PowerShell, r"C:\Program Files\x"),
            r"'C:\Program Files\x'"
        );
        assert_eq!(
            quote(ShellFamily::Cmd, r"C:\Program Files\x"),
            "\"C:\\Program Files\\x\""
        );
        assert_eq!(quote(ShellFamily::Posix, "/tmp/a b"), "'/tmp/a b'");
    }

    /// The one place the three dialects genuinely differ.
    #[test]
    fn a_literal_quote_is_escaped_per_dialect() {
        assert_eq!(quote(ShellFamily::PowerShell, "bob's"), "'bob''s'");
        assert_eq!(quote(ShellFamily::Posix, "bob's"), r"'bob'\''s'");
    }

    /// PowerShell reads `$` and backtick before the program ever sees them, and
    /// `[` `]` are wildcards to every path-taking cmdlet.
    #[test]
    fn powershell_metacharacters_are_quoted() {
        assert_eq!(quote(ShellFamily::PowerShell, "a$b"), "'a$b'");
        assert_eq!(quote(ShellFamily::PowerShell, "a`b"), "'a`b'");
        assert_eq!(quote(ShellFamily::PowerShell, "log[1].txt"), "'log[1].txt'");
    }

    #[test]
    fn cmd_metacharacters_are_quoted() {
        assert_eq!(quote(ShellFamily::Cmd, "a&b"), "\"a&b\"");
        assert_eq!(quote(ShellFamily::Cmd, "a^b"), "\"a^b\"");
        assert_eq!(quote(ShellFamily::Cmd, "a(b)"), "\"a(b)\"");
    }

    /// Not a metacharacter anywhere, and quoted anyway: a leading dash binds as
    /// a parameter name in PowerShell and reads as an option everywhere else.
    #[test]
    fn a_leading_dash_is_quoted() {
        assert_eq!(quote(ShellFamily::Posix, "-file.txt"), "'-file.txt'");
        assert_eq!(quote(ShellFamily::PowerShell, "-file"), "'-file'");
        assert_eq!(quote(ShellFamily::Cmd, "-file"), "\"-file\"");
    }

    /// A path from a translated file name or a non-English checkout. Nothing in
    /// the allow-lists is non-ASCII, so these quote — which is correct but
    /// conservative, and worth pinning so a later widening is deliberate.
    #[test]
    fn a_non_ascii_path_is_quoted() {
        assert_eq!(quote(ShellFamily::Posix, "/tmp/café"), "'/tmp/café'");
    }

    #[test]
    fn many_paths_join_with_a_space() {
        let paths = vec!["a.rs".to_string(), "b c.rs".to_string()];
        assert_eq!(quote_all(ShellFamily::Posix, &paths), "a.rs 'b c.rs' ");
    }

    /// The insertion ends in a space so the next thing typed is a new word.
    #[test]
    fn an_insertion_ends_ready_for_the_next_word() {
        let paths = vec!["a.rs".to_string()];
        assert_eq!(quote_all(ShellFamily::Posix, &paths), "a.rs ");
    }

    /// The property the whole feature rests on: an insertion is text, never an
    /// instruction. No dialect may emit a newline, including for a path that
    /// contains one — which Windows forbids and POSIX filesystems allow.
    #[test]
    fn an_insertion_never_ends_a_line() {
        let paths = vec!["a\nb.rs".to_string(), "c\rd.rs".to_string()];
        for family in [
            ShellFamily::PowerShell,
            ShellFamily::Cmd,
            ShellFamily::Posix,
        ] {
            let out = quote_all(family, &paths);
            assert!(!out.contains('\n'), "{out:?} carries a newline");
            assert!(!out.contains('\r'), "{out:?} carries a carriage return");
        }
    }

    /// Skipped rather than sanitised: a path with a control character in it is
    /// dropped whole, and the ones beside it still arrive.
    #[test]
    fn a_control_character_costs_only_its_own_path() {
        let paths = vec!["ok.rs".to_string(), "bad\nname.rs".to_string()];
        assert_eq!(quote_all(ShellFamily::Posix, &paths), "ok.rs ");
    }

    #[test]
    fn no_paths_insert_nothing() {
        assert_eq!(quote_all(ShellFamily::Posix, &[]), "");
    }
}
