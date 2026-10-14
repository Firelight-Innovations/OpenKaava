# Agent host: pinned versions

The versions each harness was tested with, on Windows 11. A descriptor in
`crates/kaava-agent-host/src/harness/` pins each adapter version listed here. Another version still
runs, and the tab shows the `adapterVersion` hint for it. See `docs/agent-harnesses.md`.

| Harness | Program | Version | Source | Tested |
|---|---|---|---|---|
| Claude | `claude` | 2.1.296 | the user's own install | 2026-10-14 |
| Claude | `@agentclientprotocol/claude-agent-acp` | 0.90.0 | the user's global npm install, `--omit=optional` | 2026-10-14 |
