import { ActionBarPrimitive } from "@assistant-ui/react";
import { strings } from "../strings";
import type { TurnActionsProps } from "./types";
import "./turns.css";

/** Copy the turn's text; hidden while the agent is still writing it. */
export function TurnActions(_: TurnActionsProps) {
  return (
    <ActionBarPrimitive.Root className="at-turn__actions" hideWhenRunning autohide="not-last">
      <ActionBarPrimitive.Copy className="k-btn k-btn--ghost k-btn--sm" title={strings.copyTurn}>
        {strings.copy}
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}
