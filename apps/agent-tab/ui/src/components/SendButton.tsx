import { ArrowUp } from "lucide-react";
import { strings } from "../strings";
import type { SendButtonProps } from "./types";
import "./composer.css";

/** A round accent button with an arrow; its name is still "Send". */
export function SendButton({ disabled, onClick }: SendButtonProps) {
  return (
    <button
      type="button"
      className="at-round at-round--send"
      aria-label={strings.send}
      title={strings.send}
      disabled={disabled}
      onClick={onClick}
    >
      <ArrowUp size={16} aria-hidden="true" />
    </button>
  );
}
