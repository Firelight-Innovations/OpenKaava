import { ActionBarPrimitive, useAuiState } from "@assistant-ui/react";
import { strings } from "../strings";
import type { TurnActionsProps } from "./types";
import "./turns.css";

/**
 * Copy the turn's text. Left out of the turn the agent is still writing and of
 * a turn with no text, and kept in the DOM on every other turn while a run
 * goes on, so the keyboard reaches it and earlier turns do not change height:
 * turns.css fades it in on hover and focus.
 */
export function TurnActions(_: TurnActionsProps) {
  const shown = useAuiState(
    (s) =>
      !(s.message.isLast && s.thread.isRunning) &&
      s.message.parts.some((p) => p.type === "text" && p.text.trim() !== ""),
  );
  const copied = useAuiState((s) => s.message.isCopied);
  if (!shown) return null;
  return (
    <ActionBarPrimitive.Root className="at-turn__actions" autohide="never">
      <ActionBarPrimitive.Copy className="k-btn k-btn--ghost k-btn--sm" title={strings.copyTurn}>
        {copied ? strings.copied : strings.copy}
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}
