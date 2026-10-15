import type { NoteProps } from "./types";
import "./items.css";

export function Note({ text }: NoteProps) {
  return <div className="at-note">{text}</div>;
}
