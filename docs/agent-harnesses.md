# Agent harnesses

A harness is a coding agent the agent tab can run: Claude today, with Codex and Pi next. This page
describes the boundary between a harness and the rest of OpenKaava, and how to add a harness.

## The boundary

```text
agent tab, agent bar ── agent-tab/* ── AgentHost ── Adapter ── harness process
                        (src-tauri)    (crate)      (trait)    (ACP on stdio)
```

- **The registry.** `crates/kaava-agent-host/src/harness.rs` holds one `Descriptor` per harness,
  in `REGISTRY`. Only the registry knows these facts about a harness:
  - its name
  - its programs
  - how the user installs it and signs in to it
  - the mode it starts in
  - what it supports
- **The event model.** `event.rs` is generated to `apps/agent-tab/ui/src/protocol.generated.ts`,
  and it is the only thing the UI reads. No harness's wire format reaches the UI.
- **The `Adapter` trait.** `host.rs` drives every session through it. `Session` implements it over
  ACP, for every descriptor whose `protocol` is `Protocol::Acp`. A harness that does not speak ACP
  gets its own type that implements `Adapter` and translates, and a new `Protocol` variant that
  `AgentHost::send` maps to that type.
- **`agent-tab/harnesses`.** It answers one `HarnessInfo` per descriptor, with these fields:
  - the harness's name
  - what stands in its way, as a `Hint`
  - the commands that set it up: sign in, install the pinned adapter
  - its capabilities
- **`agent-tab/send`.** It takes a harness id from the registry and resolves the id with
  `harness::spec`.

## Rules every harness follows

These rules come from handoff §0 and design AGT-002 and AGT-004. Review refuses a descriptor that
breaks one.

- OpenKaava runs the user's own, unmodified binary, signed in by the user. It never reads, stores
  or logs a token, and never starts a sign-in flow. `sign_in` is a command the user runs in their
  own terminal.
- ACP is the wire protocol. A harness without ACP gets a translating adapter behind the same
  `Adapter` trait, never a second UI.
- The user installs the adapter, pinned to a tested version. Record that version in
  `docs/agent-host-versions.md`.
- Every session starts in the harness's ask-first mode, `Policy::ask_first`. If the agent refuses
  to switch to it, the session does not run.
- The tab holds back two kinds of mode: a mode in which the agent acts without asking, and one in
  which something other than the user approves a request. The worktree guard sees only the
  approvals the user answers.
- `env` never carries a credential.
- The UI calls a harness by its short name: "Claude", "Codex", "Pi".

## Adding a harness

1. **Verify first.** Install the adapter in a scratch directory. Run `initialize` and
   `session/new` against a scratch git repository, and record what the adapter answers:
   - its modes, and which one asks before acting
   - its config options
   - the kinds of its approval options
   - what a signed-out session answers

   Do not send a prompt that spends the user's quota without asking them.
2. **Add the variant.** Add it to `Harness` in `harness.rs` and to the match in
   `Harness::descriptor`. The compiler then lists each other place that must handle it.
3. **Write the descriptor.** Create `harness/<name>.rs` with one `Descriptor`, modelled on
   `harness/claude.rs`, and add it to `REGISTRY`. The struct documents each field.
4. **Extend the guard if needed.** `guard::request_paths` reads the paths that a permission
   request names. If the new adapter puts paths under keys that it does not read, add those keys,
   with a test.
5. **Regenerate the TypeScript types.** Run
   `KAAVA_BLESS=1 cargo test -p kaava-agent-host generated_types`. The new id joins the `Harness`
   union.
6. **Record the version.** Add a row to `docs/agent-host-versions.md`.
7. **Run `pnpm verify`.**
