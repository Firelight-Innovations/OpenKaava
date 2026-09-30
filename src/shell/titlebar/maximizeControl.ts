/**
 * What the middle window button is, given whether the window is maximised.
 *
 * Windows draws a single square while the window can be maximised and two
 * overlapping squares while a click would restore it. The name follows the
 * icon, so a screen reader says what the button will do next.
 */
export interface MaximizeControl {
  icon: "maximise" | "restore";
  label: "Maximise" | "Restore";
}

export function maximizeControl(maximized: boolean): MaximizeControl {
  return maximized
    ? { icon: "restore", label: "Restore" }
    : { icon: "maximise", label: "Maximise" };
}
