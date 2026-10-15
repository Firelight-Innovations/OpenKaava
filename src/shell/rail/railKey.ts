/** How many rail pages Alt and a digit reach: Alt+1 to Alt+7. */
export const RAIL_KEYS = 7;

/**
 * The rail page number an Alt+digit press asks for, or `null` for any other
 * key. Alt alone: with Ctrl, Shift or Meta it is some other shortcut.
 */
export function railKeyOf(
  e: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "key">,
): number | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const n = Number(e.key);
  return Number.isInteger(n) && n >= 1 && n <= RAIL_KEYS ? n : null;
}
