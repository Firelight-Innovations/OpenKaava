import { SquarePen } from "lucide-react";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { HeaderProps } from "./types";
import "./frame.css";

/**
 * Nothing to see until there is a session, then one New session button at
 * the right. The pane's tab already names the tab, and the settings button
 * names the harness and model. The state is still announced, to a screen
 * reader only: the transcript shows it to everyone else.
 */
export function Header({ state, onNewSession }: HeaderProps) {
  const S = useSlots();
  return (
    <header className="at-header" data-empty={state === null ? "" : undefined}>
      <span className="at-header__status">
        <S.StatusBadge state={state} />
      </span>
      {state !== null && (
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--icon"
          aria-label={strings.newSession}
          title={strings.newSessionHint}
          onClick={onNewSession}
        >
          <SquarePen size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </header>
  );
}
