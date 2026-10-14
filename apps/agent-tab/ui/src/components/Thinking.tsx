import { strings } from "../strings";
import type { ThinkingProps } from "./types";
import "./items.css";

export function Thinking({ text }: ThinkingProps) {
  return (
    <details className="at-item at-reasoning">
      <summary>{strings.thinking}</summary>
      <div className="at-reasoning__text">{text}</div>
    </details>
  );
}
