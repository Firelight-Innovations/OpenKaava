/** `keys.copilotAction` as the shell reads it: a value the shell knows how to run. */
import { narrowCopilotAction, type CopilotAction } from "../copilotKey";
import type { SettingsSession } from "./useSettings";

export const COPILOT_ACTION_KEY = "keys.copilotAction";

/**
 * The stored action, narrowed. Before the first snapshot lands `valueOf` has
 * nothing to read, and the default applies, which is what a fresh install
 * would say anyway.
 */
export function readCopilotAction(session: SettingsSession): CopilotAction {
  const setting = session.groups
    .flatMap((group) => group.settings)
    .find((s) => s.key === COPILOT_ACTION_KEY);
  return narrowCopilotAction(setting === undefined ? null : session.valueOf(setting));
}
