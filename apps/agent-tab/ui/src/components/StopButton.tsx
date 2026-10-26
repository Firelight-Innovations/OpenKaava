import { Square } from "lucide-react";
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
      <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
    </button>
  );
}
