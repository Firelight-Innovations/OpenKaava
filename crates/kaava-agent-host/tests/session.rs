//! The host against `mock-agent`, a real child process speaking ACP.
//!
//! Every wait is a bounded poll on what the sink has received — never a fixed
//! sleep — so a slow machine makes a test slower, not flaky.

// The helpers below are fixtures, not `#[test]` fns, so clippy.toml's
// `allow-unwrap-in-tests` does not reach them; a fixture that cannot be built
// should panic the test that asked for it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kaava_agent_host::mask::looks_secret;
use kaava_agent_host::{
    AgentHost, Envelope, Event, Harness, Hint, HostError, Item, ItemKind, LaunchSpec, SessionState,
    Worktree,
};
use serde_json::{json, Value};

const PATIENCE: Duration = Duration::from_secs(10);
const TAB: &str = "agent-tab-1";

struct Rig {
    host: AgentHost,
    got: Arc<Mutex<Vec<Envelope>>>,
    logs: Arc<Mutex<Vec<String>>>,
    _dir: tempfile::TempDir,
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
        _dir: dir,
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
    assert_eq!(
        options.len(),
        3,
        "a request naming a file keeps allow_always"
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
fn a_command_with_no_file_offers_no_always() {
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

#[test]
fn an_agent_that_will_not_ask_first_does_not_run() {
    let rig = rig();
    rig.send(&["--no-mode"], "hi").unwrap();
    rig.state(SessionState::Failed);
    assert!(
        !rig.items()
            .iter()
            .any(|i| matches!(i.kind, ItemKind::UserMessage { .. })),
        "the prompt never reached the agent"
    );
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
    rig.send(&["--slow-init"], "stream").unwrap();
    assert!(matches!(rig.send(&[], "again"), Err(HostError::Busy)));
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
    rig.send(&["--slow-init"], "withdrawn").unwrap();
    rig.host.cancel(TAB).unwrap();
    rig.send(&[], "stream").unwrap();
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
    let started = Instant::now();
    rig.host.retain(|_| false);
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "retain returns at once"
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
    rig.send(&[], "grandchild").unwrap();
    rig.turns_done(1);
    rig.host.stop(TAB);
    rig.state(SessionState::Stopped);
    let logs = rig.logged("exited with code");
    let exit = logs.iter().find(|l| l.contains("exited with code"));
    assert!(
        exit.is_some_and(|l| l.starts_with("Info ")),
        "a stop the host asked for is not a failure: {logs:?}"
    );
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
