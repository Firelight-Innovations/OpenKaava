/**
 * Every word the agent bar shows. The agent tab has its own
 * `apps/agent-tab/ui/src/strings.ts`; the shell may not import an app's
 * source, so the few strings both need are kept here as well (handoff §11).
 * The harness is "Claude", never "Claude Code".
 */
import type { BarHarnessInfo } from "../state/agentBar";

/**
 * What a hint sentence names: the harness, and the commands that set it up.
 * Both come from the registry in Rust (`agent-tab/harnesses`), so no sentence
 * here names a harness, a program or a version of its own.
 */
export type HarnessWords = Pick<BarHarnessInfo, "name" | "setup">;

/**
 * The hints the bar words: the two of the host's `Hint` union that
 * `agent-tab/harnesses` can report. The union lives in the tab's
 * `protocol.generated.ts`, which the shell may not import, so
 * `strings.test.ts` checks that each of these is still in it.
 */
export type BarHint = "harnessMissing" | "adapterMissing";

export const strings = {
  label: "Agent bar",
  harnessLabel: "Harness",
  harnessLocked: "Start a new session in the agent tab to switch harness",
  // Not the tab's "Message the agent": both can be on screen at once, and a
  // field is found by its name.
  promptLabel: "Message the agent from the agent bar",
  placeholder: "Ask the agent to do something in this worktree. Enter sends.",
  send: "Send",
  sending: "Sending",
  // Only what `agent-tab/harnesses` can answer before anything has started:
  // `spec` fails with one of these two. The hints a running session
  // earns (signed out, another adapter version, a path outside the worktree)
  // are the agent tab's to show, from its own strings.
  hint: {
    harnessMissing: ({ name, setup }: HarnessWords) =>
      `${name} is not installed. Install it, then run \`${setup.signIn}\` once to sign in.`,
    adapterMissing: ({ name, setup }: HarnessWords) =>
      `The ${name} ACP adapter is not installed. Run \`${setup.adapterInstall}\`.`,
  } satisfies Record<BarHint, (words: HarnessWords) => string>,
  notReady: (name: string) => `${name} is not ready to run.`,
  refusal: {
    notAWorktree: "Agents run in a local worktree. Create a worktree cluster to start one.",
    mainCheckout: "This is a main checkout. Agents never run on main.",
    wrongWorktree: "That session belongs to another worktree. Start a new session in the tab.",
    busy: "The agent is still working. Stop it in the agent tab, or wait.",
    harness: "The agent is not ready to run.",
    running: "The agent tab runs another harness. Start a new session there to switch.",
    spawn: "The agent could not be started.",
  } as Record<string, string>,
  /** A call that failed for a reason that is not a refusal, by what it was doing. */
  failed: {
    send: "Could not send that.",
    choose: "Could not switch the harness.",
  },
};
