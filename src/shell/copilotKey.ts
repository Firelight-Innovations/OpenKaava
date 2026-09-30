/**
 * The Windows Copilot key, as a page sees it: a `keydown` for F23, normally
 * with Win and Shift held. What it does is the `keys.copilotAction` setting;
 * the ids below match the options in `settings/schema.rs`.
 */

/** What the shell can be asked to do when the key is pressed. */
export const COPILOT_ACTIONS = [
  "palette",
  "search",
  "switchProject",
  "newCluster",
  "toggleGit",
  "toggleTerminal",
  "none",
] as const;

export type CopilotAction = (typeof COPILOT_ACTIONS)[number];

/** Out of the box the key opens the Command Palette. */
export const DEFAULT_COPILOT_ACTION: CopilotAction = "palette";

/**
 * An unknown stored value falls back to the default, never to "none". The
 * removed side-panel action maps to the Git page, which replaced it.
 */
export function narrowCopilotAction(value: unknown): CopilotAction {
  if (value === "togglePanel") return "toggleGit";
  return (COPILOT_ACTIONS as readonly unknown[]).includes(value)
    ? (value as CopilotAction)
    : DEFAULT_COPILOT_ACTION;
}

/** F23 with any subset of Win and Shift; Ctrl or Alt makes it someone's own chord. */
export function isCopilotKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey">): boolean {
  return e.key === "F23" && !e.ctrlKey && !e.altKey;
}

/** The callbacks an action id can resolve to; `WindowRoot` supplies them. */
export type CopilotHandlers = Record<Exclude<CopilotAction, "none">, () => void>;

/**
 * Run the configured action. True when the key was taken, so the caller knows
 * to `preventDefault`; false for "none", which leaves the key to Windows.
 */
export function dispatchCopilotKey(action: CopilotAction, handlers: CopilotHandlers): boolean {
  if (action === "none") return false;
  handlers[action]();
  return true;
}
