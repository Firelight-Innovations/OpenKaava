import { strings } from "../strings";
import type { StopButtonProps } from "./types";

export function StopButton({ onClick }: StopButtonProps) {
  return (
    <button
      type="button"
      className="k-btn k-btn--secondary k-btn--sm"
      title={strings.stopTurnHint}
      onClick={onClick}
    >
      {strings.stopTurn}
    </button>
  );
}
