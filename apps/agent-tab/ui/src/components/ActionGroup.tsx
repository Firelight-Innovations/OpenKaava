import { useState } from "react";
import type { ActionGroupProps } from "./types";
import "./items.css";

/**
 * A run of tool calls folded into one line. Open, the calls sit in one card,
 * one row each. The line shimmers while a call is still running.
 *
 * A lone call is wrapped too, with no line and no card. The calls stay at the
 * same place in the tree whether or not they are grouped, so a row the user
 * opened stays open when a second call joins it.
 */
export function ActionGroup({ grouped, summary, running, failed, children }: ActionGroupProps) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={grouped ? "at-item at-actions" : "at-actions"}
      data-grouped={grouped ? "" : undefined}
    >
      {grouped && (
        <button
          type="button"
          className="at-actions__head at-disclosure"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          <span className="at-shimmer" data-live={running ? "" : undefined}>
            {summary}
          </span>
          {failed !== null && <span className="at-actions__failed">{failed}</span>}
        </button>
      )}
      <div className="at-actions__body" hidden={grouped && !open}>
        {children}
      </div>
    </div>
  );
}
