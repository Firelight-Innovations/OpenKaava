/**
 * Every word the agent tab shows. Handoff §0: user-facing strings live in one
 * file, and the harness is "Claude" — never "Claude Code".
 *
 * The agent bar in the shell has its own `src/shell/agentbar/strings.ts`,
 * because the shell may not import an app's source; see handoff §11.
 */
import type { Harness, Hint, SessionState, ToolStatus } from "./protocol.generated";

export const ADAPTER_VERSION = "0.90.0";
export const ADAPTER_INSTALL = `npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@${ADAPTER_VERSION}`;

export const strings = {
  title: "Agent",
  harness: { claude: "Claude" } satisfies Record<Harness, string>,
  state: {
    starting: "Starting",
    ready: "Ready",
    working: "Working",
    needsInput: "Needs input",
    stopped: "Stopped",
    failed: "Failed",
  } satisfies Record<SessionState, string>,
  idle: "No session",
  newSession: "New session",
  newSessionHint: "Stop the agent and clear this conversation",
  stopTurn: "Stop",
  stopTurnHint: "Stop the current turn (Esc)",
  send: "Send",
  mode: "Mode",
  promptLabel: "Message the agent",
  promptPlaceholder: "Ask the agent to do something in this worktree",
  promptBusy: "The agent is working. Press Esc to stop it.",
  environment: (cwd: string) => `Worktree: ${cwd}`,
  empty: {
    heading: "Start a session",
    body: "The agent works in this cluster's worktree. Approvals and edits show up here.",
    examples: [
      "Explain how this project is laid out",
      "Find the failing test and fix it",
      "Add a README section on building from source",
    ],
    keysHeading: "Keys",
    keys: [
      ["Enter", "Send"],
      ["Shift+Enter", "New line"],
      ["Esc", "Stop the current turn"],
    ] as const,
  },
  you: "You",
  thinking: "Thinking",
  copy: "Copy",
  copied: "Copied",
  copyTurn: "Copy everything the agent wrote in this turn",
  working: "Working…",
  tool: {
    pending: "Pending",
    inProgress: "Running",
    completed: "Done",
    failed: "Failed",
  } satisfies Record<ToolStatus, string>,
  toolGlyph: {
    pending: "○",
    inProgress: "◌",
    completed: "✓",
    failed: "✕",
  } satisfies Record<ToolStatus, string>,
  outputTruncated: "Output truncated. The full output is in the agent's own log.",
  detailTruncated:
    "Only the start of this is shown. Reject it unless you can see what you are allowing.",
  starting: "Starting the agent. Your message is sent once it is ready.",
  files: "Files",
  approval: {
    heading: "Approval needed",
    answered: (name: string) => `Answered: ${name}`,
    cancelled: "Withdrawn",
    outside: "Refused: it named a file outside this worktree",
  },
  plan: "Plan",
  planGlyph: { pending: "○", in_progress: "◐", completed: "●" } as Record<string, string>,
  usage: (used: number, size: number) =>
    `Context: ${used.toLocaleString()} of ${size.toLocaleString()} tokens`,
  diffAdded: (n: number) => `+${n}`,
  diffRemoved: (n: number) => `−${n}`,
  newFile: "new file",
  diffTooLarge: "This change is too large to show here.",
  error: "Error",
  retry: "Retry",
  failed: {
    attach: "Could not reach the agent host.",
    send: "Could not send that.",
  },
  exited: (code: number | null) =>
    code === null ? "The agent stopped." : `The agent stopped with exit code ${code}.`,
  hint: {
    harnessMissing:
      "Claude is not installed, or not on PATH. Install it, then run `claude` once in a terminal to sign in.",
    adapterMissing: `The Claude ACP adapter is not installed. Run \`${ADAPTER_INSTALL}\` in a terminal.`,
    signedOut:
      "Claude is not signed in. Run `claude` once in a terminal and sign in there. Kaava never signs you in.",
    adapterVersion: `This build was tested with adapter ${ADAPTER_VERSION}. Another version may behave differently: \`${ADAPTER_INSTALL}\`.`,
    outsideWorktree:
      "The agent asked to touch a file outside this worktree, so Kaava refused the request.",
  } satisfies Record<Hint, string>,
  refusal: {
    developerMode: "The agent tab is in testing. Turn on developer mode in Settings to use it.",
    notAWorktree: "Agents run in a local worktree. Create a worktree cluster to start one.",
    mainCheckout: "This is a main checkout. Agents never run on main.",
    noInstance: "This tab is no longer in the layout.",
    wrongWorktree: "This session belongs to another worktree. Start a new session to work here.",
    busy: "The agent is still working. Wait for it, or press Esc to stop it.",
    closed: "The agent has stopped. Send again to start a new session.",
    noSession: "There is no session yet.",
    harness: "Claude is not ready to run.",
    spawn: "The agent could not be started.",
  } as Record<string, string>,
};
