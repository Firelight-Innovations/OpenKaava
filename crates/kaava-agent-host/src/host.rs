//! Every agent tab's session, by the tab's instance id.
//!
//! The map's lock is held for lookups, inserts and removals only. Spawning a
//! process happens outside it, and so does every kill: a session leaving the
//! map is handed to a thread of its own that kills it and waits, so closing a
//! tab never waits on an agent that is slow to die.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use crate::event::{Attachment, Envelope, Event, Hint, Item};
use crate::guard::{NotAWorktree, Worktree};
use crate::harness::{Harness, LaunchSpec, Protocol};
use crate::session::{Level, Log, Session, Sink, Start};

/// How long a retired session gets to exit before its thread gives up
/// waiting. It has already been killed; this only bounds the wait.
const RETIRE_WAIT: Duration = Duration::from_secs(3);

/// One harness's session, as the host drives it — the part of handoff §3.2's
/// adapter trait this slice uses. [`Session`] implements it over ACP, for
/// every harness whose descriptor says [`Protocol::Acp`]; a harness that
/// speaks something else gets a type of its own that translates.
/// `capabilities`, `resume`, `fork`, `steer`, `set_model` and `list_commands`
/// arrive with the features that need them.
pub trait Adapter: Send + Sync {
    /// Which harness it runs.
    fn harness(&self) -> Harness;
    /// Start a turn with `text`.
    fn prompt(&self, text: &str) -> Result<(), HostError>;
    /// Stop the running turn.
    fn abort(&self);
    /// Answer an approval with one of the options it offered.
    fn answer_approval(&self, item_id: &str, option_id: &str) -> Result<(), HostError>;
    /// Switch to one of the modes the status offers. Returns the change's
    /// number, which the status's `answered` reaches once it is answered.
    fn set_mode(&self, mode_id: &str) -> Result<u64, HostError>;
    /// Set one of the status's other options to one of its choices. Returns
    /// the change's number, as `set_mode` does.
    fn set_config(&self, config_id: &str, value: &str) -> Result<u64, HostError>;
    /// Kill the process. Returns at once.
    fn shutdown(&self);
    /// Wait for the process to have exited, up to `deadline`.
    fn wait_closed(&self, deadline: Instant) -> bool;
    /// Everything drawn so far.
    fn attach(&self) -> Attachment;
    /// The items, for a session that continues this one.
    fn items(&self) -> Vec<Item>;
    /// Whether the process is still running.
    fn is_alive(&self) -> bool;
    /// Where it runs.
    fn worktree(&self) -> &Worktree;
    /// Send no more events. For a session its tab no longer shows.
    fn silence(&self);
}

impl Adapter for Session {
    fn harness(&self) -> Harness {
        Session::harness(self)
    }
    fn prompt(&self, text: &str) -> Result<(), HostError> {
        Session::prompt(self, text)
    }
    fn abort(&self) {
        self.cancel();
    }
    fn answer_approval(&self, item_id: &str, option_id: &str) -> Result<(), HostError> {
        self.answer(item_id, option_id)
    }
    fn set_mode(&self, mode_id: &str) -> Result<u64, HostError> {
        Session::set_mode(self, mode_id)
    }
    fn set_config(&self, config_id: &str, value: &str) -> Result<u64, HostError> {
        Session::set_config(self, config_id, value)
    }
    fn shutdown(&self) {
        self.kill();
    }
    fn wait_closed(&self, deadline: Instant) -> bool {
        Session::wait_closed(self, deadline)
    }
    fn attach(&self) -> Attachment {
        Session::attach(self)
    }
    fn items(&self) -> Vec<Item> {
        Session::items(self)
    }
    fn is_alive(&self) -> bool {
        Session::is_alive(self)
    }
    fn worktree(&self) -> &Worktree {
        Session::worktree(self)
    }
    fn silence(&self) {
        Session::silence(self);
    }
}

/// Why the host refused. [`HostError::code`] is what crosses to the tab, which
/// words it from `strings.ts`.
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// A turn is running, or a prompt is waiting to start one.
    #[error("a turn is already running")]
    Busy,
    /// The process has exited.
    #[error("this session has ended")]
    Closed,
    /// No session in this tab.
    #[error("no agent is running in this tab")]
    NoSession,
    /// The tab's session runs in a different worktree from the one asked for.
    #[error("this session runs in another worktree")]
    WrongWorktree,
    /// No approval with that id is waiting.
    #[error("no such approval is waiting")]
    UnknownApproval,
    /// The option is not one the approval or the mode list offered.
    #[error("that is not one of the offered choices")]
    UnknownOption,
    /// The process could not be started.
    #[error("the agent could not be started: {message}")]
    Spawn {
        /// A known cause, if there is one.
        hint: Option<Hint>,
        /// What the OS said, masked.
        message: String,
    },
    /// The directory is not a linked worktree.
    #[error(transparent)]
    NotAWorktree(#[from] NotAWorktree),
}

impl HostError {
    /// A stable code for the error.
    pub fn code(&self) -> &'static str {
        match self {
            HostError::Busy => "busy",
            HostError::Closed => "closed",
            HostError::NoSession => "noSession",
            HostError::WrongWorktree => "wrongWorktree",
            HostError::UnknownApproval => "unknownApproval",
            HostError::UnknownOption => "unknownOption",
            HostError::Spawn { .. } => "spawn",
            HostError::NotAWorktree(NotAWorktree::MainCheckout(_)) => "mainCheckout",
            HostError::NotAWorktree(_) => "notAWorktree",
        }
    }

    /// A cause the tab can explain, if there is one.
    pub fn hint(&self) -> Option<Hint> {
        match self {
            HostError::Spawn { hint, .. } => *hint,
            _ => None,
        }
    }
}

/// The host.
pub struct AgentHost {
    sessions: Mutex<HashMap<String, Arc<dyn Adapter>>>,
    /// Held across a whole send, so two sends to a tab with no session start
    /// one between them rather than one each.
    sending: Mutex<()>,
    seq: Arc<AtomicU64>,
    /// The last number given to a setting change, across every session.
    changes: Arc<AtomicU64>,
    generation: AtomicU64,
    events: Mutex<mpsc::Sender<Envelope>>,
    log: Log,
}

impl AgentHost {
    /// A host sending every envelope to `sink`, from one thread of its own,
    /// in the order they were numbered.
    pub fn new(sink: Sink, log: Log) -> Self {
        let (events, envelopes) = mpsc::channel::<Envelope>();
        let _ = thread::Builder::new()
            .name("agent-emitter".to_string())
            .spawn(move || {
                for envelope in envelopes {
                    sink(envelope);
                }
            });
        Self {
            sessions: Mutex::new(HashMap::new()),
            sending: Mutex::new(()),
            seq: Arc::new(AtomicU64::new(0)),
            changes: Arc::new(AtomicU64::new(0)),
            generation: AtomicU64::new(0),
            events: Mutex::new(events),
            log,
        }
    }

    fn map(&self) -> MutexGuard<'_, HashMap<String, Arc<dyn Adapter>>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, instance_id: &str) -> Option<Arc<dyn Adapter>> {
        self.map().get(instance_id).cloned()
    }

    /// Send `text` to the tab's session, starting one in `worktree` first if
    /// it has none or its last one has exited. A session that exited hands its
    /// items to the next, so the tab's conversation carries on.
    pub fn send(
        &self,
        instance_id: &str,
        spec: LaunchSpec,
        worktree: Worktree,
        text: &str,
    ) -> Result<(), HostError> {
        let _one_at_a_time = self.sending.lock().unwrap_or_else(|e| e.into_inner());
        let existing = self.get(instance_id);
        if let Some(session) = &existing {
            if session.is_alive() {
                if session.worktree() != &worktree {
                    return Err(HostError::WrongWorktree);
                }
                return session.prompt(text);
            }
        }
        let prior = existing.map(|s| s.items()).unwrap_or_default();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let events = self
            .events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let start = Start {
            instance_id: instance_id.to_string(),
            prefix: format!("s{generation}"),
            spec,
            worktree,
            prior,
            seq: Arc::clone(&self.seq),
            changes: Arc::clone(&self.changes),
            events,
            log: Arc::clone(&self.log),
        };
        let session: Arc<dyn Adapter> = match start.spec.harness.descriptor().protocol {
            Protocol::Acp => Arc::new(Session::start(start)?),
        };
        let replaced = self
            .map()
            .insert(instance_id.to_string(), Arc::clone(&session));
        if let Some(old) = replaced {
            retire(old);
        }
        session.prompt(text)
    }

    /// Everything the tab should draw, and the `seq` live events pick up after.
    pub fn attach(&self, instance_id: &str) -> Attachment {
        match self.get(instance_id) {
            Some(session) => session.attach(),
            None => Attachment {
                status: None,
                items: Vec::new(),
                seq: self.seq.load(Ordering::SeqCst),
            },
        }
    }

    /// Stop the tab's running turn.
    pub fn cancel(&self, instance_id: &str) -> Result<(), HostError> {
        self.get(instance_id).ok_or(HostError::NoSession)?.abort();
        Ok(())
    }

    /// Answer an approval in the tab's session.
    pub fn answer(
        &self,
        instance_id: &str,
        item_id: &str,
        option_id: &str,
    ) -> Result<(), HostError> {
        self.get(instance_id)
            .ok_or(HostError::NoSession)?
            .answer_approval(item_id, option_id)
    }

    /// Switch the tab's session to another of its modes. Returns the
    /// change's number (see [`crate::SessionStatus::answered`]).
    pub fn set_mode(&self, instance_id: &str, mode_id: &str) -> Result<u64, HostError> {
        self.get(instance_id)
            .ok_or(HostError::NoSession)?
            .set_mode(mode_id)
    }

    /// Set one of the tab's session settings other than the mode, such as
    /// the model or effort: any option the status lists, to a value it
    /// offers. Returns the change's number, as [`AgentHost::set_mode`] does.
    pub fn set_config(
        &self,
        instance_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<u64, HostError> {
        self.get(instance_id)
            .ok_or(HostError::NoSession)?
            .set_config(config_id, value)
    }

    /// Kill the tab's agent, keeping its conversation: the next prompt starts
    /// a new process that carries on from it.
    pub fn stop(&self, instance_id: &str) {
        if let Some(session) = self.get(instance_id) {
            session.shutdown();
        }
    }

    /// Kill the tab's agent and forget its conversation.
    pub fn reset(&self, instance_id: &str) {
        let removed = self.map().remove(instance_id);
        if let Some(session) = removed {
            retire(session);
        }
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self
            .events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send(Envelope {
                instance_id: instance_id.to_string(),
                seq,
                event: Event::Reset,
            });
    }

    /// The worktree the tab's session runs in, if it has one.
    pub fn worktree(&self, instance_id: &str) -> Option<Worktree> {
        self.get(instance_id).map(|s| s.worktree().clone())
    }

    /// The harness the tab's agent runs, while its process lives. A prompt
    /// goes to that agent, whatever harness the tab has chosen since.
    pub fn running(&self, instance_id: &str) -> Option<Harness> {
        self.get(instance_id)
            .filter(|s| s.is_alive())
            .map(|s| s.harness())
    }

    /// Kill every session whose tab `keep` does not name. Returns at once.
    pub fn retain(&self, keep: impl Fn(&str) -> bool) {
        let gone: Vec<Arc<dyn Adapter>> = {
            let mut map = self.map();
            let ids: Vec<String> = map.keys().filter(|id| !keep(id)).cloned().collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for session in gone {
            (self.log)(Level::Info, "agent-host: a closed tab's agent was stopped");
            retire(session);
        }
    }

    /// Kill every session and wait for them, all against one deadline. For
    /// the app's exit.
    pub fn stop_all(&self, wait: Duration) {
        let all: Vec<Arc<dyn Adapter>> = self.map().drain().map(|(_, s)| s).collect();
        for session in &all {
            session.shutdown();
        }
        let deadline = Instant::now() + wait;
        for session in &all {
            session.wait_closed(deadline);
        }
    }
}

impl Drop for AgentHost {
    fn drop(&mut self) {
        self.stop_all(RETIRE_WAIT);
    }
}

/// Silence `session` now, then kill it and wait for it on a thread of its
/// own.
fn retire(session: Arc<dyn Adapter>) {
    session.silence();
    let _ = thread::Builder::new()
        .name("agent-retire".to_string())
        .spawn(move || {
            session.shutdown();
            session.wait_closed(Instant::now() + RETIRE_WAIT);
        });
}
