/**
 * Every word the agent bar shows. The agent tab has its own
 * `apps/agent-tab/ui/src/strings.ts`; the shell may not import an app's
 * source, so the few strings both need are kept here as well (handoff §11).
 * The harness is "Claude", never "Claude Code".
 */
export const ADAPTER_INSTALL =
  "npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.90.0";

export const strings = {
  label: "Agent bar",
  harness: "Claude",
  promptLabel: "Message the agent",
  placeholder: "Ask Claude to do something in this worktree. Enter sends.",
  send: "Send",
  sending: "Sending",
  hint: {
    claudeMissing: "Claude is not installed. Install it, then run `claude` once to sign in.",
    adapterMissing: `The Claude ACP adapter is not installed. Run \`${ADAPTER_INSTALL}\`.`,
    signedOut: "Run `claude` once in a terminal to sign in. Kaava never signs you in.",
    adapterVersion: `Tested with adapter 0.90.0. Run \`${ADAPTER_INSTALL}\` to match.`,
    outsideWorktree: "The agent asked to touch a file outside this worktree.",
  } as Record<string, string>,
  refusal: {
    notAWorktree: "Agents run in a local worktree. Create a worktree cluster to start one.",
    mainCheckout: "This is a main checkout. Agents never run on main.",
    wrongWorktree: "That session belongs to another worktree. Start a new session in the tab.",
    busy: "The agent is still working. Stop it in the agent tab, or wait.",
    harness: "Claude is not ready to run.",
    spawn: "The agent could not be started.",
    failed: "Could not send that.",
  } as Record<string, string>,
};
