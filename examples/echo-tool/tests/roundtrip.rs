//! End-to-end coverage of `veistra-rpc` against the real `veistra-echo-tool`
//! binary -- not a mock, the actual process spawned the way the
//! orchestrator will spawn it.
//!
//! `CARGO_BIN_EXE_veistra-echo-tool` is set by Cargo only for tests that live
//! in *this* package (the one that declares the `[[bin]]`), which is why
//! this test can't move to `veistra-rpc` -- see the README for why that's also
//! the right way to resolve the binary inside this workspace at all.
//!
//! Every call below passes an explicit short timeout rather than relying on
//! `call`'s 30s default: if a regression turns a request into a hang, the
//! test should fail in a couple of seconds, not sit for half a minute.

use serde_json::json;
use std::path::Path;
use std::time::Duration;
use veistra_rpc::{ToolProcess, INVALID_PARAMS, METHOD_NOT_FOUND, TOOL_EXITED};

const T: Duration = Duration::from_secs(5);

// Clippy exempts `#[test]` functions from the §5 ban on `expect` (see
// `clippy.toml`) but does not recognise a helper called only from one. The
// judgement is the same: in a test a panic *is* the failure report.
#[expect(
    clippy::expect_used,
    reason = "test helper; a panic is the failure report"
)]
fn spawn() -> ToolProcess {
    let bin = Path::new(env!("CARGO_BIN_EXE_veistra-echo-tool"));
    let cwd = std::env::current_dir().expect("cwd");
    ToolProcess::spawn(bin, &["--veistra-rpc".to_string()], &cwd, "echo")
        .expect("failed to spawn veistra-echo-tool")
}

#[test]
fn handshake_echo_upper_and_shutdown() {
    let tool = spawn();

    let hello = tool
        .call_timeout(
            "veistra/hello",
            Some(json!({"protocol": 1, "session": {"projectPath": null}})),
            T,
        )
        .expect("veistra/hello should succeed");
    assert_eq!(
        hello,
        json!({"id": "echo", "version": "0.1.0", "protocol": 1})
    );

    let echoed = tool
        .call_timeout("echo", Some(json!({"text": "hi"})), T)
        .expect("echo should succeed");
    assert_eq!(echoed, json!({"text": "hi"}));

    let upper = tool
        .call_timeout("echo/upper", Some(json!({"text": "hi"})), T)
        .expect("echo/upper should succeed");
    assert_eq!(upper, json!({"text": "HI"}));

    let err = tool
        .call_timeout("echo/upper", Some(json!({})), T)
        .expect_err("echo/upper with no text should fail");
    assert_eq!(err.code, INVALID_PARAMS);

    let err = tool
        .call_timeout("frobnicate", None, T)
        .expect_err("unknown method should fail");
    assert_eq!(err.code, METHOD_NOT_FOUND);

    tool.shutdown().expect("shutdown should succeed");
}

#[test]
fn notify_pushes_a_notification() {
    let tool = spawn();

    let result = tool
        .call_timeout("echo/notify", None, T)
        .expect("echo/notify should succeed");
    assert_eq!(result, serde_json::Value::Null);

    let notif = tool
        .notifications()
        .recv_timeout(T)
        .expect("expected a notification after echo/notify");
    assert_eq!(notif.method, "echo/notified");

    tool.shutdown().expect("shutdown should succeed");
}

#[test]
fn a_dead_tool_fails_its_pending_call_with_tool_exited() {
    let tool = spawn();

    // `echo/die` exits the process without ever writing a reply -- the only
    // way to genuinely trigger the host's EOF-drains-the-pending-map path
    // rather than asserting it against a mock.
    let err = tool
        .call_timeout("echo/die", None, T)
        .expect_err("a tool that exits mid-call should fail the call, not hang it");
    assert_eq!(err.code, TOOL_EXITED);
}
