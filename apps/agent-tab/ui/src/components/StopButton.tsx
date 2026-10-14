import { strings } from "../strings";
import type { StopButtonProps } from "./types";
import "./composer.css";

/** Where Send was, while the agent works: a round button with a square. */
export function StopButton({ onClick }: StopButtonProps) {
  return (
    <button
      type="button"
      className="at-round at-round--stop"
      aria-label={strings.stopTurn}
      title={strings.stopTurnHint}
      onClick={onClick}
    >
      <span aria-hidden="true">{strings.stopGlyph}</span>
    </button>
  );
}
