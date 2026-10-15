// Generated from crates/kaava-agent-host/src/event.rs by ts-rs. Do not edit.
// Regenerate: KAAVA_BLESS=1 cargo test -p kaava-agent-host generated_types

export type Harness = "claude";

export type Capabilities = { 
/**
 * Add to a running turn without stopping it.
 */
steer: boolean, 
/**
 * Branch a thread.
 */
fork: boolean, 
/**
 * Switch between the agent's modes.
 */
modes: boolean, };

export type Setup = { 
/**
 * The harness's own program.
 */
cli: string, 
/**
 * The command that signs in.
 */
signIn: string, 
/**
 * The command that installs the tested adapter.
 */
adapterInstall: string, 
/**
 * The adapter version this build was tested with.
 */
adapterVersion: string, };

export type Envelope = { 
/**
 * The agent tab's instance id: which tab this belongs to.
 */
instanceId: string, 
/**
 * Strictly increasing within a tab, across its sessions. A tab that
 * attached at `seq = n` drops every live event at or below `n`.
 */
seq: number, 
/**
 * What happened.
 */
event: Event, };

export type Event = { "type": "status", 
/**
 * The new status.
 */
status: SessionStatus, } | { "type": "turnStarted", 
/**
 * Unique within the session.
 */
turnId: string, } | { "type": "turnCompleted", 
/**
 * The turn that ended.
 */
turnId: string, 
/**
 * Why it ended.
 */
stopReason: string, } | { "type": "itemStarted", 
/**
 * Its state so far.
 */
item: Item, } | { "type": "itemDelta", 
/**
 * The item that grew.
 */
itemId: string, 
/**
 * The text to append.
 */
text: string, } | { "type": "itemUpdated", 
/**
 * The item, replaced.
 */
item: Item, } | { "type": "itemCompleted", 
/**
 * The item, replaced and closed.
 */
item: Item, } | { "type": "reset" };

export type Item = { 
/**
 * Unique within the session. Minted by the host, never by the agent.
 */
id: string, 
/**
 * The turn this item belongs to.
 */
turnId: string, 
/**
 * What kind of item, and its content.
 */
kind: ItemKind, };

export type ItemKind = { "kind": "userMessage", 
/**
 * The prompt text.
 */
text: string, } | { "kind": "assistantText", 
/**
 * Markdown.
 */
text: string, } | { "kind": "reasoning", 
/**
 * Plain text.
 */
text: string, } | { "kind": "toolCall", 
/**
 * The agent's one-line summary of the call.
 */
title: string, 
/**
 * ACP's tool kind: `read`, `edit`, `execute`, `search`, ...
 */
toolKind: string, 
/**
 * Where the call is.
 */
status: ToolStatus, 
/**
 * Text output, cut at [`crate::normalize::OUTPUT_LIMIT`] bytes.
 */
output: string, 
/**
 * Whether `output` was cut.
 */
truncated: boolean, 
/**
 * Files the call reads or changes.
 */
paths: Array<string>, 
/**
 * The changes it makes, when it edits files.
 */
diffs: Array<FileDiff>, } | { "kind": "approval", 
/**
 * What the agent wants to do.
 */
title: string, 
/**
 * The tool call this is about, when the agent named one.
 */
toolCallId: string | null, 
/**
 * The exact command, or what the agent says the call is for. Cut at
 * 64 KiB, and `detail_truncated` says so.
 */
detail: string | null, 
/**
 * `detail` is not all of it. The card must say so, since the user
 * decides on what they can read.
 */
detailTruncated: boolean, 
/**
 * Every file the request names, resolved against the worktree.
 */
paths: Array<string>, 
/**
 * The changes it would make, when it edits files.
 */
diffs: Array<FileDiff>, 
/**
 * The choices the agent offered, in its order, without `allow_always`:
 * a standing allow would make the agent stop asking, and the path guard
 * only sees what it asks about.
 */
options: Array<ApprovalOption>, 
/**
 * The chosen option's id, `cancelled`, `outside` (refused by the host
 * because a path left the worktree), or `None` while waiting.
 */
answer: string | null, } | { "kind": "plan", 
/**
 * The steps.
 */
entries: Array<PlanEntry>, } | { "kind": "usage", 
/**
 * Tokens in the context window now.
 */
used: number, 
/**
 * The window's size.
 */
size: number, } | { "kind": "error", 
/**
 * What failed, with token- and email-shaped strings masked.
 */
message: string, 
/**
 * A known cause the agent tab can explain, if there is one.
 */
hint: Hint | null, };

export type ToolStatus = "pending" | "inProgress" | "completed" | "failed";

export type FileDiff = { 
/**
 * The file, as the agent named it.
 */
path: string, 
/**
 * Its text before, or `None` for a new file.
 */
oldText: string | null, 
/**
 * Its text after.
 */
newText: string, 
/**
 * One side was over [`crate::normalize::DIFF_LIMIT`] bytes, so both
 * texts were dropped and only the path is kept.
 */
tooLarge: boolean, };

export type ApprovalOption = { 
/**
 * What to send back to choose it.
 */
optionId: string, 
/**
 * ACP's kind: `allow_once`, `allow_always`, `reject_once` or
 * `reject_always`. Decides the button's style, not its label.
 */
kind: string, 
/**
 * The agent's own label, shown as it is: only the agent knows what, say,
 * its "always" saves to.
 */
name: string, };

export type PlanEntry = { 
/**
 * What the step is.
 */
content: string, 
/**
 * `pending`, `in_progress` or `completed`, as ACP sends it.
 */
status: string, 
/**
 * `high`, `medium` or `low`, as ACP sends it.
 */
priority: string, };

export type SessionState = "starting" | "ready" | "working" | "needsInput" | "stopped" | "failed";

export type Hint = "harnessMissing" | "adapterMissing" | "signedOut" | "adapterVersion" | "outsideWorktree";

export type SessionStatus = { 
/**
 * Where it is.
 */
state: SessionState, 
/**
 * Which harness.
 */
harness: Harness, 
/**
 * The working directory: the cluster's worktree.
 */
cwd: string, 
/**
 * The agent's current mode id (Claude: `default` is ask-before-acting),
 * as the agent reports it, even one the tab does not offer. Empty until
 * the handshake has switched the agent to ask-first.
 */
mode: string | null, 
/**
 * The modes the tab may switch to, in the agent's order. Bypass and auto
 * are never among them (`config::NOT_OFFERED`).
 */
modes: Array<ConfigChoice>, 
/**
 * The agent's other session settings — model, effort, fast mode — as it
 * last reported them. Filled from the `session/new` reply, so a session
 * that fails later in its handshake still carries them.
 */
config: Array<ConfigOption>, 
/**
 * The number of the last setting change the agent answered. Changing a
 * setting returns the change's number, and numbers only grow, so the tab
 * knows which status answers the choice it is showing. A new session
 * starts past every change made before it.
 */
answered: number, 
/**
 * What went wrong with the last setting change, until the next one is
 * answered. Drawn beside the setting, never in the transcript, so
 * nothing offers to retry it as a prompt.
 */
settingTrouble: SettingTrouble | null, 
/**
 * The adapter's own version, as it reported it at `initialize`.
 */
adapterVersion: string | null, 
/**
 * The process's exit code, once it has exited. Never its output: what an
 * adapter prints on stderr goes to the log, masked, and nowhere else.
 */
exitCode: number | null, 
/**
 * A known cause, if there is one.
 */
hint: Hint | null, 
/**
 * A prompt the host has accepted but not yet started, because the agent is
 * still starting. The transcript draws a prompt only when its turn
 * begins, so this is how the tab shows it meanwhile, and Stop withdraws it.
 */
pendingPrompt: string | null, };

export type SettingTrouble = { "kind": "unanswered", 
/**
 * The change's number.
 */
ticket: number, } | { "kind": "refused", 
/**
 * The change's number.
 */
ticket: number, 
/**
 * The agent's reason, masked.
 */
message: string, };

export type ConfigOption = { 
/**
 * What to send back to change it: `model`, `effort`, `fast`, ...
 */
id: string, 
/**
 * The agent's label for it.
 */
name: string, 
/**
 * The agent's longer description, if it gave one.
 */
description: string | null, 
/**
 * ACP's category (`model`, `thought_level`, `model_config`, ...), if any.
 */
category: string | null, 
/**
 * The value in use.
 */
value: string, 
/**
 * The values on offer, in the agent's order, groups flattened.
 */
choices: Array<ConfigChoice>, };

export type ConfigChoice = { 
/**
 * What to send back to choose it.
 */
value: string, 
/**
 * The agent's label for it.
 */
name: string, 
/**
 * The agent's longer description, if it gave one.
 */
description: string | null, };

export type Attachment = { 
/**
 * The session's status, or `None` before the first prompt.
 */
status: SessionStatus | null, 
/**
 * Every item, each in its latest state, oldest first.
 */
items: Array<Item>, 
/**
 * The last sequence number these reflect. Live envelopes at or below it
 * are already in `items`.
 */
seq: number, };

export type HarnessInfo = { 
/**
 * Which harness.
 */
harness: Harness, 
/**
 * Its name in the UI.
 */
name: string, 
/**
 * Why it cannot start, or `None` when it can.
 */
hint: Hint | null, 
/**
 * The commands a hint's sentence names.
 */
setup: Setup, 
/**
 * What the tab may offer for it.
 */
capabilities: Capabilities, };
