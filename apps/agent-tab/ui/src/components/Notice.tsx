import { useSlots } from "./registry";
import type { NoticeProps } from "./types";
import "./composer.css";

export function Notice({ text, hint, action }: NoticeProps) {
  const S = useSlots();
  return (
    <div className="at-notice" role="alert">
      {text}
      {action && (
        <>
          {" "}
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        </>
      )}
      {hint && <S.Hint text={hint} />}
    </div>
  );
}
