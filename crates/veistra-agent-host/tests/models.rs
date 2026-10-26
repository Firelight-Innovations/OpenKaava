//! `models::ask` against `mock-agent`, a real child process speaking ACP.

// The helpers below are fixtures, not `#[test]` fns, so clippy.toml's
// `allow-unwrap-in-tests` does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use veistra_agent_host::harness::CLAUDE;
use veistra_agent_host::models::ask;
use veistra_agent_host::{Harness, LaunchSpec, Worktree};

const PATIENCE: Duration = Duration::from_secs(10);

fn worktree(dir: &Path) -> Worktree {
    let root = dir.join("tree");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".git"), "gitdir: elsewhere\n").unwrap();
    Worktree::new(&root).unwrap()
}

fn mock(args: &[&str]) -> LaunchSpec {
    LaunchSpec {
        harness: Harness::Claude,
        program: PathBuf::from(env!("CARGO_BIN_EXE_mock-agent")),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: Vec::new(),
        env_remove: Vec::new(),
        expected_version: Some("0.90.0"),
        policy: CLAUDE.policy,
        setting_timeout: PATIENCE,
        mcp_servers: Vec::new(),
        model: None,
        effort: None,
        ultracode: false,
        mode: None,
    }
}

#[test]
fn an_agent_is_asked_for_its_models_and_never_sent_a_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let tree = worktree(dir.path());
    let trace = dir.path().join("trace.txt");
    let spec = mock(&["--trace", trace.to_str().unwrap()]);
    let models = ask(&spec, &tree, PATIENCE).unwrap();
    let values: Vec<&str> = models.choices.iter().map(|c| c.value.as_str()).collect();
    // The mock also lists `bypassPermissions`, which is never offered.
    assert_eq!(values, ["default", "opus", "haiku"]);
    assert_eq!(models.default, "default");
    // Its modes too, so one can be picked before a session exists; bypass never is.
    let modes: Vec<&str> = models.modes.iter().map(|c| c.value.as_str()).collect();
    assert_eq!(modes, ["default", "acceptEdits", "plan", "auto"]);
    // And what a prompt may carry, so an @ chip goes as the agent can take it.
    assert_eq!(
        models.prompt_capabilities,
        serde_json::json!({ "image": true, "embeddedContext": true })
    );
    let sent = std::fs::read_to_string(&trace).unwrap();
    assert_eq!(
        sent.lines().collect::<Vec<_>>(),
        ["initialize", "session/new"]
    );
}

#[test]
fn a_signed_out_agent_has_no_models() {
    let dir = tempfile::tempdir().unwrap();
    let tree = worktree(dir.path());
    assert_eq!(ask(&mock(&["--signin"]), &tree, PATIENCE), None);
}

#[test]
fn commands_advertised_around_session_new_are_kept_without_a_prompt() {
    for flag in ["--commands-before", "--commands-after"] {
        let dir = tempfile::tempdir().unwrap();
        let tree = worktree(dir.path());
        let trace = dir.path().join("trace.txt");
        let spec = mock(&[flag, "--trace", trace.to_str().unwrap()]);
        let models = ask(&spec, &tree, PATIENCE).unwrap();
        assert_eq!(models.commands.len(), 2);
        assert_eq!(models.commands[0].name, "compact");
        assert_eq!(models.commands[0].hint.as_deref(), Some("instructions"));
        assert_eq!(models.commands[1].name, "$project-skill");
        assert_eq!(
            std::fs::read_to_string(trace)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ["initialize", "session/new"]
        );
    }
}

#[test]
fn an_agent_without_a_model_option_has_no_models() {
    let dir = tempfile::tempdir().unwrap();
    let tree = worktree(dir.path());
    assert_eq!(ask(&mock(&["--no-config"]), &tree, PATIENCE), None);
}

#[test]
fn an_agent_that_will_not_start_has_no_models() {
    let dir = tempfile::tempdir().unwrap();
    let tree = worktree(dir.path());
    let mut spec = mock(&[]);
    spec.program = dir.path().join("no-such-agent.exe");
    assert_eq!(ask(&spec, &tree, PATIENCE), None);
}

/// The mock sleeps for 30 s without reading, so an ask that waited for it to
/// exit, rather than killing it, would take that long.
#[test]
fn an_agent_that_never_answers_is_killed_when_the_wait_runs_out() {
    let dir = tempfile::tempdir().unwrap();
    let tree = worktree(dir.path());
    let started = Instant::now();
    let wait = Duration::from_millis(500);
    assert_eq!(ask(&mock(&["--sleep"]), &tree, wait), None);
    assert!(started.elapsed() < PATIENCE, "took {:?}", started.elapsed());
}

/// Each request waits 1.5 s, so the two together outlast the 2.25 s wait that
/// either one alone fits in.
#[test]
fn each_request_has_the_whole_wait_to_be_answered() {
    let dir = tempfile::tempdir().unwrap();
    let tree = worktree(dir.path());
    let wait = Duration::from_millis(2250);
    let models = ask(&mock(&["--slow", "1500"]), &tree, wait);
    assert_eq!(models.map(|m| m.default).as_deref(), Some("default"));
}
