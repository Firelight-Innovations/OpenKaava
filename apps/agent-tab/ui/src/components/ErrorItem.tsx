import { strings } from "../strings";
import { useSlots } from "./registry";
import type { ErrorItemProps } from "./types";
import "./items.css";

export function ErrorItem({ message, hint, onRetry }: ErrorItemProps) {
  const S = useSlots();
  return (
    <div className="at-item at-error" role="alert">
      <div className="at-error__message">
        <span aria-hidden="true">✕ </span>
        {strings.error}: {message}
      </div>
      {hint !== null && <S.Hint text={hint} />}
      <button type="button" className="k-btn k-btn--secondary k-btn--sm" onClick={onRetry}>
        {strings.retry}
      </button>
    </div>
  );
}
