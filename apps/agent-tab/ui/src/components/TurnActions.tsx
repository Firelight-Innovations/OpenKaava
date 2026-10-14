import { ActionBarPrimitive } from "@assistant-ui/react";
import { strings } from "../strings";
import type { TurnActionsProps } from "./types";
import "./turns.css";

/**
 * Copy the turn's text; hidden while the agent is still writing it. Always in
 * the DOM, so the keyboard reaches it on every turn: turns.css fades it in on
 * hover and focus, where assistant-ui's own autohide would unmount it.
 */
export function TurnActions(_: TurnActionsProps) {
  return (
    <ActionBarPrimitive.Root className="at-turn__actions" hideWhenRunning autohide="never">
      <ActionBarPrimitive.Copy className="k-btn k-btn--ghost k-btn--sm" title={strings.copyTurn}>
        {strings.copy}
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}
