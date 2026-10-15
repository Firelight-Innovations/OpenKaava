import { strings } from "../strings";
import type { WorkingProps } from "./types";
import "./turns.css";

export function Working(_: WorkingProps) {
  return (
    <div className="at-working" role="status">
      {strings.working}
    </div>
  );
}
