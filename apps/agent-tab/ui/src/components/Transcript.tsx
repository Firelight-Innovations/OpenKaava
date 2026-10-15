import { ThreadPrimitive } from "@assistant-ui/react";
import type { TranscriptProps } from "./types";
import "./frame.css";

export function Transcript({ children }: TranscriptProps) {
  return (
    <ThreadPrimitive.Viewport className="at-transcript" turnAnchor="bottom">
      {children}
    </ThreadPrimitive.Viewport>
  );
}
