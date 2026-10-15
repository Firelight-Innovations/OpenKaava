# Agent host: pinned versions

The versions each harness was tested with, on Windows 11. Each harness's descriptor in
`crates/kaava-agent-host/src/harness/` pins its adapter's version, and only that one. Another
adapter version still runs, and the tab shows the `adapterVersion` hint for it. The program rows
record the version that was tested; nothing pins or checks them. See `docs/agent-harnesses.md`.

| Harness | Program | Version | Source | Tested |
|---|---|---|---|---|
| Claude | `claude` | 2.1.296 | the user's own install | 2026-10-14 |
| Claude | `@agentclientprotocol/claude-agent-acp` | 0.90.0 | the user's global npm install, `--omit=optional` | 2026-10-14 |
| Codex | `codex` | 0.153.0 | the user's own install | 2026-10-14 |
| Codex | `@agentclientprotocol/codex-acp` | 2.2.2 | the user's global npm install, `--omit=optional` | 2026-10-14 |

Codex was tested through `initialize` and `session/new` only, so no prompt spent the user's quota.
The adapter is built against `@openai/codex` 0.160.1, and its handshake works with 0.153.0. A full
turn is still to be run by the owner.
