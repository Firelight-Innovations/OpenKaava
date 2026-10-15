import type { ActionGroupProps } from "./types";
import "./items.css";

/**
 * A run of tool calls folded into one line. Open, the calls sit in one card,
 * one row each. The line shimmers while a call is still running.
 */
export function ActionGroup({ summary, running, failed, children }: ActionGroupProps) {
  return (
    <details className="at-item at-actions">
      <summary className="at-actions__head at-disclosure">
        <span className="at-shimmer" data-live={running ? "" : undefined}>
          {summary}
        </span>
        {failed !== null && <span className="at-actions__failed">{failed}</span>}
      </summary>
      <div className="at-actions__body">{children}</div>
    </details>
  );
}
