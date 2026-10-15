//! The host against `mock-agent`, a real child process speaking ACP.
//!
//! Every wait is a bounded poll on what the sink has received — never a fixed
//! sleep — so a slow machine makes a test slower, not flaky.

// The helpers below are fixtures, not `#[test]` fns, so clippy.toml's
// `allow-unwrap-in-tests` does not reach them; a fixture that cannot be built
// should panic the test that asked for it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

use kaava_agent_host::harness::{Policy, CLAUDE};
use kaava_agent_host::mask::looks_secret;
use kaava_agent_host::{
    AgentHost, Envelope, Event, Harness, Hint, HostError, Item, ItemKind, LaunchSpec, SessionState,
    SettingTrouble, Worktree,
};
use serde_json::{json, Value};

const PATIENCE: Duration = Duration::from_secs(10);
const TAB: &str = "agent-tab-1";

struct Rig {
    host: AgentHost,
    got: Arc<Mutex<Vec<Envelope>>>,
    logs: Arc<Mutex<Vec<String>>>,
    dir: tempfile::TempDir,
    tree: Worktree,
    other: Worktree,
}

fn worktree(dir: &Path, name: &str) -> Worktree {
    let root = dir.join(name);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".git"), "gitdir: elsewhere\n").unwrap();
    Worktree::new(&root).unwrap()
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let tree = worktree(dir.path(), "tree");
    let other = worktree(dir.path(), "other");
    let got = Arc::new(Mutex::new(Vec::new()));
    let logs = Arc::new(Mutex::new(Vec::new()));
    let sink_got = Arc::clone(&got);
    let log_got = Arc::clone(&logs);
    let host = AgentHost::new(
        Arc::new(move |e| sink_got.lock().unwrap().push(e)),
        Arc::new(move |level, line: &str| {
            log_got.lock().unwrap().push(format!("{level:?} {line}"));
        }),
    );
    Rig {
        host,
        got,
        logs,
        dir,
        tree,
        other,
    }
}

fn mock(args: &[&str]) -> LaunchSpec {
    LaunchSpec {
        harness: Harness::Claude,
        program: PathBuf::from(env!("CARGO_BIN_EXE_mock-agent")),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: Vec::new(),
        expected_version: Some("0.90.0"),
        policy: CLAUDE.policy,
        setting_timeout: PATIENCE,
    }
}

impl Rig {
    /// Every log line so far, once one contains `needle` or the wait runs out.
    /// Each line starts with its level.
    fn logged(&self, needle: &str) -> Vec<String> {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let logs = self.logs.lock().unwrap().clone();
            if Instant::now() > deadline || logs.iter().any(|l| l.contains(needle)) {
                return logs;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn send(&self, args: &[&str], text: &str) -> Result<(), HostError> {
        self.host.send(TAB, mock(args), self.tree.clone(), text)
    }

    /// Where a mock told `--init-gate` waits, as a string a flag can carry.
    fn gate(&self) -> String {
        self.dir
            .path()
            .join("init-gate")
            .to_string_lossy()
            .into_owned()
    }

    /// Let a mock held by [`Rig::gate`] finish its handshake.
    fn open_gate(&self) {
        std::fs::write(self.gate(), b"").unwrap();
    }

    /// Every status after the first `from` events.
    fn statuses_since(&self, from: usize) -> Vec<kaava_agent_host::SessionStatus> {
        self.events()[from..]
            .iter()
            .filter_map(|e| match &e.event {
                Event::Status { status } => Some(status.clone()),
                _ => None,
            })
            .collect()
    }

    fn events(&self) -> Vec<Envelope> {
        self.got.lock().unwrap().clone()
    }

    /// Wait until `test` holds of everything received so far.
    fn until(&self, what: &str, test: impl Fn(&[Envelope]) -> bool) {
        let deadline = Instant::now() + PATIENCE;
        while Instant::now() < deadline {
            if test(&self.events()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {what}; got {:#?}", self.events());
    }

    fn turns_done(&self, n: usize) {
        self.until(&format!("{n} finished turns"), |e| {
            e.iter()
                .filter(|e| matches!(e.event, Event::TurnCompleted { .. }))
                .count()
                >= n
        });
    }

    fn state(&self, state: SessionState) {
        self.until(&format!("{state:?}"), |e| {
            last_status(e).map(|s| s.state) == Some(state)
        });
    }

    fn items(&self) -> Vec<Item> {
        self.host.attach(TAB).items
    }

    /// Wait until the latest status satisfies `test`, and return it.
    fn status_where(
        &self,
        what: &str,
        test: impl Fn(&kaava_agent_host::SessionStatus) -> bool,
    ) -> kaava_agent_host::SessionStatus {
        self.until(what, |e| last_status(e).is_some_and(|s| test(&s)));
        last_status(&self.events()).unwrap()
    }
}

fn value_of<'a>(status: &'a kaava_agent_host::SessionStatus, id: &str) -> Option<&'a str> {
    status
        .config
        .iter()
        .find(|o| o.id == id)
        .map(|o| o.value.as_str())
}

fn last_status(events: &[Envelope]) -> Option<kaava_agent_host::SessionStatus> {
    events.iter().rev().find_map(|e| match &e.event {
        Event::Status { status } => Some(status.clone()),
        _ => None,
    })
}

fn stop_reasons(events: &[Envelope]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match &e.event {
            Event::TurnCompleted { stop_reason, .. } => Some(stop_reason.clone()),
            _ => None,
        })
        .collect()
}

fn texts(items: &[Item]) -> Vec<String> {
    items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::AssistantText { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn approval(items: &[Item]) -> Option<Item> {
    items
        .iter()
        .rev()
        .find(|i| matches!(i.kind, ItemKind::Approval { .. }))
        .cloned()
}

/// What the mock says the client sent back to its permission request.
fn echoed_answer(items: &[Item]) -> Value {
    let line = texts(items)
        .into_iter()
        .find_map(|t| t.strip_prefix("answer: ").map(str::to_string))
        .expect("the mock reported the answer");
    serde_json::from_str(&line).unwrap()
}

#[test]
fn a_turn_streams_in_order_and_ends_ready() {
    let rig = rig();
    rig.send(&[], "stream").unwrap();
    rig.turns_done(1);
    rig.state(SessionState::Ready);

    let events = rig.events();
    let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
    assert!(
        seqs.windows(2).all(|w| w[0] < w[1]),
        "seq strictly increases: {seqs:?}"
    );
    assert!(events.iter().all(|e| e.instance_id == TAB));

    let states: Vec<SessionState> = events
        .iter()
        .filter_map(|e| match &e.event {
            Event::Status { status } => Some(status.state),
            _ => None,
        })
        .collect();
    assert_eq!(
        states,
        [
            SessionState::Starting,
            // The same state again, now carrying the prompt held for the
            // handshake.
            SessionState::Starting,
            SessionState::Ready,
            SessionState::Working,
            SessionState::Ready
        ]
    );
    let status = last_status(&events).unwrap();
    assert_eq!(
        status.mode.as_deref(),
        Some("default"),
        "forced to ask first"
    );
    assert_eq!(status.adapter_version.as_deref(), Some("0.90.0"));
    assert_eq!(status.hint, None);

    let attach = rig.host.attach(TAB);
    assert_eq!(attach.seq, *seqs.last().unwrap());
    assert!(matches!(&attach.items[0].kind, ItemKind::UserMessage { text } if text == "stream"));
    assert_eq!(texts(&attach.items), ["Hello"]);
    assert!(attach
        .items
        .iter()
        .any(|i| matches!(&i.kind, ItemKind::Reasoning { text } if text == "thinking")));
}

#[test]
fn a_tool_call_runs_to_completion() {
    let rig = rig();
    rig.send(&[], "tool").unwrap();
    rig.turns_done(1);
    let items = rig.items();
    let tool = items
        .iter()
        .find_map(|i| match &i.kind {
            ItemKind::ToolCall {
                status,
                output,
                paths,
                ..
            } => Some((*status, output.clone(), paths.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(tool.0, kaava_agent_host::event::ToolStatus::Completed);
    assert_eq!(tool.1, "# Readme");
    assert_eq!(tool.2.len(), 1);
}

#[test]
fn an_allowed_approval_sends_the_nested_outcome() {
    let rig = rig();
    rig.send(&[], "approve").unwrap();
    rig.state(SessionState::NeedsInput);
    let card = approval(&rig.items()).unwrap();
    let ItemKind::Approval { options, paths, .. } = &card.kind else {
        unreachable!()
    };
    let ids: Vec<&str> = options.iter().map(|o| o.option_id.as_str()).collect();
    assert_eq!(
        ids,
        ["o1", "o3"],
        "allow_always is never offered: it would stop the agent asking, and the guard with it"
    );
    assert_eq!(paths.len(), 1);

    assert!(matches!(
        rig.host.answer(TAB, &card.id, "o9"),
        Err(HostError::UnknownOption)
    ));
    rig.host.answer(TAB, &card.id, "o1").unwrap();
    rig.turns_done(1);
    assert_eq!(
        echoed_answer(&rig.items()),
        json!({ "outcome": { "outcome": "selected", "optionId": "o1" } })
    );
    let card = approval(&rig.items()).unwrap();
    assert!(matches!(&card.kind, ItemKind::Approval { answer: Some(a), .. } if a == "o1"));
    assert!(matches!(
        rig.host.answer(TAB, &card.id, "o1"),
        Err(HostError::UnknownApproval)
    ));
}

#[test]
fn a_denied_approval_fails_the_tool() {
    let rig = rig();
    rig.send(&[], "approve").unwrap();
    rig.state(SessionState::NeedsInput);
    let card = approval(&rig.items()).unwrap();
    rig.host.answer(TAB, &card.id, "o3").unwrap();
    rig.turns_done(1);
    assert!(rig.items().iter().any(|i| matches!(
        i.kind,
        ItemKind::ToolCall {
            status: kaava_agent_host::event::ToolStatus::Failed,
            ..
        }
    )));
}

#[test]
fn a_command_with_no_file_offers_no_always_either() {
    let rig = rig();
    rig.send(&[], "bash").unwrap();
    rig.state(SessionState::NeedsInput);
    let card = approval(&rig.items()).unwrap();
    let ItemKind::Approval {
        options, detail, ..
    } = &card.kind
    else {
        unreachable!()
    };
    let ids: Vec<&str> = options.iter().map(|o| o.option_id.as_str()).collect();
    assert_eq!(ids, ["o1", "o3"]);
    assert_eq!(detail.as_deref(), Some("rm -rf build"));
    rig.host.cancel(TAB).unwrap();
    rig.turns_done(1);
}

#[test]
fn a_path_outside_the_worktree_is_refused_without_asking() {
    let rig = rig();
    rig.send(&[], "outside").unwrap();
    rig.turns_done(1);
    let events = rig.events();
    assert!(
        !events.iter().any(|e| matches!(&e.event,
            Event::Status { status } if status.state == SessionState::NeedsInput)),
        "the user is never asked"
    );
    let items = rig.items();
    let card = approval(&items).unwrap();
    assert!(matches!(&card.kind, ItemKind::Approval { answer: Some(a), .. } if a == "outside"));
    assert!(items.iter().any(|i| matches!(
        i.kind,
        ItemKind::Error {
            hint: Some(Hint::OutsideWorktree),
            ..
        }
    )));
    assert_eq!(
        echoed_answer(&items),
        json!({ "outcome": { "outcome": "selected", "optionId": "o3" } })
    );
}

#[test]
fn an_edit_approval_carries_its_diff() {
    let rig = rig();
    rig.send(&[], "diff").unwrap();
    rig.state(SessionState::NeedsInput);
    let card = approval(&rig.items()).unwrap();
    let ItemKind::Approval {
        diffs,
        detail,
        options,
        ..
    } = &card.kind
    else {
        unreachable!()
    };
    assert_eq!(diffs.len(), 1);
    assert!(diffs[0].path.ends_with("inside.txt"));
    assert_eq!(diffs[0].old_text.as_deref(), Some("one\n"));
    assert_eq!(diffs[0].new_text, "two\n");
    assert!(!diffs[0].too_large);
    assert!(detail.is_none(), "the diff is the exact change");
    assert_eq!(options.len(), 2);
    rig.host.answer(TAB, &card.id, "o1").unwrap();
    rig.turns_done(1);
}

/// The only mention of the file is the diff, so the guard has to read it.
#[test]
fn a_diff_to_a_file_outside_the_worktree_is_refused_without_asking() {
    let rig = rig();
    rig.send(&[], "diffout").unwrap();
    rig.turns_done(1);
    assert!(
        !rig.events().iter().any(|e| matches!(&e.event,
            Event::Status { status } if status.state == SessionState::NeedsInput)),
        "the user is never asked"
    );
    let items = rig.items();
    let card = approval(&items).unwrap();
    assert!(
        matches!(&card.kind, ItemKind::Approval { answer: Some(a), diffs, .. }
        if a == "outside" && diffs.len() == 1)
    );
    assert!(items.iter().any(|i| matches!(
        i.kind,
        ItemKind::Error {
            hint: Some(Hint::OutsideWorktree),
            ..
        }
    )));
    assert_eq!(
        echoed_answer(&items),
        json!({ "outcome": { "outcome": "selected", "optionId": "o3" } })
    );
}

#[test]
fn the_agent_can_withdraw_its_request() {
    let rig = rig();
    rig.send(&[], "cancelreq").unwrap();
    rig.turns_done(1);
    let card = approval(&rig.items()).unwrap();
    assert!(matches!(&card.kind, ItemKind::Approval { answer: Some(a), .. } if a == "cancelled"));
}

#[test]
fn cancel_ends_a_running_turn() {
    let rig = rig();
    rig.send(&[], "slow").unwrap();
    rig.until("the first chunk", |e| {
        e.iter().any(|e| {
            matches!(&e.event, Event::ItemStarted { item }
                if matches!(&item.kind, ItemKind::AssistantText { text } if text == "working"))
        })
    });
    assert!(matches!(rig.send(&[], "again"), Err(HostError::Busy)));
    rig.host.cancel(TAB).unwrap();
    rig.turns_done(1);
    assert_eq!(stop_reasons(&rig.events()), ["cancelled"]);
    rig.state(SessionState::Ready);
}

#[test]
fn a_crash_stops_the_session_and_the_next_prompt_restarts_it() {
    let rig = rig();
    rig.send(&[], "crash").unwrap();
    rig.state(SessionState::Stopped);
    let status = last_status(&rig.events()).unwrap();
    assert_eq!(status.exit_code, Some(7));
    assert_eq!(stop_reasons(&rig.events()), ["error"]);
    let logs = rig.logged("exited with code 7");
    assert!(
        logs.iter()
            .any(|l| l.starts_with("Failure ") && l.contains("exited with code 7")),
        "a crash is a failure: {logs:?}"
    );

    rig.send(&[], "stream").unwrap();
    rig.turns_done(2);
    let items = rig.items();
    assert_eq!(
        texts(&items),
        ["bye", "Hello"],
        "the conversation carries on"
    );
    let mut ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), items.len(), "no id is minted twice");
}

#[test]
fn a_session_belongs_to_its_worktree() {
    let rig = rig();
    rig.send(&[], "slow").unwrap();
    rig.state(SessionState::Working);
    assert!(matches!(
        rig.host.send(TAB, mock(&[]), rig.other.clone(), "hi"),
        Err(HostError::WrongWorktree)
    ));
    assert_eq!(rig.host.worktree(TAB), Some(rig.tree.clone()));
    rig.host.cancel(TAB).unwrap();
}

#[test]
fn signed_out_fails_the_handshake_with_a_hint() {
    let rig = rig();
    rig.send(&["--signin"], "hi").unwrap();
    rig.state(SessionState::Failed);
    assert_eq!(
        last_status(&rig.events()).unwrap().hint,
        Some(Hint::SignedOut)
    );
}

#[test]
fn signed_out_mid_session_is_a_hinted_error() {
    let rig = rig();
    rig.send(&[], "auth").unwrap();
    rig.turns_done(1);
    assert!(rig.items().iter().any(|i| matches!(
        i.kind,
        ItemKind::Error {
            hint: Some(Hint::SignedOut),
            ..
        }
    )));
    assert_eq!(
        last_status(&rig.events()).unwrap().hint,
        Some(Hint::SignedOut)
    );
}

/// The hint says "run claude once and sign in", so once someone has, it has to
/// go: a turn that ran proves it, and so does the agent saying so.
#[test]
fn the_signed_out_hint_goes_once_a_turn_runs() {
    let rig = rig();
    rig.send(&[], "auth").unwrap();
    rig.turns_done(1);
    assert_eq!(
        last_status(&rig.events()).unwrap().hint,
        Some(Hint::SignedOut)
    );
    rig.send(&[], "stream").unwrap();
    rig.turns_done(2);
    rig.state(SessionState::Ready);
    assert_eq!(last_status(&rig.events()).unwrap().hint, None);
}

#[test]
fn the_signed_out_hint_goes_when_the_agent_reports_a_sign_in() {
    let rig = rig();
    rig.send(&[], "auth").unwrap();
    rig.turns_done(1);
    // This turn fails for another reason, so only the notice can clear it.
    rig.send(&[], "relogin").unwrap();
    rig.turns_done(2);
    rig.state(SessionState::Ready);
    assert_eq!(last_status(&rig.events()).unwrap().hint, None);
}

#[test]
fn an_agent_that_will_not_ask_first_does_not_run() {
    let rig = rig();
    rig.send(&["--no-mode"], "hi").unwrap();
    rig.state(SessionState::Failed);
    assert!(
        texts(&rig.items()).is_empty(),
        "the prompt never reached the agent, so it never answered"
    );
    let status = last_status(&rig.events()).unwrap();
    assert_eq!(status.mode, None, "not the user's own default");
}

/// The tab clears its draft when a prompt is accepted, so a handshake that
/// fails must still draw what was typed, ahead of the error: the text stays on
/// screen and Retry on the error resends it.
#[test]
fn a_failed_handshake_still_draws_the_prompt_ahead_of_the_error() {
    for args in [&["--no-mode"][..], &["--signin"][..]] {
        let rig = rig();
        rig.send(args, "write the thing").unwrap();
        rig.state(SessionState::Failed);
        rig.turns_done(1);
        let items = rig.items();
        let kinds: Vec<&ItemKind> = items.iter().map(|i| &i.kind).collect();
        assert!(
            matches!(
                kinds[..],
                [ItemKind::UserMessage { .. }, ItemKind::Error { .. }]
            ),
            "{kinds:#?}"
        );
        assert!(matches!(kinds[0], ItemKind::UserMessage { text } if text == "write the thing"));
        assert_eq!(items[0].turn_id, items[1].turn_id);
        assert_eq!(stop_reasons(&rig.events()), ["error"]);
    }
}

/// Retry sends the failed text again; the new session carries the old items on.
#[test]
fn a_retry_after_a_failed_handshake_starts_a_new_session_and_runs() {
    let rig = rig();
    rig.send(&["--no-mode"], "first try").unwrap();
    rig.state(SessionState::Failed);
    rig.turns_done(1);
    rig.send(&[], "stream").unwrap();
    rig.turns_done(2);
    let prompts: Vec<_> = rig
        .items()
        .into_iter()
        .filter_map(|i| match i.kind {
            ItemKind::UserMessage { text } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(prompts, ["first try", "stream"]);
}

#[test]
fn the_session_asks_for_its_harness_policy_mode() {
    let asked = rig();
    let spec = LaunchSpec {
        policy: Policy {
            ask_first: "read-only",
        },
        ..mock(&["--only-mode", "read-only"])
    };
    asked
        .host
        .send(TAB, spec, asked.tree.clone(), "hi")
        .unwrap();
    asked.turns_done(1);
    let status = last_status(&asked.events()).unwrap();
    assert_eq!(status.mode.as_deref(), Some("read-only"));

    let refused = rig();
    refused.send(&["--only-mode", "read-only"], "hi").unwrap();
    refused.state(SessionState::Failed);
}

#[test]
fn an_agent_that_dies_at_start_fails_and_logs_its_stderr() {
    let rig = rig();
    rig.send(&["--fail-init"], "hi").unwrap();
    rig.state(SessionState::Failed);
    let deadline = Instant::now() + PATIENCE;
    while Instant::now() < deadline {
        if rig
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("refusing to start"))
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let logs = rig.logs.lock().unwrap().clone();
    assert!(
        logs.iter()
            .any(|l| l.contains("stderr: mock-agent: refusing to start")),
        "{logs:?}"
    );
    assert_eq!(last_status(&rig.events()).unwrap().exit_code, Some(3));
    rig.until("the error drawn in the tab", |e| {
        e.iter().any(|e| {
            matches!(&e.event, Event::ItemCompleted { item }
                if matches!(item.kind, ItemKind::Error { .. }))
        })
    });
}

#[test]
fn a_prompt_sent_during_the_handshake_is_refused_as_busy() {
    let rig = rig();
    let gate = rig.gate();
    rig.send(&["--init-gate", &gate], "stream").unwrap();
    assert!(matches!(rig.send(&[], "again"), Err(HostError::Busy)));
    rig.open_gate();
    rig.turns_done(1);
    let prompts: Vec<_> = rig
        .items()
        .into_iter()
        .filter(|i| matches!(i.kind, ItemKind::UserMessage { .. }))
        .collect();
    assert_eq!(prompts.len(), 1);
}

#[test]
fn a_cancel_during_the_handshake_withdraws_the_prompt() {
    let rig = rig();
    let gate = rig.gate();
    rig.send(&["--init-gate", &gate], "withdrawn").unwrap();
    rig.host.cancel(TAB).unwrap();
    rig.send(&[], "stream").unwrap();
    rig.open_gate();
    rig.turns_done(1);
    let prompts: Vec<_> = rig
        .items()
        .into_iter()
        .filter_map(|i| match i.kind {
            ItemKind::UserMessage { text } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(prompts, ["stream"]);
}

/// The transcript draws a prompt when its turn begins, so until then the
/// status is how the tab shows what it accepted, and a cancel takes it back.
#[test]
fn a_prompt_held_through_the_handshake_is_in_the_status_until_it_starts() {
    let pending = |e: &[Envelope]| last_status(e).and_then(|s| s.pending_prompt);
    let rig = rig();
    let gate = rig.gate();
    rig.send(&["--init-gate", &gate], "hold me").unwrap();
    rig.until("the held prompt", |e| {
        pending(e).as_deref() == Some("hold me")
            && last_status(e).map(|s| s.state) == Some(SessionState::Starting)
    });
    rig.host.cancel(TAB).unwrap();
    rig.until("the withdrawn prompt", |e| pending(e).is_none());
    rig.send(&[], "stream").unwrap();
    rig.until("the second prompt", |e| {
        pending(e).as_deref() == Some("stream")
    });
    rig.open_gate();
    rig.turns_done(1);
    rig.state(SessionState::Ready);
    assert_eq!(pending(&rig.events()), None);
}

/// Sends racing on a tab with no session used to start one agent each, and the
/// second retired the first mid-handshake. The gate holds the first agent in
/// its handshake for as long as the race takes, so the others find it there.
#[test]
fn sends_racing_on_a_new_tab_start_one_agent() {
    const SENDERS: usize = 6;
    let rig = rig();
    let gate = rig.gate();
    let ready = Barrier::new(SENDERS);
    let results: Vec<Result<(), HostError>> = std::thread::scope(|scope| {
        let racers: Vec<_> = (0..SENDERS)
            .map(|_| {
                scope.spawn(|| {
                    ready.wait();
                    rig.send(&["--init-gate", &gate], "stream")
                })
            })
            .collect();
        racers.into_iter().map(|r| r.join().unwrap()).collect()
    });
    let accepted = results.iter().filter(|r| r.is_ok()).count();
    let busy = results
        .iter()
        .filter(|r| matches!(r, Err(HostError::Busy)))
        .count();
    assert_eq!((accepted, busy), (1, SENDERS - 1), "{results:?}");
    rig.open_gate();
    rig.turns_done(1);
    let started = rig
        .logs
        .lock()
        .unwrap()
        .iter()
        .filter(|l| l.contains(" as pid "))
        .count();
    assert_eq!(started, 1, "one process was started");
}

#[test]
fn a_missing_program_is_a_spawn_error() {
    let rig = rig();
    let mut spec = mock(&[]);
    spec.program = rig.tree.root().join("no-such-agent.exe");
    let err = rig
        .host
        .send(TAB, spec, rig.tree.clone(), "hi")
        .unwrap_err();
    assert_eq!(err.code(), "spawn");
    assert_eq!(err.hint(), Some(Hint::AdapterMissing));
}

#[test]
fn another_adapter_version_runs_with_a_hint() {
    let rig = rig();
    rig.send(&["--version", "0.89.0"], "stream").unwrap();
    rig.turns_done(1);
    let status = last_status(&rig.events()).unwrap();
    assert_eq!(status.state, SessionState::Ready);
    assert_eq!(status.hint, Some(Hint::AdapterVersion));
}

#[test]
fn the_plan_is_one_item_and_usage_comes_at_the_end() {
    let rig = rig();
    rig.send(&[], "plan").unwrap();
    rig.turns_done(1);
    let items = rig.items();
    let plans: Vec<&Item> = items
        .iter()
        .filter(|i| matches!(i.kind, ItemKind::Plan { .. }))
        .collect();
    assert_eq!(plans.len(), 1);
    assert!(
        matches!(&plans[0].kind, ItemKind::Plan { entries } if entries[0].status == "completed")
    );
    assert!(matches!(
        items.last().map(|i| &i.kind),
        Some(ItemKind::Usage {
            used: 1200,
            size: 200000
        })
    ));
}

#[test]
fn a_mode_change_reaches_the_status() {
    let rig = rig();
    rig.send(&[], "mode").unwrap();
    rig.turns_done(1);
    assert_eq!(
        last_status(&rig.events()).unwrap().mode.as_deref(),
        Some("plan")
    );
}

#[test]
fn reset_forgets_the_conversation() {
    let rig = rig();
    rig.send(&[], "stream").unwrap();
    rig.turns_done(1);
    rig.host.reset(TAB);
    rig.until("the reset", |e| {
        e.iter().any(|e| matches!(e.event, Event::Reset))
    });
    let attach = rig.host.attach(TAB);
    assert!(attach.status.is_none());
    assert!(attach.items.is_empty());
    let last = rig.events().last().map(|e| e.seq).unwrap();
    assert!(attach.seq >= last);
}

#[test]
fn a_reset_tab_hears_nothing_more_from_its_old_agent() {
    let rig = rig();
    rig.send(&[], "slow").unwrap();
    rig.state(SessionState::Working);
    rig.host.reset(TAB);
    // The waiter logs the exit after its last event, so once the line is
    // here, anything the old session could still have sent has been sent.
    rig.logged("exited with code");
    rig.until("the reset", |e| {
        e.iter().any(|e| matches!(e.event, Event::Reset))
    });
    let events = rig.events();
    let at = events
        .iter()
        .position(|e| matches!(e.event, Event::Reset))
        .unwrap();
    assert!(
        events[at + 1..].is_empty(),
        "after the reset: {:#?}",
        &events[at + 1..]
    );
}

#[test]
fn a_closed_tab_stops_its_agent_without_waiting() {
    let rig = rig();
    rig.send(&[], "slow").unwrap();
    rig.state(SessionState::Working);
    rig.host.retain(|_| false);
    // `retain` hands the kill and the wait to a thread of its own. Had it
    // done them itself, the exit would already be logged when it returned.
    assert!(
        !rig.logs
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("exited with code")),
        "retain waited for the agent to exit"
    );
    let logs = rig.logged("exited with code");
    assert!(
        logs.iter().any(|l| l.contains("exited with code")),
        "{logs:?}"
    );
    assert!(rig.host.worktree(TAB).is_none());
}

#[test]
fn a_grandchild_holding_stdout_does_not_keep_the_session_alive() {
    let rig = rig();
    let pid_file = rig.dir.path().join("grandchild.pid");
    let pid_flag = pid_file.to_string_lossy().into_owned();
    rig.send(&["--grandchild-pid", &pid_flag], "grandchild")
        .unwrap();
    rig.turns_done(1);
    let grandchild = wait_for_pid(&pid_file);
    rig.host.stop(TAB);
    rig.state(SessionState::Stopped);
    let logs = rig.logged("exited with code");
    let exit = logs.iter().find(|l| l.contains("exited with code"));
    assert!(
        exit.is_some_and(|l| l.starts_with("Info ")),
        "a stop the host asked for is not a failure: {logs:?}"
    );
    // The tree, not just the child: the agent's job is Windows' answer to an
    // npm shim leaving its `node` behind. Elsewhere the child is killed
    // alone, so the grandchild is left to its own 30 second sleep.
    #[cfg(windows)]
    {
        let deadline = Instant::now() + PATIENCE;
        while process_alive(grandchild) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !process_alive(grandchild),
            "the grandchild outlived the stop"
        );
    }
    #[cfg(not(windows))]
    let _ = grandchild;
}

/// A process whose parent has exited is not in the tree `taskkill /T` walks,
/// so only the agent's job could find it.
#[cfg(windows)]
#[test]
fn a_grandchild_whose_parent_has_exited_is_stopped_with_the_agent() {
    let rig = rig();
    let pid_file = rig.dir.path().join("orphan.pid");
    let pid_flag = pid_file.to_string_lossy().into_owned();
    rig.send(&["--grandchild-pid", &pid_flag], "orphan")
        .unwrap();
    rig.turns_done(1);
    let orphan = wait_for_pid(&pid_file);
    assert!(
        process_alive(orphan),
        "the sleeper is running before the stop"
    );
    rig.host.stop(TAB);
    rig.state(SessionState::Stopped);
    let deadline = Instant::now() + PATIENCE;
    while process_alive(orphan) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!process_alive(orphan), "the orphan outlived the stop");
}

/// Stopping is one call per agent, not a walk of every process on the
/// machine each, so closing several agents costs about what closing one does.
/// With `taskkill /T` this took most of a second per agent idle, and the
/// closed-tab test above timed out under load.
#[test]
fn stopping_several_agents_does_not_wait_on_each_in_turn() {
    let rig = rig();
    let tabs = ["agent-tab-a", "agent-tab-b", "agent-tab-c", "agent-tab-d"];
    for tab in tabs {
        rig.host
            .send(tab, mock(&[]), rig.tree.clone(), "slow")
            .unwrap();
    }
    rig.until("every agent working", |events| {
        tabs.iter().all(|tab| {
            events
                .iter()
                .rev()
                .filter(|e| e.instance_id == *tab)
                .find_map(|e| match &e.event {
                    Event::Status { status } => Some(status.state),
                    _ => None,
                })
                == Some(SessionState::Working)
        })
    });
    let started = Instant::now();
    rig.host.stop_all(PATIENCE);
    let took = started.elapsed();
    assert!(
        took < Duration::from_secs(2),
        "stopping four agents took {took:?}"
    );
    let logs = rig.logged("exited with code");
    let exits = logs
        .iter()
        .filter(|l| l.contains("exited with code"))
        .count();
    assert_eq!(exits, tabs.len(), "{logs:?}");
}

/// The pid the mock's grandchild wrote, once it has.
fn wait_for_pid(file: &Path) -> u32 {
    let deadline = Instant::now() + PATIENCE;
    while Instant::now() < deadline {
        if let Some(pid) = std::fs::read_to_string(file)
            .ok()
            .and_then(|text| text.trim().parse().ok())
        {
            return pid;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("the grandchild never wrote its pid to {}", file.display());
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    let listing = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&listing.stdout).contains(&format!("\"{pid}\""))
}

/// Handoff §0.2. The mock prints a token and an email on stderr, reports an
/// account in `_auth/status_update`, and fails a prompt with a token in the
/// message. None of it may reach a log line or a status, and the error item
/// carries it masked.
#[test]
fn no_token_or_account_reaches_a_log_or_a_status() {
    let rig = rig();
    rig.send(&["--secret"], "secret").unwrap();
    rig.turns_done(1);
    rig.host.stop(TAB);
    rig.state(SessionState::Stopped);
    // Stop is not an error exit, so stderr is not logged; crash it to be sure
    // the tail would be, masked.
    rig.send(&["--secret"], "crash").unwrap();
    rig.turns_done(2);
    rig.state(SessionState::Stopped);
    let deadline = Instant::now() + PATIENCE;
    while Instant::now() < deadline
        && !rig
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("stderr: debug: token"))
    {
        std::thread::sleep(Duration::from_millis(20));
    }

    let logs = rig.logs.lock().unwrap().clone();
    assert!(
        logs.iter()
            .any(|l| l.contains("stderr: debug: token <redacted> for <email>")),
        "{logs:?}"
    );
    for line in &logs {
        assert!(!looks_secret(line), "log line holds a secret: {line}");
        assert!(
            !line.contains("Example Org"),
            "log line names the org: {line}"
        );
    }

    let events = rig.events();
    assert_eq!(
        events.iter().find_map(|e| match &e.event {
            Event::Status { status } => status.hint,
            _ => None,
        }),
        Some(Hint::SignedOut),
        "only the auth kind was read"
    );
    for envelope in &events {
        let json = serde_json::to_string(envelope).unwrap();
        assert!(!looks_secret(&json), "envelope holds a secret: {json}");
        assert!(
            !json.contains("Example Org"),
            "envelope names the org: {json}"
        );
        assert!(!json.contains("someone@example.com"));
    }
}

/// The adapter is an npm shim, which `cmd.exe` runs with the worktree as its
/// current directory, and the shim ends in a bare `node`. A repository can ship
/// a `node.cmd`; `spec` must keep it from running.
#[cfg(windows)]
#[test]
fn a_node_cmd_in_the_worktree_is_not_run_by_the_npm_shim() {
    let rig = rig();
    let bin = rig.dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("claude.cmd"), "@echo off\r\n").unwrap();
    std::fs::write(
        bin.join("claude-agent-acp.cmd"),
        "@echo off\r\nnode -e \"process.exit(0)\"\r\n",
    )
    .unwrap();
    std::fs::write(
        rig.tree.root().join("node.cmd"),
        "@echo off\r\necho planted> planted.txt\r\n",
    )
    .unwrap();
    let spec = kaava_agent_host::spec(
        Harness::Claude,
        Some(bin.as_os_str()),
        Some(std::ffi::OsStr::new(".CMD")),
    )
    .unwrap();
    rig.host.send(TAB, spec, rig.tree.clone(), "hi").unwrap();
    rig.logged("exited with code");
    assert!(
        !rig.tree.root().join("planted.txt").exists(),
        "the worktree's node.cmd ran"
    );
}

#[test]
fn the_session_reports_its_modes_and_settings() {
    let rig = rig();
    rig.send(&[], "stream").unwrap();
    rig.turns_done(1);
    let status = last_status(&rig.events()).unwrap();
    assert_eq!(
        status.mode.as_deref(),
        Some("default"),
        "forced to ask first"
    );
    let modes: Vec<&str> = status.modes.iter().map(|m| m.value.as_str()).collect();
    assert_eq!(
        modes,
        ["default", "acceptEdits", "plan"],
        "bypass (D4) and auto are never offered"
    );
    let names: Vec<&str> = status.modes.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(
        names,
        ["Manual", "Accept edits", "Plan"],
        "the agent's own names"
    );
    let ids: Vec<&str> = status.config.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(
        ids,
        ["model", "effort", "fast"],
        "the mode is not drawn twice"
    );
    assert_eq!(value_of(&status, "model"), Some("default"));
    let models: Vec<&str> = status.config[0]
        .choices
        .iter()
        .map(|c| c.value.as_str())
        .collect();
    assert_eq!(
        models,
        ["default", "opus", "haiku"],
        "the mock also offers bypassPermissions there, which is held back"
    );
}

#[test]
fn the_agent_can_change_its_settings_on_its_own() {
    let rig = rig();
    rig.send(&[], "stream").unwrap();
    rig.turns_done(1);
    rig.send(&[], "drift").unwrap();
    rig.turns_done(2);
    let events = rig.events();
    let said = events
        .iter()
        .position(|e| {
            matches!(&e.event, Event::ItemStarted { item }
                if matches!(&item.kind, ItemKind::AssistantText { text } if text == "drifted"))
        })
        .expect("the agent went on talking");
    let drawn = events[..said].iter().find_map(|e| match &e.event {
        Event::Status { status } if value_of(status, "fast") == Some("on") => Some(status),
        _ => None,
    });
    let status = drawn.expect("drawn as it happened, not only at the end of the turn");
    assert_eq!(status.mode.as_deref(), Some("acceptEdits"));
    assert_eq!(status.answered, 0, "nothing was asked for");
    let last = last_status(&events).unwrap();
    assert_eq!(
        last.config.len(),
        3,
        "the update with no list cleared nothing"
    );
}

#[test]
fn a_handshake_that_fails_early_never_shows_the_users_own_mode() {
    let rig = rig();
    // The mock's own default mode is `auto`, which the tab holds back.
    rig.send(&["--no-session-id"], "hi").unwrap();
    rig.state(SessionState::Failed);
    let status = last_status(&rig.events()).unwrap();
    assert_eq!(status.mode, None);
    // What the session/new reply carried is still there, as the status's
    // docs say, though the handshake failed after it.
    let modes: Vec<&str> = status.modes.iter().map(|m| m.value.as_str()).collect();
    assert_eq!(modes, ["default", "acceptEdits", "plan"]);
    assert!(!status.config.is_empty());
}

#[test]
fn an_agent_without_config_options_still_reports_its_modes() {
    let rig = rig();
    rig.send(&["--no-config"], "stream").unwrap();
    rig.turns_done(1);
    let status = last_status(&rig.events()).unwrap();
    assert!(status.config.is_empty());
    let modes: Vec<_> = status.modes.iter().map(|m| m.value.as_str()).collect();
    assert_eq!(modes, ["default", "acceptEdits", "plan"]);
    assert_eq!(status.mode.as_deref(), Some("default"));
}

#[test]
fn a_mode_switch_round_trips_through_the_agent() {
    let rig = rig();
    let record = rig.dir.path().join("settings.log");
    rig.send(&["--record-settings", record.to_str().unwrap()], "stream")
        .unwrap();
    rig.turns_done(1);
    let ticket = rig.host.set_mode(TAB, "plan").unwrap();
    let status = rig.status_where("plan mode answered", |s| s.answered >= ticket);
    assert_eq!(status.mode.as_deref(), Some("plan"));
    assert_eq!(
        value_of(&status, "model"),
        Some("default"),
        "the rest as it was"
    );
    assert_eq!(
        settings_sent(&record),
        ["session/set_mode", "session/set_config_option"],
        "the handshake's ask-first, then the change through the mode option"
    );
    for refused in ["bypassPermissions", "auto", "dontAsk", "nonsense"] {
        assert!(
            matches!(
                rig.host.set_mode(TAB, refused),
                Err(HostError::UnknownOption)
            ),
            "{refused}"
        );
    }
}

#[test]
fn the_agent_has_the_last_word_on_the_mode() {
    let rig = rig();
    rig.send(&["--settles-elsewhere"], "stream").unwrap();
    rig.turns_done(1);
    // The agent says where the mode went before it answers.
    let ticket = rig.host.set_mode(TAB, "plan").unwrap();
    let status = rig.status_where("the answer to the switch", |s| s.answered >= ticket);
    assert_eq!(
        status.mode.as_deref(),
        Some("acceptEdits"),
        "not the plan asked for"
    );
}

#[test]
fn mode_changes_land_in_the_order_they_were_made() {
    let rig = rig();
    rig.send(&[], "stream").unwrap();
    rig.turns_done(1);
    let before = rig.events().len();
    let mut tickets = Vec::new();
    for mode in ["plan", "acceptEdits", "default", "plan"] {
        tickets.push(rig.host.set_mode(TAB, mode).unwrap());
    }
    assert_eq!(tickets, [1, 2, 3, 4]);
    rig.status_where("all four answered", |s| s.answered == 4);
    // The first status to carry each answer shows the mode that change set.
    let mut seen: Vec<(u64, String)> = Vec::new();
    for s in rig.statuses_since(before) {
        if s.answered > seen.last().map_or(0, |(n, _)| *n) {
            seen.push((s.answered, s.mode.unwrap_or_default()));
        }
    }
    let want = [(1, "plan"), (2, "acceptEdits"), (3, "default"), (4, "plan")]
        .map(|(n, mode)| (n, mode.to_string()));
    assert_eq!(seen, want, "each answer in turn");
}

#[test]
fn without_a_mode_option_the_mode_is_set_directly() {
    let rig = rig();
    let record = rig.dir.path().join("settings.log");
    rig.send(
        &["--no-config", "--record-settings", record.to_str().unwrap()],
        "stream",
    )
    .unwrap();
    rig.turns_done(1);
    let status = last_status(&rig.events()).unwrap();
    assert!(status.config.is_empty());
    assert_eq!(status.modes.len(), 3, "from `modes`, less bypass and auto");
    let ticket = rig.host.set_mode(TAB, "plan").unwrap();
    let status = rig.status_where("plan mode", |s| s.answered >= ticket);
    assert_eq!(status.mode.as_deref(), Some("plan"));
    assert_eq!(status.setting_trouble, None);
    assert_eq!(settings_sent(&record), ["session/set_mode"; 2]);
    for refused in ["bypassPermissions", "auto"] {
        assert!(
            matches!(
                rig.host.set_mode(TAB, refused),
                Err(HostError::UnknownOption)
            ),
            "{refused}"
        );
    }
}

#[test]
fn without_a_mode_option_the_mode_the_agent_reports_wins() {
    let rig = rig();
    rig.send(&["--no-config", "--settles-elsewhere"], "stream")
        .unwrap();
    rig.turns_done(1);
    let ticket = rig.host.set_mode(TAB, "plan").unwrap();
    let status = rig.status_where("the answer to the switch", |s| s.answered >= ticket);
    assert_eq!(
        status.mode.as_deref(),
        Some("acceptEdits"),
        "its own report, not the plan asked for"
    );
}

#[test]
fn settings_wait_for_the_session() {
    let rig = rig();
    assert!(matches!(
        rig.host.set_mode(TAB, "plan"),
        Err(HostError::NoSession)
    ));
    let gate = rig.gate();
    rig.send(&["--init-gate", &gate], "stream").unwrap();
    assert!(matches!(
        rig.host.set_mode(TAB, "acceptEdits"),
        Err(HostError::NoSession)
    ));
    rig.open_gate();
    rig.turns_done(1);
    rig.host.stop(TAB);
    rig.state(SessionState::Stopped);
    assert!(matches!(
        rig.host.set_mode(TAB, "plan"),
        Err(HostError::Closed)
    ));
}

#[test]
fn a_slow_setting_is_reported_as_unanswered_and_still_taken_in() {
    let rig = rig();
    let mut spec = mock(&["--slow-setting"]);
    spec.setting_timeout = Duration::from_millis(100);
    rig.host
        .send(TAB, spec, rig.tree.clone(), "stream")
        .unwrap();
    rig.turns_done(1);
    let before = rig.events().len();
    let first = rig.host.set_mode(TAB, "plan").unwrap();
    let last = rig.host.set_mode(TAB, "acceptEdits").unwrap();
    rig.status_where("both answered", |s| s.answered >= last);
    let statuses = rig.statuses_since(before);
    let waited = statuses
        .iter()
        .position(|s| s.setting_trouble == Some(SettingTrouble::Unanswered { ticket: first }))
        .expect("the wait is reported");
    let took = statuses
        .iter()
        .position(|s| s.answered == first)
        .expect("the late reply is taken");
    assert!(waited < took, "the wait is reported before the reply");
    assert_eq!(statuses[took].mode.as_deref(), Some("plan"));
    let done = statuses.last().unwrap();
    assert_eq!(done.answered, last);
    assert_eq!(done.mode.as_deref(), Some("acceptEdits"));
    assert_eq!(done.setting_trouble, None, "an answer clears the wait");
    // The wait is not a turn's failure: nothing in the transcript offers to
    // retry it.
    let drawn = rig.events()[before..]
        .iter()
        .filter(|e| {
            matches!(&e.event, Event::ItemCompleted { item }
                if matches!(item.kind, ItemKind::Error { .. }))
        })
        .count();
    assert_eq!(drawn, 0, "the wait is not drawn as an error");
}

#[test]
fn a_new_session_starts_past_every_earlier_change() {
    let rig = rig();
    rig.send(&["--slow-setting"], "stream").unwrap();
    rig.turns_done(1);
    let ticket = rig.host.set_mode(TAB, "plan").unwrap();
    rig.host.stop(TAB);
    rig.state(SessionState::Stopped);
    rig.send(&[], "stream").unwrap();
    rig.turns_done(2);
    let status = last_status(&rig.events()).unwrap();
    assert!(
        status.answered >= ticket,
        "nothing the old process left unanswered is waited for"
    );
}

/// The setting methods `--record-settings` saw arrive, in order.
fn settings_sent(record: &Path) -> Vec<String> {
    std::fs::read_to_string(record)
        .unwrap()
        .lines()
        .filter_map(|l| l.strip_prefix("sent "))
        .map(str::to_string)
        .collect()
}

#[test]
fn a_change_is_not_sent_until_the_one_before_is_answered() {
    let rig = rig();
    let record = rig.dir.path().join("settings.log");
    rig.send(
        &[
            "--slow-setting",
            "--record-settings",
            record.to_str().unwrap(),
        ],
        "stream",
    )
    .unwrap();
    rig.turns_done(1);
    rig.host.set_mode(TAB, "plan").unwrap();
    let last = rig.host.set_mode(TAB, "acceptEdits").unwrap();
    rig.status_where("both answered", |s| s.answered >= last);
    // Each answer is noted before it is sent, so a second change sent while
    // the first was still being answered (a second, here) shows up as two
    // `sent` lines in a row.
    let log = std::fs::read_to_string(&record).unwrap();
    let order: Vec<&str> = log.lines().filter_map(|l| l.split(' ').next()).collect();
    assert_eq!(
        order,
        ["sent", "answered", "sent", "answered", "sent", "answered"],
        "{log}"
    );
}

#[test]
fn a_change_the_agent_refuses_is_answered_and_said_beside_the_mode() {
    let rig = rig();
    rig.send(&["--refuse-mode", "plan"], "stream").unwrap();
    rig.turns_done(1);
    let before = rig.events().len();
    let ticket = rig.host.set_mode(TAB, "plan").unwrap();
    let status = rig.status_where("the refusal", |s| s.answered >= ticket);
    assert_eq!(status.answered, ticket);
    assert_eq!(status.mode.as_deref(), Some("default"), "the mode stays");
    assert_eq!(
        status.setting_trouble,
        Some(SettingTrouble::Refused {
            ticket,
            message: "Internal error: Invalid Mode: plan".into()
        })
    );
    let drawn = rig.events()[before..]
        .iter()
        .filter(|e| {
            matches!(&e.event, Event::ItemCompleted { item }
                if matches!(item.kind, ItemKind::Error { .. }))
        })
        .count();
    assert_eq!(drawn, 0, "a refusal is not a turn's failure");

    // The next change that goes through clears it.
    let next = rig.host.set_mode(TAB, "acceptEdits").unwrap();
    let status = rig.status_where("the next change", |s| s.answered >= next);
    assert_eq!(status.mode.as_deref(), Some("acceptEdits"));
    assert_eq!(status.setting_trouble, None);
}
