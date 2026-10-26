# Agent harnesses

A harness is a coding agent the agent tab can run: Claude and Codex today, with Pi next. This page
describes the boundary between a harness and the rest of OpenKaava, and how to add a harness.

`src-tauri/src/harness.rs` is a different thing. It recognises a harness that runs in a terminal, so
that a dropped file is quoted the way that harness reads it. Nothing on this page touches it.

## The boundary

```text
agent tab ── agent-tab/* ── AgentHost ── Adapter ── harness process
             (src-tauri)    (crate)      (trait)    (ACP on stdio)
```

- **The registry.** `crates/kaava-agent-host/src/harness.rs` holds one `Descriptor` per harness,
  in `REGISTRY`. The host and `agent-tab/harnesses` read these facts about a harness from the
  registry and nowhere else:
  - its name
  - its programs
  - how the user installs it and signs in to it
  - the mode it starts in
  - what it supports

  The UI does not read them all yet. A registered harness's name, install command and sign-in
  reach the agent tab in `HarnessInfo`. The tab's `strings.ts` keeps a fallback name in
  `harnessName` only for a harness the host does not report.
- **The event model.** `apps/agent-tab/ui/src/protocol.generated.ts` is generated from the types
  in `event.rs`, and it is the only thing the UI reads. No harness's wire format reaches the UI.
- **The `Adapter` trait.** `host.rs` drives every session through it. `Session` implements it over
  ACP, for every descriptor whose `protocol` is `Protocol::Acp`. A harness that does not speak ACP
  gets its own type that implements `Adapter` and translates, and a new `Protocol` variant that
  `AgentHost::send` maps to that type.
- **`agent-tab/harnesses`.** It answers one `HarnessInfo` per descriptor, with these fields:
  - the harness's name
  - what stands in its way, as a `Hint`
  - the commands that set it up: sign in, install the pinned adapter
  - its capabilities
  - `models`: the models its agent offers, or `null` until the agent has said (see
    [Models](#models))
  - `model`: the model its next session starts on, as a value: the tab's choice for that harness,
    else the agent's default. A choice that the agent does not offer is reported as the default,
    since the session never asks for it.

  Asked as an agent tab, it also answers these:
  - `current`: the harness the tab's next prompt goes to
  - `running`: the harness its agent runs, while that agent lives
  - `model`: the name of the model that agent runs, once the agent reports one
- **The harness a tab runs.** Each agent tab chooses its own harness, and the host resolves it in
  this order:
  1. the harness its live agent runs
  2. the harness it chose with `agent-tab/choose`
  3. the first harness in `REGISTRY`

  `agent-tab/choose` refuses with the code `running` while the tab's agent runs another harness.
  The user starts a new session to switch. Each choice emits `agent-tab:chosen`, so every view of
  the tab shows the same harness.

  `agent-tab/choose` also takes an optional `model`: a model's value, or `null` for the agent's
  default. The tab keeps one model for each harness. A call without `model` leaves them all as
  they are, so a caller that chooses a harness only never drops one. A model chosen while
  the tab's agent runs applies to the tab's next session. `agent-tab:chosen` carries the chosen
  harness's model.
- **`agent-tab/send`.** It takes the prompt's `text`, sends it to the tab's harness, and starts
  that harness with `harness::spec` if no agent runs.

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
- Every session that `harness::spec` builds starts in the harness's ask-first mode,
  `Policy::ask_first`. If the agent refuses to switch to it, the session does not run.
- The tab must never offer two kinds of mode:
  - a mode in which the agent acts without asking
  - a mode in which something other than the user approves a request

  The worktree guard checks each `session/request_permission`, and a mode like these skips that
  request, so the guard never sees what the agent does. Name those modes when you verify the
  adapter (step 1), and add their ids to `config::NOT_OFFERED`. The host drops those ids from
  every option's choices, and never starts a session in one.
- `env` never carries a credential.
- The UI calls a harness by its short name: "Claude", "Codex", "Pi".

## What the UI shows

The agent tab draws every registered harness from `agent-tab/harnesses`, by the name the host
reports. Its own strings name no program or version. The tab's settings menu also lists harnesses
that are not registered yet, as "Coming soon", by the fallback names in `harnessName`.

- **The picker.** The tab's settings menu has a group per harness, listing its models, or only
  its default until its agent has said (see [Models](#models)). Choosing a model chooses that
  harness and that model. While the tab's agent runs, the menu cannot switch harness. A model
  chosen under the running harness changes that agent's model at once, through
  `agent-tab/set-config`. A choice under any other harness is ignored.
- **The model.** While an agent runs, the tab's header shows its harness and its model.
- **Hints.** Each `Hint` is a sentence template in the tab's `apps/agent-tab/ui/src/strings.ts`.
  A template fills in the harness's name and its setup commands from `HarnessInfo`, so a new
  harness gets correct install and sign-in hints without a new string. `tsc` holds the tab's table
  to `Hint`, so a new `Hint` needs a sentence in the tab. An error item records the harness that
  raised it, so its hint names that harness after the tab switches to another.

## Models

ACP has no request that lists an agent's models outside a session. So the host asks for them:

1. A tab calls `agent-tab/harnesses`, with developer mode on and a worktree to run in. The tab
   does this when it opens. The shell makes the same call as the cluster's agent tab
   (`useAgentTabRefresh`, in `src/shell/state/agentTab.ts`). It calls when the tab mounts, when a
   setting or the cluster's environment changes, and when the tab's session starts or resets.
2. For each installed harness that it has not asked in that worktree this launch, the host starts
   the harness's adapter there. It sends `initialize` and `session/new`, and nothing else.
3. It reads the option of category `model` from the reply to `session/new`, and kills the agent.
4. It sends `agent-tab:models` to each open agent tab, and the tab calls `agent-tab/harnesses`
   again.

The ask never sends a prompt, so it uses none of the user's quota. It starts the user's agent
once per launch for each harness and worktree, as a session would. The agent therefore starts its
own MCP servers and hooks too, and Codex treats the worktree as trusted, as it does for every
session Kaava starts. The host asks each worktree separately because a project's settings can
narrow the list or change the default. Claude reads them from the worktree's
`.claude/settings.json`, and Codex from its project config.

A harness lists no models in these cases:

- **A signed-out Codex.** It refuses `session/new`. Claude's adapter opens a session while signed
  out, so Claude lists its models; its first prompt then reports the sign-out.
- **A slow agent.** The host kills an agent that does not answer a request within 60 seconds, the
  time a session's handshake gives it.

The host asks such a harness once more, when a tab asks for the harnesses while a session of that
harness has reported its model. That report shows that the agent is signed in.

While a session runs, its models are in `SessionStatus.config`.

**The model a session starts on.** `agent-tab/send` puts the tab's model in `LaunchSpec.model`.
After `session/set_mode`, the handshake sends `session/set_config_option` for the `model` option.
The session reports that it is ready after this request. A model that the agent no longer offers is
never sent. If the agent refuses the model, the session stays on the agent's default, and the host
logs this. The status shows the model that the session actually runs. The exception is an agent that
answers the switch only after the handshake's 60 seconds; the status then keeps the default.

## Codex

`harness/codex.rs` runs the user's own `codex` through `@agentclientprotocol/codex-acp`, which
starts `codex app-server` and speaks ACP for it. The user installs the adapter with
`--omit=optional`. The adapter depends on `@openai/codex`, which carries its native `codex` binary
in optional, per-platform packages, so npm installs the wrapper without that binary. The host
sets `CODEX_PATH` to the user's `codex`, and the adapter runs that one. The user signs in with
`codex login` in a terminal. A signed-out `session/new` answers `auth_required`, and the tab shows the `signedOut`
hint. The adapter never inherits `DEFAULT_AUTH_REQUEST` (`Descriptor::env_remove`): with it set, a
signed-out session would sign itself in, and `chat-gpt` opens a browser.

**Modes.** Each Codex mode joins an approval policy and a sandbox:

| Mode id | Name | Who approves a request | Sandbox | OpenKaava |
|---|---|---|---|---|
| `read-only` | Read-only | the user | reads anywhere | every session starts here |
| `workspace-write` | Workspace access | the user | also writes the workspace and temp | allowed |
| `agent` | Auto review | a reviewer model | also writes the workspace and temp | held back |
| `agent-full-access` | Full access | nobody | none | held back |

A command that stays inside its sandbox runs without a request. In both modes the tab allows, that
means a sandboxed command reads any file on the disk without asking. In `workspace-write` it also
writes the worktree, `TMPDIR` and `/tmp` without asking. A request reaches the user, and the guard,
only when a command needs more than its sandbox grants.

The owner decided both points on 2026-10-15: `workspace-write` is allowed, and a sandboxed command
may read without asking. Claude's `default` asks before every command, so Codex asks less. Making
it match would need an approval policy of `untrusted` or a narrower sandbox, and codex-acp 2.2.2
offers neither as a mode.

`agent` is the adapter's default. A reviewer model approves requests in it, so those requests skip
the guard, as in Claude's `auto`. `agent-full-access` is Codex's equivalent of Claude's
`bypassPermissions`. Both ids are in `config::NOT_OFFERED`. The descriptor sets
`INITIAL_AGENT_MODE=read-only`, so the session opens in `read-only` before the host's own
`set_mode`, and never runs in `agent`.

**Settings.** The adapter reports these select options, and the host passes each one to the tab in
`SessionStatus.config`. `agent-tab/harnesses` lists the models before a session starts (see
[Models](#models)). While an agent runs, the tab's header shows the model. The
tab has no control for the other options yet.

- `model`: the model
- `reasoning_effort`: the effort, only for a model that has levels
- `collaboration_mode`: `default` or `plan`
- `fast-mode`: `on` or `off`, only for a model that supports it

**The guard.** A command request carries its working directory as `rawInput.cwd`. A sandbox
request carries what it grants under `permissions` or `additionalPermissions`, as
`fileSystem.read`, `fileSystem.write` and `entries`. The approval card lists all of it, and
`guard::escapes` refuses the request without asking if any part is outside the worktree:

- A path is resolved against the worktree, as any other path is.
- A glob pattern is checked by the folder its literal start names, so `src/**` is checked as
  `src/`. A pattern has no such folder, and is refused, if it starts with a wildcard or with `~`,
  or if a part after its first wildcard holds `..`.
- An entry of type `special` is a named scope. The project, which is the worktree, is checked by
  its subpath. Every other scope is refused: the whole disk, the temp folders, and any kind Codex
  adds later.
- An entry whose access is `deny` grants nothing, and is skipped.
- A file change's request names the files it edits, and a moved file by its source only. A move's
  destination is in the diff that the change reported when it started, so the guard also checks
  every file the same tool call named before. A command's files count the same way, whether or not
  it has started. The adapter drops a diff over 1 MiB, path and all, so a move with a diff that
  large is not checked.

## Adding a harness

1. **Verify first.** Install the adapter in a scratch directory. Run `initialize` and
   `session/new` against a scratch git repository, and record what the adapter answers:
   - its modes, which one asks before acting, and which ones skip the user's approval
   - its config options
   - the kinds of its approval options
   - what a signed-out session answers

   Do not send a prompt that spends the user's quota without asking them.
2. **Add the variant.** Add it to `Harness` in `harness.rs` and to the match in
   `Harness::descriptor`. The compiler then lists each match that must handle it. It cannot check
   `REGISTRY`, which is a plain list. The test `every_variant_has_a_row_in_the_registry` checks it
   instead, and fails until step 3 adds the variant there.
3. **Write the descriptor.** Create `harness/<name>.rs` with one `Descriptor`, modelled on
   `harness/claude.rs`. Declare it in `harness.rs` with `mod <name>;` and
   `pub use <name>::<NAME>;`, and add it to `REGISTRY`. The struct documents each field.
4. **Extend the guard if needed.** `guard::request_paths` reads the paths that a permission
   request names, and the session adds the files its tool call named earlier.
   `guard::request_scope` adds where a command runs and what a sandbox grant opens, and the
   approval card shows it all. `guard::escapes` refuses any part of it outside the
   worktree, or that no path stands for. If the new adapter puts paths under keys that none of
   these reads, add those keys, with a test.
5. **Regenerate the TypeScript types.** Run
   `KAAVA_BLESS=1 cargo test -p kaava-agent-host generated_types`. The new id joins the `Harness`
   union. The tab's settings menu lists the new harness, and no UI code changes.
6. **Record the version.** Add a row to `docs/agent-host-versions.md`.
7. **Run `pnpm verify`.**
