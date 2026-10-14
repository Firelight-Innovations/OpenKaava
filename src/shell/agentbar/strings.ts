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
  // Not the tab's "Message the agent": both can be on screen at once, and a
  // field is found by its name.
  promptLabel: "Message the agent from the agent bar",
  placeholder: "Ask Claude to do something in this worktree. Enter sends.",
  send: "Send",
  sending: "Sending",
  // Only what `agent-tab/harnesses` can answer before anything has started:
  // `claude_spec` fails with one of these two. The hints a running session
  // earns (signed out, another adapter version, a path outside the worktree)
  // are the agent tab's to show, from its own strings.
  hint: {
    harnessMissing: "Claude is not installed. Install it, then run `claude` once to sign in.",
    adapterMissing: `The Claude ACP adapter is not installed. Run \`${ADAPTER_INSTALL}\`.`,
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
