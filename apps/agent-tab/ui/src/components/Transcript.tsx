import type { TranscriptProps } from "./types";
import "./frame.css";

export function Transcript({ ref, onScroll, children }: TranscriptProps) {
  return (
    <div className="at-transcript" ref={ref} onScroll={onScroll}>
      {children}
    </div>
  );
}
