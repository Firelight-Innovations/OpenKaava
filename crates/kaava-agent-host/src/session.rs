//! One agent process and the ACP session inside it.
//!
//! Six threads, each owning one thing, so that nothing that can block — a
//! pipe write, a read, a wait — ever runs while another thread needs the
//! session's lock:
//!
//! - the **writer** owns the child's stdin. Everyone else hands it a finished
//!   line over a channel and returns at once.
//! - the **reader** reads stdout: replies, the agent's own requests, updates.
//! - the **stderr** thread keeps a masked tail for the log, and nothing else.
//! - the **waiter** owns the child and notices it exit. That, not stdout's
//!   end, is what ends the session: a grandchild can hold stdout open long
//!   after the agent is gone.
//! - the **driver** runs the handshake and then one prompt at a time.
//! - the **settings** thread asks the agent for one setting change at a time
//!   — a mode, a model — in the order the user made them.
//!
//! None of them is joined. Each holds the shared state, and goes when its own
//! work ends.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::config::{self, Settings};
use crate::event::{
    Attachment, Envelope, Event, Hint, Item, ItemKind, SessionState, SessionStatus, SettingTrouble,
};
use crate::guard::{outside, request_paths, Worktree};
use crate::harness::LaunchSpec;
use crate::host::HostError;
use crate::job::{self, Job};
use crate::mask::mask;
use crate::normalize::Normalizer;
use crate::transcript::Transcript;
use crate::wire::{self, Id, Incoming, RemoteError, AUTH_REQUIRED, METHOD_NOT_FOUND};

/// Where every envelope goes. Called from one thread, in `seq` order.
pub type Sink = Arc<dyn Fn(Envelope) + Send + Sync>;

/// Where the host's diagnostic lines go. Never handed a prompt, an answer, a
/// tool's output or anything an `_auth/*` notification carried; stderr only
/// masked.
pub type Log = Arc<dyn Fn(Level, &str) + Send + Sync>;

/// How much a [`Log`] line matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// A session started, met its adapter or ended as asked.
    Info,
    /// A session failed to start or died on its own. The shell keeps these
    /// where `recent_errors` can read them.
    Failure,
}

/// How long each handshake step may take.
const HANDSHAKE: Duration = Duration::from_secs(60);

/// How many stderr lines are kept for the log.
const STDERR_TAIL: usize = 8;

/// The most of one stderr line kept for the log.
const STDERR_LINE: usize = 4 * 1024;

/// The longest stdout line read as a message. A longer one is dropped whole
/// and counted as noise, so an agent cannot grow the host without bound.
const MESSAGE_LIMIT: usize = 32 * 1024 * 1024;

/// The most approvals that may wait on the user at once. Past it a request is
/// refused unseen.
const MAX_PENDING_APPROVALS: usize = 64;

/// The most characters of an agent's reason for refusing a change that are
/// kept. It rides on every status event until the next change is answered
/// and is drawn inline, so a stack or a dumped option list stops short.
const REFUSAL_REASON: usize = 300;

/// Local codes for a reply that never came. Negative and far from JSON-RPC's
/// reserved range, so no agent sends them.
const CLOSED: i64 = -1;
const TIMED_OUT: i64 = -2;

/// Everything a session needs to start.
pub(crate) struct Start {
    pub(crate) instance_id: String,
    pub(crate) spec: LaunchSpec,
    pub(crate) worktree: Worktree,
    pub(crate) prefix: String,
    pub(crate) prior: Vec<Item>,
    pub(crate) seq: Arc<AtomicU64>,
    /// The host's count of setting changes, which numbers this session's.
    pub(crate) changes: Arc<AtomicU64>,
    pub(crate) events: Sender<Envelope>,
    pub(crate) log: Log,
}

/// A running (or finished) agent session. Dropping it kills the process.
pub(crate) struct Session {
    shared: Arc<Shared>,
}

struct Shared {
    instance_id: String,
    worktree: Worktree,
    expected_version: Option<&'static str>,
    /// The mode the handshake puts the session in, from its harness's policy.
    ask_first: &'static str,
    setting_timeout: Duration,
    child: Mutex<Child>,
    /// What ends the child and everything it started at once.
    job: Option<Job>,
    writer: Sender<Line>,
    settings: Sender<Setting>,
    seq: Arc<AtomicU64>,
    changes: Arc<AtomicU64>,
    log: Log,
    stderr: Mutex<VecDeque<String>>,
    stderr_done: AtomicBool,
    /// Set when the host killed the process, so the exit is not a failure.
    stopped: AtomicBool,
    state: Mutex<Inner>,
    wake: Condvar,
}

struct Inner {
    closed: bool,
    next_id: i64,
    replies: HashMap<i64, Option<Result<Value, RemoteError>>>,
    prompt: Option<String>,
    approvals: Vec<Waiting>,
    normalizer: Normalizer,
    transcript: Transcript,
    status: SessionStatus,
    session_id: Option<String>,
    /// The id of the agent's config option for the mode, when it has one.
    /// Claude's does, and a change through it answers with every setting as
    /// it now stands, which `session/set_mode` does not.
    mode_option: Option<String>,
    /// Requests whose replies carry the session's settings, by id. The reader
    /// takes each reply in as it arrives, so a notification sent after it is
    /// never overwritten by it.
    changing: HashMap<i64, Asked>,
    /// How many times the agent has reported its mode, so a reply to
    /// `session/set_mode`, which does not say, knows whether one came first.
    mode_reports: u64,
    events: Sender<Envelope>,
    last_seq: u64,
    noise: u64,
    /// Set when the tab stopped showing this session: nothing more is
    /// numbered or sent, so a reset tab never hears from its old agent.
    silenced: bool,
}

/// An approval the user has not answered, and the agent request it answers.
struct Waiting {
    item_id: String,
    rpc: Id,
}

enum Line {
    Send(String),
    Close,
}

/// Work for the settings thread.
enum Setting {
    Change(Change),
    Close,
}

/// One request that changes a setting.
struct Change {
    method: &'static str,
    params: Value,
    /// The mode it sets, for `session/set_mode`, whose reply does not say.
    mode: Option<String>,
    /// Its number, which `status.answered` takes once it is answered.
    ticket: u64,
}

/// A request in flight whose reply carries the session's settings.
struct Asked {
    /// The mode it sets, for `session/set_mode`, whose reply does not say.
    mode: Option<String>,
    /// `mode_reports` when it was sent.
    reports: u64,
}

impl Session {
    /// Spawn the process and its threads. The handshake waits for the first
    /// prompt.
    pub(crate) fn start(start: Start) -> Result<Self, HostError> {
        let Start {
            instance_id,
            spec,
            worktree,
            prefix,
            prior,
            seq,
            changes,
            events,
            log,
        } = start;
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .envs(spec.env.iter().map(|(k, v)| (k, v)))
            .current_dir(worktree.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (mut child, job) = job::spawn(&mut command).map_err(|e| HostError::Spawn {
            hint: (e.kind() == std::io::ErrorKind::NotFound).then_some(Hint::AdapterMissing),
            message: mask(&e.to_string()),
        })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            job::kill(&mut child, job.as_ref());
            return Err(HostError::Spawn {
                hint: None,
                message: "the agent's pipes could not be opened".to_string(),
            });
        };
        let pid = child.id();
        let (writer, lines) = mpsc::channel();
        let (settings, queued) = mpsc::channel();
        let status = SessionStatus {
            state: SessionState::Starting,
            harness: spec.harness,
            cwd: worktree.path().to_string_lossy().into_owned(),
            mode: None,
            modes: Vec::new(),
            config: Vec::new(),
            answered: changes.load(Ordering::SeqCst),
            setting_trouble: None,
            adapter_version: None,
            exit_code: None,
            hint: None,
            pending_prompt: None,
        };
        let shared = Arc::new(Shared {
            instance_id,
            worktree,
            expected_version: spec.expected_version,
            ask_first: spec.policy.ask_first,
            setting_timeout: spec.setting_timeout,
            child: Mutex::new(child),
            job,
            writer,
            settings,
            seq: Arc::clone(&seq),
            changes,
            log,
            stderr: Mutex::new(VecDeque::new()),
            stderr_done: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            state: Mutex::new(Inner {
                closed: false,
                next_id: 0,
                replies: HashMap::new(),
                prompt: None,
                approvals: Vec::new(),
                normalizer: Normalizer::new(&prefix),
                transcript: Transcript::from_items(prior),
                status,
                session_id: None,
                mode_option: None,
                changing: HashMap::new(),
                mode_reports: 0,
                events,
                last_seq: seq.load(Ordering::SeqCst),
                noise: 0,
                silenced: false,
            }),
            wake: Condvar::new(),
        });
        (shared.log)(
            Level::Info,
            &format!(
                "agent-host: {} started {:?} as pid {pid}",
                shared.instance_id, spec.harness
            ),
        );
        {
            let mut inner = shared.lock();
            let status = inner.status.clone();
            shared.emit(&mut inner, Event::Status { status });
        }
        spawn("agent-writer", move || write_lines(stdin, &lines));
        let s = Arc::clone(&shared);
        spawn("agent-reader", move || s.read(stdout));
        let s = Arc::clone(&shared);
        spawn("agent-stderr", move || s.read_stderr(stderr));
        let s = Arc::clone(&shared);
        spawn("agent-waiter", move || s.wait_for_exit());
        let s = Arc::clone(&shared);
        spawn("agent-driver", move || s.drive());
        let s = Arc::clone(&shared);
        spawn("agent-settings", move || s.change_settings(&queued));
        Ok(Self { shared })
    }

    /// Queue a prompt. One at a time: a second while the first is running is
    /// refused rather than queued, so the tab never shows a prompt that has
    /// not started.
    pub(crate) fn prompt(&self, text: &str) -> Result<(), HostError> {
        let mut inner = self.shared.lock();
        if inner.closed || inner.status.state == SessionState::Failed {
            return Err(HostError::Closed);
        }
        if inner.prompt.is_some() || inner.normalizer.turn().is_some() {
            return Err(HostError::Busy);
        }
        inner.prompt = Some(text.to_string());
        if inner.status.state == SessionState::Starting {
            inner.status.pending_prompt = Some(text.to_string());
            let status = inner.status.clone();
            self.shared.emit(&mut inner, Event::Status { status });
        }
        self.shared.wake.notify_all();
        Ok(())
    }

    /// Stop the running turn. Every open approval is answered `cancelled`.
    pub(crate) fn cancel(&self) {
        let shared = &self.shared;
        let mut inner = shared.lock();
        if inner.prompt.take().is_some() && inner.status.pending_prompt.take().is_some() {
            let status = inner.status.clone();
            shared.emit(&mut inner, Event::Status { status });
        }
        if inner.normalizer.turn().is_some() {
            if let Some(session_id) = inner.session_id.clone() {
                shared.send(wire::notification(
                    "session/cancel",
                    json!({ "sessionId": session_id }),
                ));
            }
        }
        shared.close_approvals(&mut inner, "cancelled");
    }

    /// Answer the approval `item_id` with `option_id`, which must be one the
    /// agent offered on it.
    pub(crate) fn answer(&self, item_id: &str, option_id: &str) -> Result<(), HostError> {
        let shared = &self.shared;
        let mut inner = shared.lock();
        let index = inner
            .approvals
            .iter()
            .position(|w| w.item_id == item_id)
            .ok_or(HostError::UnknownApproval)?;
        let offered = match inner.transcript.get(item_id).map(|item| &item.kind) {
            Some(ItemKind::Approval { options, .. }) => {
                options.iter().any(|o| o.option_id == option_id)
            }
            _ => false,
        };
        if !offered {
            return Err(HostError::UnknownOption);
        }
        let waiting = inner.approvals.remove(index);
        shared.send(wire::result(&waiting.rpc, selected(option_id)));
        shared.complete_approval(&mut inner, item_id, option_id);
        shared.settle(&mut inner);
        Ok(())
    }

    /// Switch the agent to `mode_id`, one of the modes its status offers.
    /// Returns the change's number once it is queued. The first status whose
    /// `answered` reaches that number shows the mode the agent settled on,
    /// which can differ from the one asked for.
    pub(crate) fn set_mode(&self, mode_id: &str) -> Result<u64, HostError> {
        let inner = self.shared.lock();
        let session_id = open(&inner)?;
        if !inner.status.modes.iter().any(|m| m.value == mode_id) {
            return Err(HostError::UnknownOption);
        }
        let change = match &inner.mode_option {
            Some(config_id) => (
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": mode_id }),
                None,
            ),
            None => (
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode_id }),
                Some(mode_id.to_string()),
            ),
        };
        Ok(self.shared.queue(&inner, change))
    }

    /// Everything drawn so far.
    pub(crate) fn attach(&self) -> Attachment {
        let inner = self.shared.lock();
        Attachment {
            status: Some(inner.status.clone()),
            items: inner.transcript.items(),
            seq: inner.last_seq,
        }
    }

    /// The items, for a session that continues this one after it died.
    pub(crate) fn items(&self) -> Vec<Item> {
        self.shared.lock().transcript.items()
    }

    /// Whether the process is still running and can take a prompt. One whose
    /// handshake failed is on its way out, so it counts as gone.
    pub(crate) fn is_alive(&self) -> bool {
        let inner = self.shared.lock();
        !inner.closed && inner.status.state != SessionState::Failed
    }

    /// Send nothing more. Every event already numbered is ahead of whatever
    /// the caller numbers next.
    pub(crate) fn silence(&self) {
        self.shared.lock().silenced = true;
    }

    /// Where it runs.
    pub(crate) fn worktree(&self) -> &Worktree {
        &self.shared.worktree
    }

    /// Kill the process and everything it started. Returns at once; the
    /// waiter reports the exit.
    pub(crate) fn kill(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.shared.send_close();
        let mut child = self.shared.child.lock().unwrap_or_else(|e| e.into_inner());
        job::kill(&mut child, self.shared.job.as_ref());
    }

    /// Wait until the process has exited, or `deadline` passes.
    pub(crate) fn wait_closed(&self, deadline: Instant) -> bool {
        let mut inner = self.shared.lock();
        while !inner.closed {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            inner = self
                .shared
                .wake
                .wait_timeout(inner, left)
                .map(|(guard, _)| guard)
                .unwrap_or_else(|e| e.into_inner().0);
        }
        true
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

impl Inner {
    /// Take in a `configOptions` list: the mode option, if there is one, and
    /// every other option as the agent now reports it.
    fn apply(&mut self, settings: Settings) {
        if let Some(mode) = settings.mode {
            self.show_mode(mode.value);
            self.status.modes = config::allowed(mode.choices);
            self.mode_option = Some(mode.id);
        }
        self.status.config = settings.options;
    }

    /// Record the mode the agent reports, but only once the handshake has
    /// confirmed ask-first: whatever the user's own default is, it is not
    /// this session's mode until then, so neither a status sent meanwhile
    /// nor a failed handshake ever shows it. A session that has failed, or
    /// whose process has exited, never had that confirmation.
    fn show_mode(&mut self, mode: String) {
        if matches!(
            self.status.state,
            SessionState::Ready | SessionState::Working | SessionState::NeedsInput
        ) {
            self.status.mode = Some(mode);
        }
    }

    /// Take in a reply that carries the settings: `session/new`'s modes and
    /// list, or a change's list. `session/set_mode` answers `{}`, so the mode
    /// it asked for is taken as set, unless the agent has reported one since.
    fn answered(&mut self, result: &Value, asked: Asked) {
        if let Some(choices) = result.get("modes").and_then(config::modes) {
            self.status.modes = config::allowed(choices);
        }
        if let Some(list) = result.get("configOptions").filter(|l| l.is_array()) {
            self.apply(config::settings(list));
        }
        if let Some(mode) = asked.mode {
            if self.mode_reports == asked.reports {
                self.status.mode = Some(mode);
            }
        }
    }
}

/// The ACP session id, for a session that is open and past its handshake.
fn open(inner: &Inner) -> Result<String, HostError> {
    if inner.closed || inner.status.state == SessionState::Failed {
        return Err(HostError::Closed);
    }
    if inner.status.state == SessionState::Starting {
        return Err(HostError::NoSession);
    }
    inner.session_id.clone().ok_or(HostError::NoSession)
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn send(&self, line: String) {
        let _ = self.writer.send(Line::Send(line));
    }

    /// Number a change and hand it to the settings thread, which sends them
    /// in the order they were numbered. Taking the lock's guard keeps two
    /// callers from numbering in one order and queueing in the other.
    fn queue(
        &self,
        _held: &Inner,
        (method, params, mode): (&'static str, Value, Option<String>),
    ) -> u64 {
        let ticket = self.changes.fetch_add(1, Ordering::SeqCst) + 1;
        let change = Change {
            method,
            params,
            mode,
            ticket,
        };
        let _ = self.settings.send(Setting::Change(change));
        ticket
    }

    fn send_close(&self) {
        let _ = self.writer.send(Line::Close);
    }

    /// Number `event`, keep it, and hand it to the emitter — all under the
    /// lock, so the order the sink sees is the order of `seq`.
    fn emit(&self, inner: &mut Inner, event: Event) {
        if inner.silenced {
            return;
        }
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        inner.transcript.apply(&event);
        inner.last_seq = seq;
        let _ = inner.events.send(Envelope {
            instance_id: self.instance_id.clone(),
            seq,
            event,
        });
    }

    fn emit_all(&self, inner: &mut Inner, events: Vec<Event>) {
        for event in events {
            self.emit(inner, event);
        }
    }

    fn set_state(&self, inner: &mut Inner, state: SessionState) {
        if inner.status.state != state {
            inner.status.state = state;
            let status = inner.status.clone();
            self.emit(inner, Event::Status { status });
        }
    }

    fn set_hint(&self, inner: &mut Inner, hint: Hint) {
        if inner.status.hint != Some(hint) {
            inner.status.hint = Some(hint);
            let status = inner.status.clone();
            self.emit(inner, Event::Status { status });
        }
    }

    /// Drop a `SignedOut` hint once the agent reports someone signed in.
    /// `AdapterVersion` stays: it holds for the life of the process.
    fn clear_signed_out(&self, inner: &mut Inner) {
        if inner.status.hint == Some(Hint::SignedOut) {
            inner.status.hint = None;
            let status = inner.status.clone();
            self.emit(inner, Event::Status { status });
        }
    }

    /// Back to `Working` once nothing is waiting on the user.
    fn settle(&self, inner: &mut Inner) {
        if inner.approvals.is_empty() && inner.normalizer.turn().is_some() && !inner.closed {
            self.set_state(inner, SessionState::Working);
        }
    }

    fn complete_approval(&self, inner: &mut Inner, item_id: &str, answer: &str) {
        let Some(mut item) = inner.transcript.get(item_id).cloned() else {
            return;
        };
        if let ItemKind::Approval { answer: slot, .. } = &mut item.kind {
            *slot = Some(answer.to_string());
        }
        self.emit(inner, Event::ItemCompleted { item });
    }

    fn close_approvals(&self, inner: &mut Inner, answer: &str) {
        for waiting in std::mem::take(&mut inner.approvals) {
            self.send(wire::result(&waiting.rpc, cancelled()));
            self.complete_approval(inner, &waiting.item_id, answer);
        }
        self.settle(inner);
    }

    // --- the driver ------------------------------------------------------

    /// The prompt stays queued through the handshake, so a second one sent
    /// meanwhile is refused as busy and a cancel can still withdraw it.
    fn drive(self: Arc<Self>) {
        let mut ready = false;
        loop {
            {
                let mut inner = self.lock();
                while inner.prompt.is_none() && !inner.closed {
                    inner = self.wake.wait(inner).unwrap_or_else(|e| e.into_inner());
                }
                if inner.closed {
                    return;
                }
            }
            if !ready {
                if let Err(failure) = self.handshake() {
                    self.fail(failure);
                    return;
                }
                ready = true;
            }
            self.turn();
        }
    }

    fn handshake(&self) -> Result<(), Failure> {
        let init = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": { "name": "kaava", "version": env!("CARGO_PKG_VERSION") }
                }),
                Some(HANDSHAKE),
            )
            .map_err(Failure::from)?;
        let version = init
            .pointer("/agentInfo/version")
            .and_then(Value::as_str)
            .map(str::to_string);
        {
            let mut inner = self.lock();
            inner.status.adapter_version = version.clone();
            if let (Some(want), Some(have)) = (self.expected_version, &version) {
                if want != have {
                    inner.status.hint = Some(Hint::AdapterVersion);
                }
            }
        }
        if let Some(version) = &version {
            (self.log)(
                Level::Info,
                &format!("agent-host: {} adapter {}", self.instance_id, mask(version)),
            );
        }
        let cwd = self.worktree.path().to_string_lossy().into_owned();
        // Its modes and settings are taken in by the reader.
        let new = self
            .send_request(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": [] }),
                carries_settings(None),
            )
            .and_then(|id| self.finish(id, "session/new", Some(HANDSHAKE)))
            .map_err(Failure::from)?;
        let session_id = new
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or(Failure::Protocol("session/new returned no sessionId"))?
            .to_string();
        self.lock().session_id = Some(session_id.clone());
        // Fail closed: a session that cannot be put in ask-first mode does not
        // run, whatever mode the user's own settings would have chosen.
        self.request(
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": self.ask_first }),
            Some(HANDSHAKE),
        )
        .map_err(|_| Failure::Protocol("the agent would not switch to ask-first mode"))?;
        let mut inner = self.lock();
        inner.status.mode = Some(self.ask_first.to_string());
        if inner.closed {
            return Ok(());
        }
        inner.status.state = SessionState::Ready;
        let status = inner.status.clone();
        self.emit(&mut inner, Event::Status { status });
        Ok(())
    }

    /// The handshake did not finish. Drawn even when the process has already
    /// exited, since that is usually why; not drawn, nor logged as a failure,
    /// when the host stopped it on purpose.
    fn fail(&self, failure: Failure) {
        let stopped = self.stopped.load(Ordering::SeqCst);
        if !stopped {
            let mut inner = self.lock();
            let hint = match &failure {
                Failure::SignedOut => Some(Hint::SignedOut),
                _ => inner.status.hint,
            };
            inner.status.hint = hint;
            if !inner.closed {
                inner.status.state = SessionState::Failed;
            }
            // The prompt was accepted and the tab cleared its draft, so it is
            // drawn before the error: the text the user typed stays on screen,
            // and Retry on the error finds it. A prompt a cancel withdrew is
            // gone and draws nothing.
            inner.status.pending_prompt = None;
            let mut events = match inner.prompt.take() {
                Some(text) => inner.normalizer.begin_turn(&text),
                None => Vec::new(),
            };
            events.extend(inner.normalizer.error(&failure.message(), hint));
            events.extend(inner.normalizer.end_turn("error"));
            self.emit_all(&mut inner, events);
            let status = inner.status.clone();
            self.emit(&mut inner, Event::Status { status });
        }
        (self.log)(
            if stopped { Level::Info } else { Level::Failure },
            &format!(
                "agent-host: {} handshake failed: {}",
                self.instance_id,
                mask(&failure.message())
            ),
        );
        self.send_close();
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        job::kill(&mut child, self.job.as_ref());
    }

    /// Run the queued prompt, if a cancel has not withdrawn it.
    fn turn(&self) {
        let (text, session_id) = {
            let mut inner = self.lock();
            if inner.closed {
                return;
            }
            let Some(text) = inner.prompt.take() else {
                return;
            };
            inner.status.pending_prompt = None;
            let events = inner.normalizer.begin_turn(&text);
            self.emit_all(&mut inner, events);
            self.set_state(&mut inner, SessionState::Working);
            (text, inner.session_id.clone().unwrap_or_default())
        };
        let reply = self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }]
            }),
            None,
        );
        let mut inner = self.lock();
        if inner.closed {
            return;
        }
        let stop_reason = match reply {
            Ok(result) => {
                // A turn that ran means the user is signed in now, whatever an
                // earlier one said.
                if inner.status.hint == Some(Hint::SignedOut) {
                    inner.status.hint = None;
                }
                result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn")
                    .to_string()
            }
            Err(e) => {
                let hint = (e.code == AUTH_REQUIRED).then_some(Hint::SignedOut);
                if let Some(hint) = hint {
                    inner.status.hint = Some(hint);
                }
                let events = inner.normalizer.error(&e.message, hint);
                self.emit_all(&mut inner, events);
                "error".to_string()
            }
        };
        self.close_approvals(&mut inner, "cancelled");
        let events = inner.normalizer.end_turn(&stop_reason);
        self.emit_all(&mut inner, events);
        inner.status.state = SessionState::Ready;
        let status = inner.status.clone();
        self.emit(&mut inner, Event::Status { status });
    }

    /// Send a request and wait for its reply. `None` waits until the reply
    /// comes or the process exits.
    fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, RemoteError> {
        let id = self.send_request(method, params, |_, _| {})?;
        self.finish(id, method, timeout)
    }

    /// Send a request with a slot for its reply. `track` notes anything else
    /// about it under the same lock, before the reply can arrive.
    fn send_request(
        &self,
        method: &str,
        params: Value,
        track: impl FnOnce(&mut Inner, i64),
    ) -> Result<i64, RemoteError> {
        let id = {
            let mut inner = self.lock();
            if inner.closed {
                return Err(closed());
            }
            inner.next_id += 1;
            let id = inner.next_id;
            inner.replies.insert(id, None);
            track(&mut inner, id);
            id
        };
        self.send(wire::request(&Id::Number(id), method, params));
        Ok(id)
    }

    /// Wait for the reply to `id`; past `timeout`, give up on it. The slot
    /// is checked and, once the time is up, dropped under one hold of the
    /// lock, so a reply cannot land between the two: it was either taken in
    /// by the reader before, and is the answer, or comes after and is
    /// ignored.
    fn finish(
        &self,
        id: i64,
        method: &str,
        timeout: Option<Duration>,
    ) -> Result<Value, RemoteError> {
        let deadline = timeout.map(|t| Instant::now() + t);
        self.await_reply(id, deadline, |inner| {
            inner.changing.remove(&id);
            inner.replies.remove(&id);
        })
        .unwrap_or_else(|| Err(timed_out(method)))
    }

    /// Wait for the reply to `id` until `deadline`. `None` if it passes
    /// first, after `give_up` has run under the hold of the lock that found
    /// no reply; without one the slot stays, and can still be waited for.
    fn await_reply(
        &self,
        id: i64,
        deadline: Option<Instant>,
        give_up: impl FnOnce(&mut Inner),
    ) -> Option<Result<Value, RemoteError>> {
        let mut inner = self.lock();
        loop {
            if let Some(Some(_)) = inner.replies.get(&id) {
                let reply = inner.replies.remove(&id).flatten();
                return Some(reply.unwrap_or_else(|| Err(closed())));
            }
            inner = match deadline {
                None => self.wake.wait(inner).unwrap_or_else(|e| e.into_inner()),
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        give_up(&mut inner);
                        return None;
                    }
                    self.wake
                        .wait_timeout(inner, left)
                        .map(|(guard, _)| guard)
                        .unwrap_or_else(|e| e.into_inner().0)
                }
            };
        }
    }

    // --- the settings thread ---------------------------------------------

    /// Send each change and wait for its reply before the next, so two quick
    /// changes land in the order they were made. The reader takes the reply's
    /// settings in; this ends in a status whose `answered` counts the change,
    /// so the tab knows its choice was answered, and whose `setting_trouble`
    /// holds a refusal. A change with no reply within the spec's
    /// `setting_timeout` is reported as unanswered, and still waited for, so
    /// a late reply is taken in and the next change never overtakes it.
    fn change_settings(self: Arc<Self>, changes: &Receiver<Setting>) {
        for setting in changes {
            let Setting::Change(change) = setting else {
                return;
            };
            let Change {
                method,
                params,
                mode,
                ticket,
            } = change;
            let Ok(id) = self.send_request(method, params, carries_settings(mode)) else {
                return;
            };
            let deadline = Instant::now() + self.setting_timeout;
            let mut reply = self.await_reply(id, Some(deadline), |_| {});
            if reply.is_none() {
                if !self.report(Some(SettingTrouble::Unanswered { ticket }), None) {
                    return;
                }
                reply = self.await_reply(id, None, |_| {});
            }
            let trouble = match reply.unwrap_or_else(|| Err(closed())) {
                Ok(_) => None,
                Err(e) => Some(SettingTrouble::Refused {
                    ticket,
                    message: refusal_reason(&e.message),
                }),
            };
            if !self.report(trouble, Some(ticket)) {
                return;
            }
        }
    }

    /// Emit the status with `trouble`, and with the number of the change it
    /// answers, if it does. False once the session has closed.
    fn report(&self, trouble: Option<SettingTrouble>, answered: Option<u64>) -> bool {
        let mut inner = self.lock();
        if inner.closed {
            return false;
        }
        inner.status.setting_trouble = trouble;
        if let Some(ticket) = answered {
            inner.status.answered = ticket;
        }
        let status = inner.status.clone();
        self.emit(&mut inner, Event::Status { status });
        true
    }

    // --- the reader ------------------------------------------------------

    fn read(self: Arc<Self>, stdout: impl Read) {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            match read_line_capped(&mut reader, &mut buf, MESSAGE_LIMIT) {
                Ok(None) | Err(_) => return,
                Ok(Some(true)) => self.lock().noise += 1,
                Ok(Some(false)) => self.on_line(&String::from_utf8_lossy(&buf)),
            }
        }
    }

    fn on_line(&self, line: &str) {
        match wire::parse(line) {
            None => self.lock().noise += 1,
            Some(Incoming::Response { id, outcome }) => {
                let Id::Number(n) = id else { return };
                let mut inner = self.lock();
                if let Some(asked) = inner.changing.remove(&n) {
                    if let Ok(result) = &outcome {
                        inner.answered(result, asked);
                    }
                }
                if let Some(slot) = inner.replies.get_mut(&n) {
                    *slot = Some(outcome);
                    self.wake.notify_all();
                }
            }
            Some(Incoming::Request { id, method, params }) => {
                if method == "session/request_permission" {
                    self.permission(id, &params);
                } else {
                    // We declared no file system and no terminal; anything
                    // else the agent asks for is not ours to do.
                    self.send(wire::error(
                        &id,
                        METHOD_NOT_FOUND,
                        "not supported by this client",
                    ));
                }
            }
            Some(Incoming::Notification { method, params }) => match method.as_str() {
                "session/update" => {
                    let mut inner = self.lock();
                    if inner.closed {
                        return;
                    }
                    let update = params.get("update").unwrap_or(&Value::Null);
                    let events = inner.normalizer.update(update);
                    self.emit_all(&mut inner, events);
                    let mode = inner.normalizer.take_mode();
                    let settings = inner.normalizer.take_settings();
                    if mode.is_none() && settings.is_none() {
                        return;
                    }
                    if let Some(mode) = mode {
                        inner.show_mode(mode);
                        inner.mode_reports += 1;
                    }
                    if let Some(settings) = settings {
                        if settings.mode.is_some() {
                            inner.mode_reports += 1;
                        }
                        inner.apply(settings);
                    }
                    // During the handshake, the status it ends with carries
                    // these; one per update would only flicker.
                    if inner.status.state != SessionState::Starting {
                        let status = inner.status.clone();
                        self.emit(&mut inner, Event::Status { status });
                    }
                }
                "$/cancel_request" => {
                    let Some(rpc) = params
                        .get("requestId")
                        .and_then(|id| serde_json::from_value::<Id>(id.clone()).ok())
                    else {
                        return;
                    };
                    let mut inner = self.lock();
                    if let Some(index) = inner.approvals.iter().position(|w| w.rpc == rpc) {
                        let waiting = inner.approvals.remove(index);
                        self.complete_approval(&mut inner, &waiting.item_id, "cancelled");
                        self.settle(&mut inner);
                    }
                }
                // Only whether anyone is signed in. The rest of the payload —
                // the account's email and organization — is never read.
                "_auth/status_update" => {
                    let kind = params.pointer("/authStatus/kind").and_then(Value::as_str);
                    let mut inner = self.lock();
                    match kind {
                        Some("none") => self.set_hint(&mut inner, Hint::SignedOut),
                        Some(_) => self.clear_signed_out(&mut inner),
                        None => {}
                    }
                }
                _ => {}
            },
        }
    }

    fn permission(&self, rpc: Id, params: &Value) {
        let call = params.get("toolCall").unwrap_or(&Value::Null);
        let named = request_paths(call);
        let escapes = outside(&self.worktree, &named);
        let paths = named.iter().map(|p| self.worktree.display(p)).collect();
        let mut inner = self.lock();
        if inner.closed {
            return;
        }
        if inner.approvals.len() >= MAX_PENDING_APPROVALS {
            // A flood of requests nobody answered: refuse the extra ones
            // rather than hold one more card and one more reply slot each.
            inner.normalizer.drop_one();
            self.send(wire::result(&rpc, cancelled()));
            return;
        }
        let events = inner.normalizer.close_text();
        self.emit_all(&mut inner, events);
        let mut item = inner.normalizer.approval(params, paths);
        if !escapes.is_empty() {
            // Refused without asking: no choice the user could make here is
            // one the host will honour.
            let reject = params
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|o| {
                    o.get("kind")
                        .and_then(Value::as_str)
                        .is_some_and(|k| k.starts_with("reject"))
                })
                .and_then(|o| o.get("optionId").and_then(Value::as_str));
            self.send(wire::result(
                &rpc,
                reject.map(selected).unwrap_or_else(cancelled),
            ));
            if let ItemKind::Approval { answer, .. } = &mut item.kind {
                *answer = Some("outside".to_string());
            }
            self.emit(&mut inner, Event::ItemCompleted { item });
            let events = inner
                .normalizer
                .error(&escapes.join("\n"), Some(Hint::OutsideWorktree));
            self.emit_all(&mut inner, events);
            return;
        }
        let item_id = item.id.clone();
        self.emit(&mut inner, Event::ItemStarted { item });
        inner.approvals.push(Waiting { item_id, rpc });
        self.set_state(&mut inner, SessionState::NeedsInput);
    }

    // --- stderr and exit -------------------------------------------------

    fn read_stderr(self: Arc<Self>, stderr: impl Read) {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            match read_line_capped(&mut reader, &mut buf, STDERR_LINE) {
                Ok(None) | Err(_) => break,
                Ok(Some(_)) => {
                    let line = mask(String::from_utf8_lossy(&buf).trim_end());
                    let mut tail = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
                    if tail.len() == STDERR_TAIL {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            }
        }
        self.stderr_done.store(true, Ordering::SeqCst);
    }

    fn wait_for_exit(self: Arc<Self>) {
        let code = loop {
            let polled = self
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .try_wait();
            match polled {
                Ok(Some(status)) => break status.code(),
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break None,
            }
        };
        let (dropped, noise, ready) = {
            let mut inner = self.lock();
            inner.closed = true;
            // Nothing is left to answer a change, or to change.
            inner.status.setting_trouble = None;
            for slot in inner.replies.values_mut() {
                if slot.is_none() {
                    *slot = Some(Err(closed()));
                }
            }
            for waiting in std::mem::take(&mut inner.approvals) {
                self.complete_approval(&mut inner, &waiting.item_id, "cancelled");
            }
            let events = inner.normalizer.end_turn("error");
            self.emit_all(&mut inner, events);
            let ready = inner.status.state != SessionState::Starting
                && inner.status.state != SessionState::Failed;
            if inner.status.state != SessionState::Failed {
                inner.status.state = if ready {
                    SessionState::Stopped
                } else {
                    SessionState::Failed
                };
            }
            inner.status.exit_code = code;
            let status = inner.status.clone();
            self.emit(&mut inner, Event::Status { status });
            self.wake.notify_all();
            let _ = self.settings.send(Setting::Close);
            (inner.normalizer.dropped(), inner.noise, ready)
        };
        let code_text = code.map_or("none".to_string(), |c| c.to_string());
        let failed = !self.stopped.load(Ordering::SeqCst) && (code != Some(0) || !ready);
        let level = if failed { Level::Failure } else { Level::Info };
        (self.log)(
            level,
            &format!(
                "agent-host: {} exited with code {code_text}; {dropped} updates dropped, {noise} non-protocol lines",
                self.instance_id
            ),
        );
        if failed {
            // Give stderr a moment to reach its end, so the tail is the last
            // thing the agent said rather than whatever had arrived.
            let until = Instant::now() + Duration::from_millis(300);
            while !self.stderr_done.load(Ordering::SeqCst) && Instant::now() < until {
                thread::sleep(Duration::from_millis(10));
            }
            let tail = self
                .stderr
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            for line in tail {
                (self.log)(
                    Level::Failure,
                    &format!("agent-host: {} stderr: {line}", self.instance_id),
                );
            }
        }
    }
}

/// Why the handshake did not finish.
enum Failure {
    SignedOut,
    Remote(RemoteError),
    Protocol(&'static str),
}

impl From<RemoteError> for Failure {
    fn from(e: RemoteError) -> Self {
        if e.code == AUTH_REQUIRED {
            Failure::SignedOut
        } else {
            Failure::Remote(e)
        }
    }
}

impl Failure {
    fn message(&self) -> String {
        match self {
            Failure::SignedOut => "authentication required".to_string(),
            Failure::Remote(e) => e.message.clone(),
            Failure::Protocol(m) => (*m).to_string(),
        }
    }
}

fn selected(option_id: &str) -> Value {
    json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
}

fn cancelled() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

fn closed() -> RemoteError {
    RemoteError {
        code: CLOSED,
        message: "the agent exited".to_string(),
    }
}

fn timed_out(method: &str) -> RemoteError {
    RemoteError {
        code: TIMED_OUT,
        message: format!("{method} got no reply"),
    }
}

/// An agent's reason for refusing a change, as it is stored and sent with
/// every status: its first line, masked, and cut to [`REFUSAL_REASON`]
/// characters with an ellipsis.
fn refusal_reason(message: &str) -> String {
    let line = message
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let line = mask(line);
    match line.char_indices().nth(REFUSAL_REASON) {
        Some((end, _)) => format!("{}…", line[..end].trim_end()),
        None => line,
    }
}

/// Mark a request as one whose reply carries the settings, for the reader to
/// take in. `mode` is the mode a `session/set_mode` sets.
fn carries_settings(mode: Option<String>) -> impl FnOnce(&mut Inner, i64) {
    move |inner, id| {
        let reports = inner.mode_reports;
        inner.changing.insert(id, Asked { mode, reports });
    }
}

/// Read one line into `buf`, keeping at most `limit` bytes of it and reading
/// past the rest. `None` at the end of the stream; otherwise whether the line
/// was cut.
fn read_line_capped(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<Option<bool>> {
    buf.clear();
    let mut cut = false;
    let mut any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return Ok(any.then_some(cut));
        }
        any = true;
        let end = available.iter().position(|&b| b == b'\n');
        let used = end.map_or(available.len(), |i| i + 1);
        let room = limit.saturating_sub(buf.len());
        cut |= used > room;
        buf.extend_from_slice(&available[..used.min(room)]);
        reader.consume(used);
        if end.is_some() {
            return Ok(Some(cut));
        }
    }
}

fn write_lines(mut stdin: ChildStdin, lines: &Receiver<Line>) {
    for line in lines {
        match line {
            Line::Send(text) => {
                let written = stdin
                    .write_all(text.as_bytes())
                    .and_then(|()| stdin.write_all(b"\n"))
                    .and_then(|()| stdin.flush());
                if written.is_err() {
                    return;
                }
            }
            Line::Close => return,
        }
    }
}

fn spawn(name: &str, work: impl FnOnce() + Send + 'static) {
    // A thread that cannot start leaves the session without that part; the
    // waiter or the reader still ends it, and the process is killed on drop.
    let _ = thread::Builder::new().name(name.to_string()).spawn(work);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_reason_is_one_masked_line_of_bounded_length() {
        assert_eq!(refusal_reason("Internal error: no"), "Internal error: no");
        assert_eq!(refusal_reason(""), "");
        // The first line only, so a stack stays out of every status.
        assert_eq!(
            refusal_reason("\n  Invalid Mode: plan\n    at run (agent.js:1)\n"),
            "Invalid Mode: plan"
        );
        assert_eq!(
            refusal_reason("bad key sk-abcdefghijklmnopqrstuvwxyz"),
            "bad key <redacted>"
        );
        // Cut on a character boundary, however wide the characters are.
        let long = "é".repeat(REFUSAL_REASON + 50);
        let cut = refusal_reason(&long);
        assert_eq!(cut.chars().count(), REFUSAL_REASON + 1);
        assert!(cut.ends_with('…'));
        // Exactly the limit is kept whole.
        let exact = "x".repeat(REFUSAL_REASON);
        assert_eq!(refusal_reason(&exact), exact);
    }

    #[test]
    fn a_long_line_is_cut_and_the_next_one_is_whole() {
        let mut reader = BufReader::with_capacity(4, "abcdefgh\nxy\nz".as_bytes());
        let mut buf = Vec::new();
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 5).unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"abcde");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 5).unwrap(),
            Some(false)
        );
        assert_eq!(buf, b"xy\n");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 5).unwrap(),
            Some(false)
        );
        assert_eq!(buf, b"z");
        assert_eq!(read_line_capped(&mut reader, &mut buf, 5).unwrap(), None);
    }

    fn inner() -> Inner {
        let (events, _) = mpsc::channel();
        Inner {
            closed: false,
            next_id: 0,
            replies: HashMap::new(),
            prompt: None,
            approvals: Vec::new(),
            normalizer: Normalizer::new("t"),
            transcript: Transcript::from_items(Vec::new()),
            status: SessionStatus {
                state: SessionState::Starting,
                harness: crate::harness::Harness::Claude,
                cwd: String::new(),
                mode: None,
                modes: Vec::new(),
                config: Vec::new(),
                answered: 0,
                setting_trouble: None,
                adapter_version: None,
                exit_code: None,
                hint: None,
                pending_prompt: None,
            },
            session_id: None,
            mode_option: None,
            changing: HashMap::new(),
            mode_reports: 0,
            events,
            last_seq: 0,
            noise: 0,
            silenced: false,
        }
    }

    #[test]
    fn a_mode_is_shown_only_once_ask_first_is_confirmed() {
        for (state, shown) in [
            (SessionState::Starting, false),
            (SessionState::Failed, false),
            (SessionState::Stopped, false),
            (SessionState::Ready, true),
            (SessionState::Working, true),
            (SessionState::NeedsInput, true),
        ] {
            let mut inner = inner();
            inner.status.state = state;
            inner.show_mode("auto".to_string());
            assert_eq!(
                inner.status.mode.is_some(),
                shown,
                "the user's own mode, in {state:?}"
            );
        }
    }
}
