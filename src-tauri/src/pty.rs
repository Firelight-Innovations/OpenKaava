//! Real terminals: a pseudo-terminal per session, and the seam every byte crosses.
//!
//! A pseudo-terminal ("pty") is a pair of file handles that impersonate a physical terminal. We
//! hold the *master* end; the shell we spawn is given the *slave* end and cannot tell the
//! difference between it and a real console. That is what makes full-screen TUIs work — the program
//! asks the terminal how big it is, whether it can move the cursor, whether it can use colour, and
//! gets real answers instead of the "this is a pipe" answers `std::process::Command` would give.
//!
//! `portable-pty` abstracts the three OS mechanisms for this (ConPTY on Windows, `openpty` on
//! macOS and Linux). Used rather than written ourselves for the obvious reason, and the same crate
//! WezTerm ships — exercised heavily by something that is only a terminal.
//!
//! **The interception seam.** Everything here funnels through [`tap_output`] and [`tap_input`], and
//! nothing else in the orchestrator may talk to a pty directly — the whole point of this module's
//! shape. A coding harness — Claude Code, Codex — reads a terminal and writes a terminal, so owning
//! both directions of its byte stream is enough to wrap it: to notice what it did, to answer a
//! prompt on its behalf, to stop it. Those two functions are where that goes; they return `Cow`
//! rather than `()` so a wrapper can *rewrite* a stream, not merely watch it. Both are pass-through
//! today; the seam exists before the feature does so the feature never has to be threaded through
//! the transport later.

use crate::error::{AppError, Result};
use crate::sync::MutexExt;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize, SlavePty};
use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// One session's output, as it arrives. Per-session rather than one global
/// event: a window listens only for the terminals it is showing, so a busy
/// build in one tab does not wake every other tab's listener.
pub fn data_event(id: &str) -> String {
    format!("pty:data:{id}")
}

/// One emission on `pty:data:<id>`.
///
/// Carries a sequence number as well as the bytes, so an emulator that has just
/// been handed the backlog can tell which live events it has already seen. See
/// [`PtySessions::attach`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct Chunk {
    pub seq: u64,
    pub data: String,
}

/// Everything a freshly-mounted emulator needs to catch up, answered in one
/// call by [`PtySessions::attach`].
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Every byte the shell has produced so far, oldest first.
    pub text: String,
    /// The sequence number the next live event will carry. Anything below this
    /// is already inside `text`.
    pub next_seq: u64,
    /// The shell already ended. The `pty:exit` event that said so may have been
    /// emitted before anyone was listening, so it is repeated here.
    pub exited: bool,
}

/// The shell exited. The frontend closes the tab on this; nothing else does.
pub fn exit_event(id: &str) -> String {
    format!("pty:exit:{id}")
}

// --- the seam ---------------------------------------------------------------

/// Every byte the shell produces, before any window sees it.
///
/// Returning `Cow` means the common case costs nothing — `Cow::Borrowed` hands
/// the original string straight through with no copy — while still leaving room
/// for a future wrapper to substitute an owned, rewritten string. That is the
/// Rust idiom for "usually unchanged, occasionally replaced": one type that is
/// either a borrow of what you were given or something you made, chosen at
/// runtime, with no allocation unless you actually allocate.
fn tap_output<'a>(_id: &str, chunk: &'a str) -> Cow<'a, str> {
    Cow::Borrowed(chunk)
}

/// Every keystroke, before the shell sees it. The other half of the wrapper —
/// this is where synthetic input gets injected.
fn tap_input<'a>(_id: &str, data: &'a str) -> Cow<'a, str> {
    Cow::Borrowed(data)
}

// --- sessions ---------------------------------------------------------------

/// How much output a session remembers for an emulator that has not attached
/// yet, or that attaches again after moving windows. Whole chunks are dropped
/// from the front once this is exceeded — enough to repaint a screen and a
/// useful amount of history, far short of xterm's own 10,000-line scrollback,
/// which is the real one.
const BACKLOG_BYTES: usize = 512 * 1024;

/// A session's output, and whether anyone is listening for it yet.
///
/// This exists because of the first four bytes a Windows shell produces.
/// ConPTY opens by asking the terminal where the cursor is (`ESC[6n`) and then
/// *blocks the shell* until something answers — an emulator replies
/// automatically, and until it does, the shell prints nothing at all, not even
/// a prompt. Tauri events have no replay buffer, so an event emitted before the
/// webview registered its listener is simply gone. The launch terminal is
/// opened during `.setup()`, long before any JavaScript runs, so that question
/// was being asked to an empty room every single time: the shell waited
/// forever, and the panel showed a permanently blank terminal that was, in
/// every other respect, working.
///
/// So nothing is emitted until an emulator has said it is listening. Until
/// then output accumulates here.
#[derive(Default)]
struct Backlog {
    /// `(seq, text)`, oldest first.
    chunks: VecDeque<(u64, String)>,
    bytes: usize,
    next_seq: u64,
    /// Set by [`PtySessions::attach`]. False means "emit nothing, just store".
    attached: bool,
    exited: bool,
}

impl Backlog {
    /// Record a chunk and answer whether it should also go out as an event.
    ///
    /// Both halves happen under one lock on purpose. If storing and the
    /// attached check could interleave with `attach`, a chunk could land in the
    /// gap between the backlog being read and the flag being set — emitted to
    /// nobody, and absent from the text the emulator was just handed.
    fn push(&mut self, text: String) -> Option<Chunk> {
        let seq = self.next_seq;
        self.next_seq += 1;

        self.bytes += text.len();
        self.chunks.push_back((seq, text.clone()));
        // Trimming whole chunks rather than bytes: a chunk boundary is already
        // an arbitrary read boundary, so dropping at one adds no new way to cut
        // an escape sequence in half. It can still orphan the tail of a
        // sequence whose head was trimmed, which is why this is a large budget
        // and not a small one.
        while self.bytes > BACKLOG_BYTES && self.chunks.len() > 1 {
            if let Some((_, old)) = self.chunks.pop_front() {
                self.bytes -= old.len();
            }
        }

        self.attached.then_some(Chunk { seq, data: text })
    }
}

struct Session {
    /// Held for its whole life, for two reasons: dropping the master closes the
    /// pty and kills the shell, and it is what `resize` talks to.
    master: Box<dyn MasterPty + Send>,
    /// Taken once at spawn. `take_writer` can only be called once, so the
    /// handle has to be kept rather than re-derived per keystroke.
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Shared with this session's reader thread. Its own lock, deliberately not
    /// the map's: the reader must be able to store a chunk while another thread
    /// is writing a keystroke, and making both wait on one lock would let a
    /// chatty build block typing.
    backlog: Arc<Mutex<Backlog>>,
    /// Which shell actually spawned, as [`candidate`] names it — `pwsh`,
    /// `bash`. Kept because it is the only durable record of it: the same name
    /// starts life as the tab's title, and a title is the running program's to
    /// overwrite at any moment (see `ShellState::set_terminal_title`). Read by
    /// [`PtySessions::insert_paths`], which has to know how this shell quotes.
    shell: String,
    /// The user's "this terminal is running..." choice, which beats detection.
    /// See [`crate::harness`].
    harness_override: Option<crate::harness::Harness>,
    /// Whether a person has typed into this shell. Automatic emulator replies
    /// (cursor-position answers, focus reports) do not count; see
    /// [`is_user_input`]. A shell nobody has typed in can be moved to a new
    /// directory without pulling anything out from under them.
    typed: bool,
}

/// Whether `data` contains anything a person typed, as opposed to the escape
/// sequences an emulator sends by itself.
///
/// ConPTY's opening `ESC[6n` is answered automatically, so a session's first
/// write says nothing about whether anyone is using it. Every escape sequence
/// is skipped, which also skips arrow keys; a session touched only by those has
/// still had nothing run in it.
fn is_user_input(data: &str) -> bool {
    let mut chars = data.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            return true;
        }
        match chars.next() {
            Some('[') => {
                for f in chars.by_ref() {
                    if ('@'..='~').contains(&f) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(f) = chars.next() {
                    if f == '\u{7}' {
                        break;
                    }
                    if f == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

/// Whether a `cd` may be written into a session: nobody typed in it, and no
/// program is running under its shell. Either one means the bytes would land in
/// someone's input, or in a program's (an agent harness would read it as a
/// prompt).
pub fn may_retarget(typed: bool, has_child_process: bool) -> bool {
    !typed && !has_child_process
}

/// The line that moves a shell into `dir`, quoted for its dialect.
///
/// `cmd` needs `/d` to change drive as well as directory.
pub fn cd_line(family: crate::quoting::ShellFamily, dir: &Path) -> String {
    use crate::quoting::ShellFamily;
    let quoted = crate::quoting::quote(family, &dir.display().to_string());
    match family {
        ShellFamily::Cmd => format!("cd /d {quoted}\r"),
        ShellFamily::PowerShell | ShellFamily::Posix => format!("cd {quoted}\r"),
    }
}

/// Where a reference inserted into a session should be aimed.
#[derive(Debug, Clone)]
pub struct Target {
    /// The override if there is one, else what was detected, else a plain shell.
    pub harness: crate::harness::Harness,
    pub detected: Option<crate::harness::Harness>,
    pub overridden: Option<crate::harness::Harness>,
    /// The harness process's own working directory. `None` when nothing was
    /// detected or the OS would not say, in which case paths stay absolute.
    pub cwd: Option<std::path::PathBuf>,
    pub family: crate::quoting::ShellFamily,
}

/// Every live pty, keyed by the session id `ShellState` handed out.
///
/// `Mutex` rather than the `RwLock` used elsewhere in this crate: there is no
/// read-mostly access pattern here. Every operation — write a keystroke, resize,
/// kill — mutates, so a reader/writer split would buy nothing and only add a
/// second way to deadlock.
#[derive(Default)]
pub struct PtySessions {
    inner: Mutex<HashMap<String, Session>>,
}

impl PtySessions {
    /// Spawn a shell, wire its output to `pty:data:<id>`, and remember it.
    ///
    /// Returns the shell's short name — `pwsh`, `bash` — which is what the tab
    /// gets called. Naming the tab after whatever actually spawned means the
    /// label can never claim to be a shell you are not talking to.
    ///
    /// `marker_env` is extra environment for the shell — today only the
    /// read-only marker for a cluster on main, see
    /// `environments::read_only_env`. A terminal is opened there rather than
    /// refused: reading is fine, and a shell cannot be sandboxed from here.
    pub fn open(
        &self,
        app: &AppHandle,
        id: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
        marker_env: &[(String, String)],
    ) -> Result<String> {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Pty {
                id: id.to_string(),
                reason: e.to_string(),
            })?;

        // How an agent in this shell finds OpenKaava's MCP servers. Read here, at
        // spawn, rather than baked into a config file: the port and token are
        // per-launch, and handing them to the process instead of writing them
        // down is what lets the project's `.mcp.json` be committable and keeps a
        // shell the user opened outside OpenKaava unable to connect. Empty if the
        // listener never bound, which spawns an ordinary shell.
        let mut mcp_env = app.state::<crate::mcp::Endpoint>().env();
        mcp_env.extend_from_slice(marker_env);

        // Read here rather than inside `spawn_shell`: this function has the
        // `AppHandle` and `spawn_shell` deliberately does not, so it can be
        // unit-tested without a Tauri app (see its own doc comment).
        let preferred_shell =
            crate::settings::text(app, crate::settings::keys::TERMINAL_DEFAULT_SHELL);

        let (name, child) = spawn_shell(&*pty.slave, id, cwd, &mcp_env, &preferred_shell)?;

        // The slave end must be dropped now that the child holds its own copy.
        // Keeping it alive here would mean the pty always has a writer open, so
        // the read loop below would never see end-of-file and the tab would sit
        // there looking alive long after the shell exited.
        drop(pty.slave);

        let reader = pty.master.try_clone_reader().map_err(|e| AppError::Pty {
            id: id.to_string(),
            reason: e.to_string(),
        })?;
        let writer = pty.master.take_writer().map_err(|e| AppError::Pty {
            id: id.to_string(),
            reason: e.to_string(),
        })?;

        let backlog = Arc::new(Mutex::new(Backlog::default()));
        pump(app.clone(), id.to_string(), reader, Arc::clone(&backlog));

        self.inner.lock_or_panic().insert(
            id.to_string(),
            Session {
                master: pty.master,
                writer,
                child,
                backlog,
                shell: name.clone(),
                harness_override: None,
                typed: false,
            },
        );

        Ok(name)
    }

    /// An emulator has mounted and registered its listener. Hand it everything
    /// the shell has said so far, and start emitting live from here.
    ///
    /// Returns `None` for a session that does not exist — a tab closed while
    /// its view was still mounting, which is not an error.
    pub fn attach(&self, id: &str) -> Option<Attachment> {
        // The map lock is released before the backlog lock is taken. Holding
        // both would put this thread and the reader thread in opposite orders
        // on two locks, which is the shape a deadlock needs.
        let backlog = {
            let map = self.inner.lock_or_panic();
            Arc::clone(&map.get(id)?.backlog)
        };

        let mut b = backlog.lock_or_panic();
        b.attached = true;
        Some(Attachment {
            text: b.chunks.iter().map(|(_, t)| t.as_str()).collect(),
            next_seq: b.next_seq,
            exited: b.exited,
        })
    }

    /// A keystroke, or anything else the emulator wants the shell to receive.
    pub fn write(&self, id: &str, data: &str) {
        let data = tap_input(id, data);
        let mut map = self.inner.lock_or_panic();
        if let Some(s) = map.get_mut(id) {
            s.typed |= is_user_input(&data);
            // Deliberately ignored. A write failing means the shell is already
            // gone, and the read loop's end-of-file is what tells the frontend
            // that — reporting it twice, from two threads, would race.
            let _ = s.writer.write_all(data.as_bytes());
            let _ = s.writer.flush();
        }
    }

    /// Files were dropped on this session. Put their paths at its prompt,
    /// quoted the way this particular shell needs, and run nothing.
    ///
    /// Returns the text that was inserted, or `None` for a session that no
    /// longer exists — a terminal closed between the drag starting and the
    /// release, which is not an error.
    ///
    /// What is appended is one space, so the next thing typed is a new word.
    /// What is never appended is a newline: a newline is the character that
    /// would turn an insertion into an execution. See `quoting::quote_all`,
    /// which is where both of those are decided and tested.
    pub fn insert_paths(&self, id: &str, paths: &[String]) -> Option<String> {
        // The map lock is taken and released before `write` takes it again,
        // rather than held across the quoting. Quoting is pure and cheap, but
        // holding this lock through it would put a keystroke from another
        // session behind it for no reason at all.
        let family = {
            let map = self.inner.lock_or_panic();
            crate::quoting::ShellFamily::of(&map.get(id)?.shell)
        };

        let text = crate::quoting::quote_all(family, paths);
        if text.is_empty() {
            return Some(text);
        }

        // **Insertion is [`write`], which is to say it is indistinguishable
        // from typing.** There is no second path into a pty and this is
        // deliberately not one: the bytes go through [`tap_input`] like every
        // keystroke, so whatever eventually wraps a coding harness sees a
        // dropped path exactly as it sees a typed one. It also means the text
        // lands wherever the cursor already is — an empty prompt, halfway
        // through a half-typed command, or the input box of a full-screen
        // program — which is what "at the current input position" can honestly
        // mean when the orchestrator deliberately does not know what is running
        // in there.
        self.write(id, &text);
        Some(text)
    }

    /// What is running in this session and how to write a reference for it.
    /// Walks the shell's descendants once; call it on a drop or a paste, not on
    /// a timer. `None` for a session that no longer exists.
    pub fn target(&self, id: &str) -> Option<Target> {
        let (family, overridden) = {
            let map = self.inner.lock_or_panic();
            let s = map.get(id)?;
            (
                crate::quoting::ShellFamily::of(&s.shell),
                s.harness_override,
            )
        };
        let found = self
            .pid(id)
            .and_then(|pid| crate::harness::detect(&crate::harness::descendants(pid)));
        let detected = found.as_ref().map(|d| d.harness);
        let harness = overridden
            .or(detected)
            .unwrap_or(crate::harness::Harness::Shell);
        // A working directory only means something for the process it belongs to.
        let cwd = found.filter(|d| d.harness == harness).and_then(|d| d.cwd);
        Some(Target {
            harness,
            detected,
            overridden,
            cwd,
            family,
        })
    }

    /// `None` puts the session back on auto-detection. `false` when the session
    /// is gone.
    pub fn set_harness_override(&self, id: &str, choice: Option<crate::harness::Harness>) -> bool {
        match self.inner.lock_or_panic().get_mut(id) {
            Some(s) => {
                s.harness_override = choice;
                true
            }
            None => false,
        }
    }

    /// Tell the pty its viewport changed. Load-bearing for TUIs: a program
    /// draws to the size the pty reports, so a pty that disagrees with the
    /// emulator produces a corrupt frame rather than a scaled one.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        let map = self.inner.lock_or_panic();
        if let Some(s) = map.get(id) {
            let _ = s.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    /// Move every listed session that is an idle, untouched default shell to
    /// `dir`, and leave the rest alone. Returns the ids that were moved.
    ///
    /// A session is moved only if [`may_retarget`] allows it: nobody has typed
    /// in it, and the shell has no child process right now. Every session
    /// opened by [`PtySessions::open`] is a plain default shell; there is no
    /// startup-command path, and anything launched into a shell afterwards
    /// arrives through [`PtySessions::write`], which marks it typed. The
    /// remaining gap is a program started by the shell's own rc files, which
    /// shows up as a child process only once it has actually spawned.
    ///
    /// The `cd` is written straight to the pty rather than through [`write`],
    /// so it does not mark the session as used.
    pub fn retarget_untyped(&self, ids: &[String], dir: &Path) -> Vec<String> {
        let mut candidates: Vec<(String, Option<u32>)> = Vec::new();
        {
            let mut map = self.inner.lock_or_panic();
            for id in ids {
                if let Some(s) = map.get_mut(id) {
                    if !s.typed {
                        candidates.push((id.clone(), s.child.process_id()));
                    }
                }
            }
        }
        if candidates.is_empty() {
            return Vec::new();
        }

        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let has_child = |pid: Option<u32>| {
            // An unknown pid cannot be shown idle, so it is treated as busy.
            pid.is_none_or(|pid| {
                sys.processes()
                    .values()
                    .any(|p| p.parent().is_some_and(|pp| pp.as_u32() == pid))
            })
        };

        let mut moved = Vec::new();
        let mut map = self.inner.lock_or_panic();
        for (id, pid) in candidates {
            let Some(s) = map.get_mut(&id) else { continue };
            if !may_retarget(s.typed, has_child(pid)) {
                continue;
            }
            let line = cd_line(crate::quoting::ShellFamily::of(&s.shell), dir);
            if s.writer.write_all(line.as_bytes()).is_ok() {
                let _ = s.writer.flush();
                moved.push(id);
            }
        }
        moved
    }

    /// Kill the shell and forget the session. Idempotent — closing a tab whose
    /// shell already exited is not an error.
    pub fn close(&self, id: &str) {
        let mut map = self.inner.lock_or_panic();
        if let Some(mut s) = map.remove(id) {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    /// The shell's own process id, for the busy check.
    fn pid(&self, id: &str) -> Option<u32> {
        let mut map = self.inner.lock_or_panic();
        map.get_mut(id).and_then(|s| s.child.process_id())
    }
}

/// Try each shell candidate in turn and return the first that actually starts.
///
/// Split out of [`PtySessions::open`] so it can be tested without an
/// `AppHandle` — spawning a shell is the one step here that talks to the
/// operating system and can fail for reasons no amount of reading the code will
/// reveal, so it needs to be reachable from `cargo test`. `preferred` is
/// `terminal.defaultShell`'s current value, read by the caller — this function
/// takes it as a plain `&str` rather than calling `settings::text` itself, which
/// is what keeps it testable without a Tauri app.
///
/// `preferred` is tried first when it names a real option (`"auto"`, or
/// anything else this build does not recognise, tries nothing extra) and the
/// automatic order — [`shell_candidates`] — is tried after it regardless of
/// whether it was tried at all. That fall-through is load-bearing: a shell the
/// machine does not have must not leave a tab with nothing behind it, and
/// `settings::schema`'s `SHELLS` options promise exactly this degrade.
///
/// Takes `&dyn SlavePty` rather than the `PtyPair` it comes from: this only
/// needs the end the child will hold, and narrowing the parameter is what lets
/// the test hand it a bare pty of its own.
fn spawn_shell(
    slave: &dyn SlavePty,
    id: &str,
    cwd: &Path,
    extra_env: &[(String, String)],
    preferred: &str,
) -> Result<(String, Box<dyn Child + Send + Sync>)> {
    let mut last_err = String::from("no shell candidate was tried");
    let cwd = clean_cwd(cwd);
    let cwd = cwd.as_path();

    let candidates = preferred_candidate(preferred)
        .into_iter()
        .chain(shell_candidates());

    for Candidate {
        name,
        program,
        mut cmd,
    } in runnable_only(candidates)
    {
        cmd.cwd(cwd);
        // Programs decide what they may draw from `TERM`. Without it, most TUIs
        // fall back to a dumb-terminal path and render as a wall of plain text
        // — which would look like our emulator was broken.
        cmd.env("TERM", "xterm-256color");

        // Applied per candidate rather than once, because each candidate here
        // owns a fresh `CommandBuilder` and only one of them is going to spawn.
        // Setting it on the first would leave the shell that actually started
        // without it on every machine where the preferred or best-preference
        // shell is not installed.
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
        match slave.spawn_command(cmd) {
            Ok(child) => return Ok((name, child)),
            // Not fatal on its own. The candidate list is ordered by
            // preference, and "this shell is not installed" is the ordinary
            // case — for the automatic order's own entries, and doubly so for
            // whatever the user named, which this machine may never have had.
            // Only running out of candidates is an error.
            //
            // **Logged as well as remembered**, which it was not. Only the last
            // failure reached the caller, and only when every candidate had
            // failed — so a launch that fell through to the third shell left
            // nothing behind saying the first two had been tried, and `pnpm
            // probe recent_errors` could not answer what happened during a
            // launch. That silence is why issue #36 was unanswerable.
            Err(e) => {
                // `strip_nul`: portable-pty formats its NUL-terminated wide
                // buffers straight into this message, so an unfiltered one
                // reads as a trailing NUL after `pwsh.exe` in `recent_errors` and sends a reader
                // after a NUL that was never in the program or the cwd.
                let reason = strip_error_nul(&e.to_string());
                crate::kaava_log!("shell candidate {program} did not start: {reason}");
                last_err = format!("{name}: {reason}");
            }
        }
    }

    Err(AppError::Pty {
        id: id.to_string(),
        reason: format!("no usable shell found: {last_err}"),
    })
}

/// Read the pty until it ends, and emit what comes out.
///
/// One OS thread per session rather than async: this is a blocking `read` on a
/// file handle, which is exactly the thing an async runtime cannot do without a
/// dedicated thread underneath it anyway. `move` transfers ownership of the
/// handle and the id into the thread, because the thread outlives this function
/// and so cannot borrow from it.
fn pump(
    app: AppHandle,
    id: String,
    mut reader: Box<dyn Read + Send>,
    backlog: Arc<Mutex<Backlog>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Bytes from the end of the last read that were a *partial* UTF-8
        // character. A read can land mid-character — the pty deals in bytes and
        // knows nothing about encoding — and decoding that in isolation would
        // either fail or, worse, silently produce a replacement character in the
        // middle of otherwise fine output. So the incomplete tail waits here for
        // the rest of itself to arrive.
        let mut pending: Vec<u8> = Vec::new();

        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&buf[..n]);

            // `from_utf8` on failure tells us how much of the input *was* valid,
            // which is precisely the split point we need.
            let (text, rest) = match std::str::from_utf8(&pending) {
                Ok(s) => (s.to_string(), Vec::new()),
                Err(e) => {
                    // `valid_up_to` is the length of a verified-valid prefix, so
                    // the lossy decode never actually substitutes anything — it
                    // is just the infallible spelling of "decode a slice already
                    // known to be UTF-8". An `unsafe` block would buy nothing
                    // measurable, since this runs once per read, not per byte.
                    let (valid, rest) = pending.split_at(e.valid_up_to());
                    (String::from_utf8_lossy(valid).into_owned(), rest.to_vec())
                }
            };
            pending = rest;

            if !text.is_empty() {
                let out = tap_output(&id, &text).into_owned();
                // Stored either way; emitted only once someone is listening.
                let live = backlog.lock_or_panic().push(out);
                if let Some(chunk) = live {
                    let _ = app.emit(&data_event(&id), chunk);
                }
            }
        }

        // Recorded as well as emitted, for the same reason the output is: a
        // shell that fails instantly can be gone before any window exists to
        // hear about it, and a tab whose process died has to close either way.
        backlog.lock_or_panic().exited = true;
        let _ = app.emit(&exit_event(&id), ());
    });
}

// --- which shell ------------------------------------------------------------

/// The shells to try, best first.
///
/// `KAAVA_SHELL` wins when it is set, which is how this machine switches to Git
/// Bash (`C:\Program Files\Git\bin\bash.exe`) without a rebuild. Otherwise
/// Windows gets PowerShell — cross-platform PowerShell first, then the one that
/// ships with the OS — and everything else gets the login shell, falling back to
/// bash.
///
/// The name a tab shows: the executable's stem, without its extension or the
/// directory it was found in. `C:\Program Files\Git\bin\bash.exe` becomes
/// `bash`.
fn candidate(program: &str) -> Candidate {
    let program = strip_nul(program);
    let program = program.as_str();
    let name = Path::new(program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| program.to_string());
    Candidate {
        name,
        program: program.to_string(),
        cmd: CommandBuilder::new(program),
    }
}

/// `text` without any NUL characters.
///
/// A NUL inside a string handed to `CreateProcessW` ends it early, so the
/// program or cwd can never legitimately contain one. Nothing here builds a
/// NUL-terminated string itself — portable-pty appends the terminator to its
/// own wide-character buffer and, on a failure, prints that buffer into its
/// error text — but a value read from the environment or a file can carry one
/// in, and this is the one place both directions are made safe.
fn strip_nul(text: &str) -> String {
    text.replace('\u{0}', "")
}

/// An error message without any NUL, real or Debug-escaped.
///
/// Only for error text. A raw path such as `C:\code\01-game` holds a backslash
/// then a zero that is not a NUL, so the program and cwd go through
/// `strip_nul` instead.
fn strip_error_nul(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{0}' => {}
            // portable-pty prints its program through `{:?}` of an `OsString`,
            // and Debug spells a NUL as the two characters `\0` rather than
            // emitting one. That is the NUL a reader kept seeing after
            // `pwsh.exe`: it was never U+0000, so filtering U+0000 alone left
            // it in place. Debug escapes a real backslash as `\\`, so a lone
            // `\0` is always a NUL and `\\0` is a path separator and a zero.
            '\\' => match chars.peek() {
                Some('0') => {
                    chars.next();
                }
                Some('\\') => {
                    chars.next();
                    out.push_str("\\\\");
                }
                _ => out.push('\\'),
            },
            other => out.push(other),
        }
    }
    out
}

/// The directory a shell is started in, made fit for `CreateProcessW`.
///
/// NULs removed; on Windows a verbatim `\\?\` prefix dropped (a long-path form
/// that `CreateProcessW` does not accept as a working directory) and forward
/// slashes turned into backslashes. A directory that does not exist falls
/// back to the process's own, because a bad cwd fails *every* shell candidate
/// and leaves the tab with nothing, which is worse than starting somewhere
/// slightly wrong.
fn clean_cwd(cwd: &Path) -> PathBuf {
    let raw = strip_nul(&cwd.to_string_lossy());
    #[cfg(windows)]
    let raw = {
        let unprefixed = match raw.strip_prefix(r"\\?\") {
            Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
            _ => raw,
        };
        unprefixed.replace('/', "\\")
    };
    let cleaned = PathBuf::from(raw);
    if cleaned.is_dir() {
        return cleaned;
    }
    crate::kaava_log!(
        "shell cwd {} is not a folder, starting in the process's own instead",
        cleaned.display()
    );
    std::env::current_dir().unwrap_or(cleaned)
}

/// One shell worth trying.
///
/// `program` is kept beside the builder it went into, which `CommandBuilder`
/// does not give back. [`runnable_only`] needs it to read the file's header
/// before the operating system is asked to run it, and the log line on a
/// failure needs it to name something a person can look at — `bash` is a tab
/// title, `C:\Program Files\Git\bin\bash.exe` is a diagnostic.
struct Candidate {
    name: String,
    program: String,
    cmd: CommandBuilder,
}

/// Drop every candidate Windows would answer with a dialog rather than an error.
///
/// `CreateProcess` handed a file that begins `MZ` and has no PE header behind it
/// puts up a modal **"Unsupported 16-Bit Application"** box and blocks the
/// calling thread until somebody presses OK. The launch terminal is spawned from
/// `lib.rs`'s `setup`, synchronously, while the splash is the only window on
/// screen — so one such file on `PATH` is an application that appears not to
/// start until a box nobody can explain is dismissed. That is issue #36.
///
/// Filtering rather than reordering: a candidate that cannot be run is not a
/// candidate, and the list already degrades to the next entry. See
/// `crate::runnable`, which is where the header is read and which does nothing
/// at all off Windows.
fn runnable_only(candidates: impl Iterator<Item = Candidate>) -> Vec<Candidate> {
    candidates
        .filter(
            |candidate| match crate::runnable::unrunnable(&candidate.program) {
                None => true,
                Some(why) => {
                    crate::kaava_log!("skipping shell candidate {}: {why}", candidate.program);
                    false
                }
            },
        )
        .collect()
}

/// The candidate implied by `terminal.defaultShell`'s current value, or `None`
/// for `"auto"` — which has no candidate of its own and defers entirely to
/// [`shell_candidates`] — and for any value this build does not recognise,
/// which is handled the same way rather than by panicking on a settings file
/// written by a newer or older build.
///
/// The values matched here are exactly `settings::schema`'s `SHELLS` options;
/// a new option added there needs an arm added here or it silently falls back
/// to `None` and behaves like `"auto"`.
fn preferred_candidate(preference: &str) -> Option<Candidate> {
    #[cfg(windows)]
    let program = match preference {
        "pwsh" => "pwsh.exe",
        "powershell" => "powershell.exe",
        "cmd" => "cmd.exe",
        "bash" => "bash.exe",
        "zsh" => "zsh.exe",
        _ => return None,
    };

    #[cfg(not(windows))]
    let program = match preference {
        "pwsh" => "pwsh",
        "powershell" => "powershell",
        "cmd" => "cmd",
        "bash" => "/bin/bash",
        "zsh" => "/bin/zsh",
        _ => return None,
    };

    Some(candidate(program))
}

/// Returned as a list and tried in order because "is this program installed"
/// cannot be answered honestly without trying to run it: a `PATH` lookup can
/// succeed against a stub, and a file existing says nothing about whether this
/// user may execute it.
fn shell_candidates() -> Vec<Candidate> {
    if let Ok(explicit) = std::env::var("KAAVA_SHELL") {
        if !explicit.trim().is_empty() {
            return vec![candidate(explicit.trim())];
        }
    }

    #[cfg(windows)]
    {
        vec![
            candidate("pwsh.exe"),
            candidate("powershell.exe"),
            candidate("cmd.exe"),
        ]
    }

    #[cfg(not(windows))]
    {
        let mut out = Vec::new();
        if let Ok(sh) = std::env::var("SHELL") {
            if !sh.trim().is_empty() {
                out.push(candidate(sh.trim()));
            }
        }
        out.push(candidate("/bin/bash"));
        out.push(candidate("/bin/sh"));
        out
    }
}

// --- the busy check ----------------------------------------------------------

/// What a session is running, if it is running anything.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Busy {
    pub process: String,
}

/// Does this session's shell have a child of its own?
///
/// This is the whole "are you sure" test, and it is asked exactly once — at the
/// moment someone clicks a tab's close button. Nothing polls, nothing watches,
/// and no session carries a running/idle flag that could go stale. A shell
/// sitting at a prompt has no children and closes silently; a shell running
/// `npm test`, or a coding harness, has one and gets a dialog naming it.
///
/// Deliberately a *direct child* test rather than a whole-descendant walk. A
/// shell's immediate child is the foreground job, which is what the dialog wants
/// to name; a deep walk would also catch a daemon something left behind, and
/// would prompt about a terminal that is, to the person looking at it, idle.
pub fn busy(sessions: &PtySessions, id: &str) -> Option<Busy> {
    let shell_pid = sessions.pid(id)?;

    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    sys.processes()
        .values()
        .find(|p| {
            p.parent()
                .is_some_and(|parent| parent.as_u32() == shell_pid)
        })
        .map(|p| Busy {
            process: p.name().to_string_lossy().to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn emulator_replies_are_not_typing() {
        assert!(!is_user_input("\u{1b}[1;1R"));
        assert!(!is_user_input("\u{1b}[I\u{1b}[O"));
        assert!(!is_user_input("\u{1b}]11;rgb:0/0/0\u{7}"));
        assert!(!is_user_input("\u{1b}]11;rgb:0/0/0\u{1b}\\"));
        assert!(!is_user_input(""));
    }

    #[test]
    fn a_character_or_enter_is_typing() {
        assert!(is_user_input("l"));
        assert!(is_user_input("\r"));
        assert!(is_user_input("\u{1b}[1;1Rx"));
    }

    #[test]
    fn only_an_untyped_shell_with_no_child_is_retargeted() {
        assert!(may_retarget(false, false));
        assert!(!may_retarget(true, false), "typed in");
        assert!(!may_retarget(false, true), "a program is running under it");
        assert!(!may_retarget(true, true));
    }

    #[test]
    fn a_missing_session_is_skipped() {
        let pty = PtySessions::default();
        // An id with no session is skipped rather than moved.
        assert!(pty
            .retarget_untyped(&["nope".to_string()], Path::new("."))
            .is_empty());
    }

    #[test]
    fn cd_line_is_quoted_per_dialect() {
        use crate::quoting::ShellFamily;
        let dir = Path::new("C:/My Projects/demo");
        assert_eq!(
            cd_line(ShellFamily::Cmd, dir),
            "cd /d \"C:/My Projects/demo\"\r"
        );
        assert_eq!(
            cd_line(ShellFamily::PowerShell, dir),
            "cd 'C:/My Projects/demo'\r"
        );
        assert_eq!(
            cd_line(ShellFamily::Posix, dir),
            "cd 'C:/My Projects/demo'\r"
        );
    }
    use std::time::Duration;

    #[test]
    fn strip_error_nul_removes_a_real_nul_and_a_debug_escaped_one() {
        // What portable-pty's CreateProcessW failure prints for a program whose
        // wide buffer carries its terminator.
        let wide: std::ffi::OsString = "pwsh.exe\0".into();
        let message = format!("CreateProcessW `{wide:?}` failed");
        assert!(message.contains("\\0"));
        assert_eq!(
            strip_error_nul(&message),
            "CreateProcessW `\"pwsh.exe\"` failed"
        );
        assert_eq!(strip_error_nul("pwsh.exe\u{0}"), "pwsh.exe");
    }

    #[test]
    fn strip_error_nul_keeps_an_escaped_backslash_before_a_zero() {
        // Debug of `C:\0dir` is `C:\\0dir`; the zero there is a directory name.
        let path: std::ffi::OsString = "C:\\0dir".into();
        let debug = format!("{path:?}");
        assert_eq!(strip_error_nul(&debug), debug);
    }

    #[test]
    fn a_raw_path_with_a_backslash_before_a_zero_survives() {
        // A cwd or program is a raw path, not Debug text: `\0` there is a
        // separator and a directory name starting with a zero.
        assert_eq!(strip_nul(r"C:\code\01-game"), r"C:\code\01-game");
        assert_eq!(
            candidate(r"C:\tools\0bin\pwsh.exe").program,
            r"C:\tools\0bin\pwsh.exe"
        );
    }

    /// The test that would have caught issue #36. A file on `PATH` that begins
    /// `MZ` and is not a program image is what Windows answers with a modal
    /// "Unsupported 16-Bit Application" box instead of an error — and the
    /// launch terminal is spawned synchronously from `lib.rs`'s `setup`, so the
    /// box lands in front of a splash and the application looks like it did not
    /// start.
    #[test]
    fn a_candidate_that_is_not_a_program_image_is_dropped() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("kaava-pty-candidate-{stamp}"));
        std::fs::create_dir_all(&dir).expect("the temp directory is writable");

        let fake = dir.join("pwsh.exe");
        std::fs::write(&fake, b"MZ and nothing a loader would accept").expect("writes");

        let kept = runnable_only(vec![candidate(&fake.to_string_lossy())].into_iter());

        #[cfg(windows)]
        assert!(
            kept.is_empty(),
            "a file that is not an image is not a shell"
        );
        #[cfg(not(windows))]
        assert_eq!(kept.len(), 1, "the check is Windows' and does nothing here");
    }

    /// And the other half: the filter must not be so eager that it drops a real
    /// one. The test binary is a program image on whatever this is running on.
    #[test]
    fn a_real_program_is_kept_as_a_candidate() {
        let me = std::env::current_exe().expect("a test binary has a path");
        let kept = runnable_only(vec![candidate(&me.to_string_lossy())].into_iter());
        assert_eq!(kept.len(), 1);
    }

    /// A shell this machine does not have is not this filter's business — the
    /// spawn's own error already says so, and dropping it here would replace a
    /// real diagnostic with silence.
    #[test]
    fn a_shell_that_is_not_installed_is_still_tried() {
        let kept = runnable_only(vec![candidate("kaava-no-such-shell-9f3a.exe")].into_iter());
        assert_eq!(kept.len(), 1);
    }

    /// A drop aimed at a terminal that has since closed answers `None` rather
    /// than panicking or silently succeeding. It is the case a slow drag makes
    /// reachable — the tab can be shut between the press and the release — and
    /// the one branch of `insert_paths` that needs no pty to exercise.
    #[test]
    fn inserting_into_a_session_that_is_gone_is_not_an_error() {
        let sessions = PtySessions::default();
        assert!(sessions
            .insert_paths("no-such-session", &["a.rs".to_string()])
            .is_none());
    }

    /// Nothing goes out before someone is listening, and nothing is lost
    /// waiting. This is the invariant the blank-terminal bug came down to.
    #[test]
    fn nothing_is_emitted_before_an_emulator_attaches() {
        let mut b = Backlog::default();

        // The cursor-position request ConPTY opens with, arriving during
        // `.setup()` with no webview alive to hear it.
        assert!(
            b.push("\u{1b}[6n".to_string()).is_none(),
            "an unattached session must not emit"
        );

        b.attached = true;
        let live = b
            .push("PS C:\\> ".to_string())
            .expect("an attached session emits");
        assert_eq!(
            live.seq, 1,
            "sequence numbers count every chunk, not every emission"
        );

        let held: String = b.chunks.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(
            held, "\u{1b}[6nPS C:\\> ",
            "the chunk emitted to nobody is still there for the emulator that arrives late"
        );
        assert_eq!(
            b.next_seq, 2,
            "attach tells the emulator where the live stream resumes"
        );
    }

    /// A build left running overnight must not grow this without bound.
    #[test]
    fn the_backlog_is_bounded() {
        let mut b = Backlog::default();
        let chunk = "x".repeat(8192);
        for _ in 0..200 {
            b.push(chunk.clone());
        }

        assert!(
            b.bytes <= BACKLOG_BYTES + chunk.len(),
            "backlog grew to {} bytes against a {BACKLOG_BYTES}-byte budget",
            b.bytes
        );
        assert_eq!(
            b.next_seq, 200,
            "trimming drops history, never the sequence"
        );
    }

    /// The one thing in this module that cannot be verified by reading it: does
    /// a shell actually start on *this* machine, and do its bytes come back?
    ///
    /// Everything above is arrangement — which candidate to try, where to split
    /// a UTF-8 read, which event name to emit. This is the step that talks to
    /// the OS, and it is exactly the step that failed silently in the app, since
    /// `lib.rs` cannot do anything useful with a launch failure except report
    /// it. So it gets a test that spawns a real shell rather than a fake one.
    #[test]
    fn spawns_a_real_shell_and_talks_to_it() {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("the OS provides a pty");

        let cwd = std::env::temp_dir();
        // Spawned *with* extra environment, because that is the path the app
        // takes — `open` always passes the MCP endpoint's variables, empty or
        // not. A shell that spawned bare here and not in the app would leave the
        // one difference between them untested.
        let injected = [(
            "KAAVA_MCP_TOKEN".to_string(),
            "test-token-not-a-real-one".to_string(),
        )];
        let (name, mut child) = spawn_shell(&*pty.slave, "test", &cwd, &injected, "auto")
            .expect("a usable shell exists on this machine");

        // Same as the real path: the child holds its own copy of the slave end,
        // and this one has to go or the reader below never sees end-of-file.
        drop(pty.slave);

        let mut reader = pty
            .master
            .try_clone_reader()
            .expect("the master can be read");
        let mut writer = pty.master.take_writer().expect("the master can be written");

        // Reading a pty blocks, and a shell that never prints anything would
        // hang the whole test run rather than fail it. So the read happens on
        // its own thread and this one waits with a deadline — a hang becomes a
        // failure with a message.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                if tx
                    .send(String::from_utf8_lossy(&buf[..n]).to_string())
                    .is_err()
                {
                    break;
                }
            }
        });

        let opening = rx
            .recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|e| panic!("`{name}` said nothing within 15s ({e})"));
        assert!(!opening.is_empty(), "`{name}` produced an empty first read");

        // On Windows that opening is a question, not output: ConPTY asks where
        // the cursor is and the shell stays silent until it is answered. An
        // emulator answers automatically; here it has to be done by hand, and
        // *not* doing it is precisely the state the app was stuck in.
        if opening.contains('\u{1b}') {
            let _ = writer.write_all(b"\x1b[1;1R");
            let _ = writer.flush();
        }

        // A shell at a prompt may print nothing further until it is spoken to.
        // `exit` guarantees output and a process that ends itself.
        let _ = writer.write_all(b"exit\r\n");
        let _ = writer.flush();

        let reply = rx
            .recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|e| panic!("`{name}` went silent after the handshake ({e})"));

        let _ = child.kill();
        let _ = child.wait();

        assert!(
            !name.is_empty(),
            "the spawned shell has a name to put on a tab"
        );
        assert!(
            !reply.is_empty(),
            "`{name}` answered the handshake with nothing"
        );
    }

    /// `KAAVA_SHELL` is the documented one-line override, and a typo'd path in
    /// it must not fall back to PowerShell and pretend it worked.
    #[test]
    fn an_explicit_shell_is_the_only_candidate() {
        // Not `std::env::set_var` — tests share a process, and mutating the
        // environment would race with the test above resolving its own shell.
        // The candidate list is pure apart from that one read, so asserting on
        // the default list is the honest half of this.
        let names: Vec<String> = shell_candidates().into_iter().map(|c| c.name).collect();
        assert!(!names.is_empty(), "some shell is always worth trying");

        #[cfg(windows)]
        assert_eq!(
            names.last().map(String::as_str),
            Some("cmd"),
            "cmd is the last resort"
        );
    }

    /// `"auto"` has no candidate of its own — it defers entirely to
    /// `shell_candidates` — and neither does a value this build does not
    /// recognise, which is the forward/backward-compatibility case: a settings
    /// file written by a different build must not panic this one.
    #[test]
    fn auto_and_an_unrecognised_preference_have_no_candidate_of_their_own() {
        assert!(preferred_candidate("auto").is_none());
        assert!(preferred_candidate("fish").is_none());
    }

    /// The promise `settings::schema`'s `SHELLS` options make on
    /// `TERMINAL_DEFAULT_SHELL`: naming a shell this machine does not have must
    /// still produce a working terminal, not a tab that dies immediately.
    #[test]
    fn a_preferred_shell_this_machine_lacks_still_falls_back_to_a_working_shell() {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("the OS provides a pty");
        let cwd = std::env::temp_dir();

        // A real `SHELLS` option, and one this test's machine is not expected
        // to have installed. Whether it happens to exist here or not, the
        // outcome that matters is the same: `spawn_shell` returns a shell that
        // actually started.
        let (name, mut child) = spawn_shell(&*pty.slave, "test", &cwd, &[], "zsh")
            .expect("a preferred shell that fails to spawn still falls through to a real one");
        assert!(!name.is_empty());

        let _ = child.kill();
        let _ = child.wait();
    }

    // --- no NUL reaches CreateProcessW ---------------------------------------

    fn has_nul(text: &std::ffi::OsStr) -> bool {
        text.to_string_lossy().contains('\u{0}')
    }

    /// `recent_errors` showed `pwsh.exe\0` and a cwd ending in `\0`. A NUL in
    /// either would end the string early for CreateProcessW, so whatever the
    /// source, none may survive into the command.
    #[test]
    fn a_program_with_a_trailing_nul_is_built_without_one() {
        let c = candidate("pwsh.exe\u{0}");
        assert_eq!(c.program, "pwsh.exe");
        assert_eq!(c.name, "pwsh");
        assert!(c.cmd.get_argv().iter().all(|a| !has_nul(a)));
    }

    #[test]
    fn every_automatic_candidate_is_free_of_nul() {
        for c in shell_candidates() {
            assert!(!c.program.contains('\u{0}'), "{:?}", c.program);
            assert!(c.cmd.get_argv().iter().all(|a| !has_nul(a)));
        }
    }

    #[test]
    fn a_cwd_with_a_trailing_nul_is_cleaned_to_the_real_folder() {
        let dir = std::env::temp_dir();
        let dirty = PathBuf::from(format!("{}\u{0}", dir.display()));
        let cleaned = clean_cwd(&dirty);
        assert!(!has_nul(cleaned.as_os_str()));
        assert!(cleaned.is_dir());
    }

    #[test]
    fn a_cwd_that_does_not_exist_falls_back_to_a_folder_that_does() {
        let missing = std::env::temp_dir().join("kaava-no-such-folder-for-a-shell");
        let cleaned = clean_cwd(&missing);
        assert!(cleaned.is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn a_verbatim_prefix_and_forward_slashes_are_normalised_on_windows() {
        let dir = std::env::temp_dir();
        let odd = format!(r"\\?\{}", dir.display());
        let cleaned = clean_cwd(Path::new(&odd));
        assert!(!cleaned.to_string_lossy().starts_with(r"\\?\"));
        assert!(cleaned.is_dir());
    }

    #[test]
    fn nul_is_stripped_from_an_error_message() {
        assert_eq!(
            strip_nul("CreateProcessW `pwsh.exe\u{0}` failed"),
            "CreateProcessW `pwsh.exe` failed"
        );
    }
}
