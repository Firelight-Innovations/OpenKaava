import { strings } from "../strings";
import type { SendButtonProps } from "./types";

export function SendButton({ disabled, onClick }: SendButtonProps) {
  return (
    <button
      type="button"
      className="k-btn k-btn--primary k-btn--sm"
      disabled={disabled}
      onClick={onClick}
    >
      {strings.send}
    </button>
  );
}
