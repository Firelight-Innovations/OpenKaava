import { strings } from "../strings";
import type { WorkingProps } from "./types";
import "./turns.css";

export function Working(_: WorkingProps) {
  return (
    <div className="at-working" role="status">
      <span className="at-shimmer" data-live="">
        {strings.working}
      </span>
    </div>
  );
}
