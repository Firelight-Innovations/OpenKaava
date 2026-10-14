//! The normalized event model every harness is translated into (handoff §3.1).
//!
//! Codex's shape: a **thread** is a session, a **turn** is one prompt's worth of
//! work, and an **item** is one thing said or done inside a turn. An item
//! arrives as `itemStarted`, then any number of `itemDelta` (text appended) or
//! `itemUpdated` (the whole item again), then `itemCompleted` — and the
//! completed item always carries its whole final state, so the host keeps
//! items rather than events (see `transcript.rs`).
//!
//! These types are the only definition. The agent tab's TypeScript is generated
//! from them into `apps/agent-tab/ui/src/protocol.generated.ts`, and the test at
//! the bottom of this file fails when the two disagree.

use serde::{Deserialize, Serialize};

use crate::harness::Harness;

/// One event, addressed to one agent tab and numbered within it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    /// The agent tab's instance id: which tab this belongs to.
    pub instance_id: String,
    /// Strictly increasing within a tab, across its sessions. A tab that
    /// attached at `seq = n` drops every live event at or below `n`.
    pub seq: u64,
    /// What happened.
    pub event: Event,
}

/// Something the agent tab draws.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    /// The session's state changed; the whole status, not a diff.
    Status {
        /// The new status.
        status: SessionStatus,
    },
    /// A prompt started a turn.
    TurnStarted {
        /// Unique within the session.
        turn_id: String,
    },
    /// A turn ended. `stop_reason` is ACP's (`end_turn`, `cancelled`,
    /// `max_tokens`, `refusal`, ...) or `error` when the prompt failed.
    TurnCompleted {
        /// The turn that ended.
        turn_id: String,
        /// Why it ended.
        stop_reason: String,
    },
    /// An item appeared.
    ItemStarted {
        /// Its state so far.
        item: Item,
    },
    /// Text was appended to an open text or reasoning item.
    ItemDelta {
        /// The item that grew.
        item_id: String,
        /// The text to append.
        text: String,
    },
    /// An open item changed; this is its whole new state.
    ItemUpdated {
        /// The item, replaced.
        item: Item,
    },
    /// An item is finished; this is its whole final state.
    ItemCompleted {
        /// The item, replaced and closed.
        item: Item,
    },
    /// The user started a new session: drop every item drawn so far.
    Reset,
}

/// One entry in the transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Unique within the session. Minted by the host, never by the agent.
    pub id: String,
    /// The turn this item belongs to.
    pub turn_id: String,
    /// What kind of item, and its content.
    pub kind: ItemKind,
}

/// The kinds of item in handoff §2.2 this slice draws.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ItemKind {
    /// What the user sent.
    UserMessage {
        /// The prompt text.
        text: String,
    },
    /// The agent's answer, as Markdown.
    AssistantText {
        /// Markdown.
        text: String,
    },
    /// The agent's visible thinking.
    Reasoning {
        /// Plain text.
        text: String,
    },
    /// A tool the agent ran or wants to run.
    ToolCall {
        /// The agent's one-line summary of the call.
        title: String,
        /// ACP's tool kind: `read`, `edit`, `execute`, `search`, ...
        tool_kind: String,
        /// Where the call is.
        status: ToolStatus,
        /// Text output, cut at [`crate::normalize::OUTPUT_LIMIT`] bytes.
        output: String,
        /// Whether `output` was cut.
        truncated: bool,
        /// Files the call reads or changes.
        paths: Vec<String>,
        /// The changes it makes, when it edits files.
        diffs: Vec<FileDiff>,
    },
    /// The agent is waiting for the user to allow or deny something. The turn
    /// is paused until this completes.
    Approval {
        /// What the agent wants to do.
        title: String,
        /// The tool call this is about, when the agent named one.
        tool_call_id: Option<String>,
        /// The exact command, or what the agent says the call is for, in full.
        detail: Option<String>,
        /// Every file the request names, resolved against the worktree.
        paths: Vec<String>,
        /// The changes it would make, when it edits files.
        diffs: Vec<FileDiff>,
        /// The choices the agent offered, in its order. `allow_always` is left
        /// out of a request that names no file: there is nothing to scope it to.
        options: Vec<ApprovalOption>,
        /// The chosen option's id, `cancelled`, `outside` (refused by the host
        /// because a path left the worktree), or `None` while waiting.
        answer: Option<String>,
    },
    /// The agent's plan, replaced in place as it changes.
    Plan {
        /// The steps.
        entries: Vec<PlanEntry>,
    },
    /// Context use at the end of a turn.
    Usage {
        /// Tokens in the context window now.
        used: u64,
        /// The window's size.
        size: u64,
    },
    /// Something failed.
    Error {
        /// What failed, with token- and email-shaped strings masked.
        message: String,
        /// A known cause the agent tab can explain, if there is one.
        hint: Option<Hint>,
    },
}

/// A tool call's progress, as ACP reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    /// Not started; may be waiting for approval.
    Pending,
    /// Running.
    InProgress,
    /// Finished.
    Completed,
    /// Finished with an error, or denied.
    Failed,
}

/// One file's change, as the agent describes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// The file, as the agent named it.
    pub path: String,
    /// Its text before, or `None` for a new file.
    pub old_text: Option<String>,
    /// Its text after.
    pub new_text: String,
    /// One side was over [`crate::normalize::DIFF_LIMIT`] bytes, so both
    /// texts were dropped and only the path is kept.
    pub too_large: bool,
}

/// One choice on an approval card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOption {
    /// What to send back to choose it.
    pub option_id: String,
    /// ACP's kind: `allow_once`, `allow_always`, `reject_once` or
    /// `reject_always`. Decides the button's style, not its label.
    pub kind: String,
    /// The agent's own label, shown as it is: only the agent knows what, say,
    /// its "always" saves to.
    pub name: String,
}

/// One step of a plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    /// What the step is.
    pub content: String,
    /// `pending`, `in_progress` or `completed`, as ACP sends it.
    pub status: String,
    /// `high`, `medium` or `low`, as ACP sends it.
    pub priority: String,
}

/// Where a session is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// The process is starting and the session is being opened.
    Starting,
    /// Idle and ready for a prompt.
    Ready,
    /// A turn is running.
    Working,
    /// A turn is paused on an approval.
    NeedsInput,
    /// The process has exited. The next prompt starts a new one.
    Stopped,
    /// The process could not be started or the session could not be opened.
    Failed,
}

/// A cause the agent tab can explain in a sentence. `strings.ts` holds the
/// sentences; these are only the keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Hint {
    /// No `claude` on PATH.
    ClaudeMissing,
    /// No Claude ACP adapter on PATH.
    AdapterMissing,
    /// The harness reports nobody signed in.
    SignedOut,
    /// The adapter is not the version this build was tested with.
    AdapterVersion,
    /// A request named a file outside the worktree, and the host refused it.
    OutsideWorktree,
}

/// What `agent-tab/attach` answers: everything drawn so far, and where the
/// live stream picks up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// The session's status, or `None` before the first prompt.
    pub status: Option<SessionStatus>,
    /// Every item, each in its latest state, oldest first.
    pub items: Vec<Item>,
    /// The last sequence number these reflect. Live envelopes at or below it
    /// are already in `items`.
    pub seq: u64,
}

/// Whether a harness can start here, and if not, why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HarnessInfo {
    /// Which harness.
    pub harness: Harness,
    /// Why it cannot start, or `None` when it can.
    pub hint: Option<Hint>,
}

/// A session's whole status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    /// Where it is.
    pub state: SessionState,
    /// Which harness.
    pub harness: Harness,
    /// The working directory: the cluster's worktree.
    pub cwd: String,
    /// The agent's current mode id (Claude: `default` is ask-before-acting).
    pub mode: Option<String>,
    /// The adapter's own version, as it reported it at `initialize`.
    pub adapter_version: Option<String>,
    /// The process's exit code, once it has exited. Never its output: what an
    /// adapter prints on stderr goes to the log, masked, and nowhere else.
    pub exit_code: Option<i32>,
    /// A known cause, if there is one.
    pub hint: Option<Hint>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_rs::{Config, TS};

    /// Every type the agent tab reads, in the order the file declares them.
    fn generated() -> String {
        let cfg = Config::new().with_large_int("number");
        let decls = [
            Harness::decl(&cfg),
            Envelope::decl(&cfg),
            Event::decl(&cfg),
            Item::decl(&cfg),
            ItemKind::decl(&cfg),
            ToolStatus::decl(&cfg),
            FileDiff::decl(&cfg),
            ApprovalOption::decl(&cfg),
            PlanEntry::decl(&cfg),
            SessionState::decl(&cfg),
            Hint::decl(&cfg),
            SessionStatus::decl(&cfg),
            Attachment::decl(&cfg),
            HarnessInfo::decl(&cfg),
        ];
        let mut out = String::from(
            "// Generated from crates/kaava-agent-host/src/event.rs by ts-rs. Do not edit.\n\
             // Regenerate: KAAVA_BLESS=1 cargo test -p kaava-agent-host generated_types\n\n",
        );
        for decl in decls {
            out.push_str("export ");
            out.push_str(&decl);
            out.push_str("\n\n");
        }
        out.truncate(out.trim_end().len());
        out.push('\n');
        out
    }

    /// Resolved at run time: a target directory shared between worktrees can
    /// hold a test binary compiled in another checkout.
    fn generated_path() -> std::path::PathBuf {
        let crate_dir = std::env::var("CARGO_MANIFEST_DIR")
            .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string());
        std::path::Path::new(&crate_dir).join("../../apps/agent-tab/ui/src/protocol.generated.ts")
    }

    #[test]
    fn generated_types_match_the_checked_in_file() {
        let path = generated_path();
        let want = generated();
        if std::env::var("KAAVA_BLESS").as_deref() == Ok("1") {
            std::fs::write(&path, &want).unwrap();
        }
        let have = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert!(
            want.contains("seq: number"),
            "a u64 must reach TypeScript as number"
        );
        assert!(
            have == want,
            "{} is stale. Regenerate it with:\n  KAAVA_BLESS=1 cargo test -p kaava-agent-host generated_types",
            path.display()
        );
    }

    #[test]
    fn an_event_serializes_in_the_shape_the_tab_reads() {
        let envelope = Envelope {
            instance_id: "agent-tab-1".into(),
            seq: 3,
            event: Event::ItemDelta {
                item_id: "i2".into(),
                text: "Hel".into(),
            },
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "instanceId": "agent-tab-1",
                "seq": 3,
                "event": { "type": "itemDelta", "itemId": "i2", "text": "Hel" }
            })
        );
    }
}
