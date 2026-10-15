import { strings } from "../strings";
import type { StatusBadgeProps } from "./types";
import "./frame.css";

/** The session's state as a dot and a word, never the colour alone (§2.5). */
export function StatusBadge({ state }: StatusBadgeProps) {
  return (
    <span className={`at-status at-status--${state ?? "idle"}`} role="status">
      <span className="at-status__dot" aria-hidden="true" />
      {state ? strings.state[state] : strings.idle}
    </span>
  );
}
