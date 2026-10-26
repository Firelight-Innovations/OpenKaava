import { useEffect, useState } from "react";
import { strings } from "../strings";
import type { WorkingProps } from "./types";
import "./turns.css";

/**
 * The line under a running turn, as Claude Code draws it: four pulsing dots, what the agent is at, and how long the turn has run.
 */
export function Working({ activity, since }: WorkingProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return (
    <div className="at-working" role="status">
      <span className="at-working__spark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="at-shimmer" data-live="">
        {activity ?? strings.working}
      </span>
      {since !== undefined && (
        <span className="at-working__clock">{strings.activity.elapsed(now - since)}</span>
      )}
    </div>
  );
}
