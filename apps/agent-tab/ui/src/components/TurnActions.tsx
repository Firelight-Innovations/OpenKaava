import { useEffect, useState } from "react";
import { ActionBarPrimitive, useAuiState } from "@assistant-ui/react";
import { Check, Copy } from "lucide-react";
import { strings } from "../strings";
import type { TurnActionsProps } from "./types";
import "./turns.css";

/**
 * Copy the turn's text, as an icon with its name on hover, and how long ago the
 * turn finished. Left out of the turn the agent is still writing and of a turn
 * with no text, and kept in the DOM on every other turn while a run goes on, so
 * the keyboard reaches it and earlier turns do not change height: turns.css
 * fades it in on hover and focus.
 */
export function TurnActions(_: TurnActionsProps) {
  const shown = useAuiState(
    (s) =>
      !(s.message.isLast && s.thread.isRunning) &&
      s.message.parts.some((p) => p.type === "text" && p.text.trim() !== ""),
  );
  const copied = useAuiState((s) => s.message.isCopied);
  const at = useAuiState((s) => s.message.createdAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!shown) return null;
  return (
    <ActionBarPrimitive.Root className="at-turn__actions" autohide="never">
      <ActionBarPrimitive.Copy
        className="k-btn k-btn--ghost k-btn--sm"
        title={copied ? strings.copied : strings.copyTurn}
        aria-label={strings.copy}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </ActionBarPrimitive.Copy>
      {at && <span className="at-turn__time">{strings.ago(Math.max(0, now - at.getTime()))}</span>}
    </ActionBarPrimitive.Root>
  );
}
