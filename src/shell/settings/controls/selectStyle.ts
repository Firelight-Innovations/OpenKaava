/**
 * Which drawing a select setting gets. Pure, so the rule is testable.
 *
 * A short enum is a segmented control, because every option is visible and one
 * click away. A longer or wordier one is a dropdown, because a segmented track
 * that has to wrap is worse than a menu. The accent is neither: its options are
 * colours, so it is a row of swatches.
 */
import type { SelectOption } from "../../../bindings";

export type SelectStyle = "segmented" | "swatches" | "menu";

/** The setting key whose options are colour names `tokens.css` has a trio for. */
export const ACCENT_KEY = "appearance.accentColor";

/** The most options a segmented track carries before it becomes a menu. */
const SEGMENTED_MAX_OPTIONS = 4;

/** The most label characters, summed, that a segmented track carries. */
const SEGMENTED_MAX_CHARS = 28;

export function selectStyle(key: string, options: readonly SelectOption[]): SelectStyle {
  if (key === ACCENT_KEY) return "swatches";
  const chars = options.reduce((sum, option) => sum + option.label.length, 0);
  return options.length <= SEGMENTED_MAX_OPTIONS && chars <= SEGMENTED_MAX_CHARS
    ? "segmented"
    : "menu";
}
