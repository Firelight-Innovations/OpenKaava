import { strings } from "../strings";
import { useSlots } from "./registry";
import type { ErrorItemProps } from "./types";
import "./items.css";
import "./errors.css";
import { useState } from "react";
import { Info, CircleAlert, X, RotateCcw } from "lucide-react";
import { friendlyError } from "../errors";

export function ErrorItem({ message, hint, onRetry }: ErrorItemProps) {
  const S = useSlots();
  const [dismissed, setDismissed] = useState(false);
  const error = friendlyError(message);
  if (dismissed) return null;
  return (
    <div className="at-item at-friendly-error" role={error.limited ? "status" : "alert"}>
      <div className="at-friendly-error__icon" aria-hidden="true">
        {error.limited ? <Info size={18} /> : <CircleAlert size={18} />}
      </div>
      <div className="at-friendly-error__body">
        <strong>{error.title}</strong>
        <p>{error.detail}</p>
        {hint !== null && <S.Hint text={hint} />}
        <button type="button" className="at-friendly-error__retry" onClick={onRetry}>
          <RotateCcw size={12} aria-hidden="true" />
          {strings.errors.retry}
        </button>
        {!error.limited && (
          <details>
            <summary>{strings.errors.details}</summary>
            <pre>{message}</pre>
          </details>
        )}
      </div>
      <button
        type="button"
        className="at-friendly-error__dismiss"
        aria-label={strings.errors.dismiss}
        onClick={() => setDismissed(true)}
      >
        <X size={16} />
      </button>
    </div>
  );
}
