import type { HintProps } from "./types";
import "./items.css";

export function Hint({ text }: HintProps) {
  return <div className="at-hint">{text}</div>;
}
