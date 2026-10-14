//! Claude (handoff §5.2): the unmodified `claude` binary, signed in by the
//! user, driven through the ACP adapter `claude-agent-acp`, which the user
//! installs with npm. The adapter is told where the user's `claude` is through
//! `CLAUDE_CODE_EXECUTABLE`, so it never falls back to a copy of its own.
//! Nothing else is passed: no flag, no token, no settings file.

use super::{AcpAdapter, Capabilities, Descriptor, Harness, Policy, Protocol};

/// Claude, through `claude-agent-acp`.
pub static CLAUDE: Descriptor = Descriptor {
    harness: Harness::Claude,
    name: "Claude",
    cli: "claude",
    cli_env: "CLAUDE_CODE_EXECUTABLE",
    adapter: AcpAdapter {
        program: "claude-agent-acp",
        package: "@agentclientprotocol/claude-agent-acp",
        version: "0.90.0",
    },
    sign_in: "claude",
    env: &[],
    // `default` asks before acting. A user whose own default is to act
    // without asking still gets asked here.
    policy: Policy {
        ask_first: "default",
    },
    protocol: Protocol::Acp,
    capabilities: Capabilities {
        steer: false,
        fork: false,
        modes: true,
    },
};
