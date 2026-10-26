import { strings } from "../strings";
import { useSlots } from "./registry";
import type { EmptyStateProps } from "./types";
import "./frame.css";

/**
 * Blank, like a new chat: the prompt box says what to do. Only what stops the
 * first prompt from running is shown, in the middle of the tab.
 */
export function EmptyState({ blocked, setupHint }: EmptyStateProps) {
  const S = useSlots();
  return (
    <div className="at-empty">
      {blocked && <S.Hint text={strings.refusal[blocked] ?? blocked} />}
      {setupHint !== null && <S.Hint text={setupHint} />}
    </div>
  );
}
