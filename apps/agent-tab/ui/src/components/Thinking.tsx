import { strings } from "../strings";
import type { ThinkingProps } from "./types";
import "./items.css";

/** The agent's reasoning, folded. Its label shimmers while the agent is still thinking. */
export function Thinking({ text, live = false }: ThinkingProps) {
  return (
    <details className="at-item at-reasoning">
      <summary className="at-disclosure">
        <span className="at-shimmer" data-live={live ? "" : undefined}>
          {strings.thinking}
        </span>
      </summary>
      <div className="at-reasoning__text">{text}</div>
    </details>
  );
}
