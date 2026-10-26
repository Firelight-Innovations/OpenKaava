/**
 * Every word the agent tab shows. Handoff §0: user-facing strings live in one
 * file, and the harness is "Claude" — never "Claude Code".
 */
import type { HarnessInfo, Hint, SessionState, ToolStatus } from "./protocol.generated";

/**
 * What a hint sentence names: the harness, and the commands that set it up.
 * Both come from the registry in Rust (`agent-tab/harnesses`), so no sentence
 * here names a harness, a program or a version of its own.
 */
export type HarnessWords = Pick<HarnessInfo, "name" | "setup">;

/** At most one decimal, and none when it is zero: 124.6, 300, 1.2. */
function short(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** A token count the way the meters show it: 812, 124.6k, 1.2M. The unit is
 *  chosen after rounding, so 999,960 reads 1M rather than 1000k. */
function tokens(n: number): string {
  if (n < 1000) return `${n}`;
  const thousands = short(n / 1000);
  if (Number(thousands) < 1000) return `${thousands}k`;
  return `${short(n / 1_000_000)}M`;
}

/** A share of 0..1 as a whole percentage. */
function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export const strings = {
  title: "Agent",
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
  sendGlyph: "↑",
  stopGlyph: "■",
  mode: "Mode",
  settings: "Agent settings",
  /** Joins the settings on the button: "Claude · Opus 5.5 · High". */
  settingsJoin: " · ",
  /** The same, as a screen reader hears it. */
  settingsSpoken: ", ",
  /** Every harness the settings menu lists, by id. */
  harnessName: { claude: "Claude", codex: "Codex", kaava: "Kaava" } as Record<string, string>,
  /** A harness that is listed but cannot run yet. */
  harnessSoon: "Coming soon",
  /** A harness the host reports but cannot start, such as one not installed or signed out. */
  harnessNotReady: "Not set up",
  /** A harness whose models are not known: it runs its own default. */
  defaultModel: "Default model",
  tokens,
  percent,
  context: {
    heading: "Context window",
    summary: (used: number, size: number) =>
      `${tokens(used)} / ${tokens(size)} (${percent(Math.min(1, used / size))})`,
    used: "Used",
    free: "Free space",
    meter: (share: number) => `Context window ${percent(share)} full`,
  },
  limits: {
    heading: "Usage",
    used: (share: number) => `${percent(share)} used`,
    meter: (share: number) => `Usage: ${percent(share)} of the tightest limit used`,
  },
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
      ["Shift+Tab", "Switch mode, once the session starts"],
    ] as const,
  },
  modeSettings: {
    modeHint: "What the agent may do without asking you first (Shift+Tab switches)",
    later: "The mode and model appear once the session starts.",
    unanswered: "The agent has not answered that change yet. Later changes wait for it.",
    refused: (reason: string) =>
      reason.trim() === ""
        ? "The agent refused that change."
        : `The agent refused that change: ${reason}`,
  },
  you: "You",
  thinking: "Thinking",
  copy: "Copy",
  copied: "Copied",
  copyTurn: "Copy the agent's text from this turn",
  working: "Working…",
  tool: {
    pending: "Pending",
    inProgress: "Running",
    completed: "Done",
    failed: "Failed",
  } satisfies Record<ToolStatus, string>,
  /** A run of tool calls, folded into one line: "Ran 2 commands, read a file". */
  actions: {
    verb: {
      execute: (n: number) => (n === 1 ? "ran a command" : `ran ${n} commands`),
      read: (n: number) => (n === 1 ? "read a file" : `read ${n} files`),
      edit: (n: number) => (n === 1 ? "edited a file" : `edited ${n} files`),
      search: (n: number) => (n === 1 ? "ran a search" : `ran ${n} searches`),
      fetch: (n: number) => (n === 1 ? "fetched a page" : `fetched ${n} pages`),
      other: (n: number) => (n === 1 ? "used a tool" : `used ${n} tools`),
    },
    join: ", ",
    failed: (n: number) => `${n} failed`,
  },
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
    setting: "Could not change that setting.",
    choose: "Could not switch the harness.",
    harnesses: "Could not list the harnesses.",
  },
  exited: (code: number | null) =>
    code === null ? "The agent stopped." : `The agent stopped with exit code ${code}.`,
  hint: {
    harnessMissing: ({ name, setup }: HarnessWords) =>
      `${name} is not installed, or not on PATH. Install it, then run \`${setup.signIn}\` once in a terminal to sign in.`,
    adapterMissing: ({ name, setup }: HarnessWords) =>
      `The ${name} ACP adapter is not installed. Run \`${setup.adapterInstall}\` in a terminal.`,
    signedOut: ({ name, setup }: HarnessWords) =>
      `${name} is not signed in. Run \`${setup.signIn}\` once in a terminal and sign in there. Kaava never signs you in.`,
    adapterVersion: ({ setup }: HarnessWords) =>
      `This build was tested with adapter ${setup.adapterVersion}. Another version may behave differently: \`${setup.adapterInstall}\`.`,
    outsideWorktree: () =>
      "The agent asked to touch a file outside this worktree, so Kaava refused the request.",
  } satisfies Record<Hint, (words: HarnessWords) => string>,
  /** A hint before the tab knows which harness it is about. */
  hintUnknown: "The agent is not ready to run.",
  notReady: (name: string) => `${name} is not ready to run.`,
  refusal: {
    developerMode: "The agent tab is in testing. Turn on developer mode in Settings to use it.",
    notAWorktree: "Agents run in a local worktree. Create a worktree cluster to start one.",
    mainCheckout: "This is a main checkout. Agents never run on main.",
    noInstance: "This tab is no longer in the layout.",
    wrongWorktree: "This session belongs to another worktree. Start a new session to work here.",
    busy: "The agent is still working. Wait for it, or press Esc to stop it.",
    closed: "The agent has stopped. Send again to start a new session.",
    noSession: "There is no session yet.",
    unknownOption: "The agent does not offer that choice.",
    harness: "The agent is not ready to run.",
    running: "This tab's agent runs another harness. Start a new session to switch.",
    spawn: "The agent could not be started.",
  } as Record<string, string>,
};
