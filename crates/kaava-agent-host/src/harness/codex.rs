//! Codex: the unmodified `codex` binary, signed in by the user with `codex
//! login`, driven through the ACP adapter `codex-acp`, which runs `codex
//! app-server` and speaks ACP for it (design AGT-004). The adapter is told
//! where the user's `codex` is through `CODEX_PATH`, so it never runs the copy
//! npm would bundle with it.
//!
//! Each Codex mode is an approval policy and a sandbox together. Kaava asks
//! first in `read-only`, and `INITIAL_AGENT_MODE` starts the session there, so
//! it is never in the adapter's own default, auto review, even before the
//! host's first `set_mode`. Auto review and full access are never offered
//! (`config::NOT_OFFERED`). No token, config file or auth request is passed.

use super::{AcpAdapter, Capabilities, Descriptor, Harness, Policy, Protocol};

/// Codex, through `codex-acp`.
pub static CODEX: Descriptor = Descriptor {
    harness: Harness::Codex,
    name: "Codex",
    cli: "codex",
    cli_env: "CODEX_PATH",
    adapter: AcpAdapter {
        program: "codex-acp",
        package: "@agentclientprotocol/codex-acp",
        version: "2.2.2",
    },
    sign_in: "codex login",
    env: &[("INITIAL_AGENT_MODE", "read-only")],
    // `read-only` asks before editing a file or using the network.
    policy: Policy {
        ask_first: "read-only",
    },
    protocol: Protocol::Acp,
    capabilities: Capabilities {
        steer: false,
        fork: false,
        modes: false,
    },
};
