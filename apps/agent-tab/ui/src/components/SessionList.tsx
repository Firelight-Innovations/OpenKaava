import { useSlots } from "./registry";
import type { SessionListProps } from "./types";
import "./menu.css";

/** Past and running sessions, newest first, as the caller sorted them. */
export function SessionList({ sessions, activeId, onOpen }: SessionListProps) {
  const S = useSlots();
  return (
    <ul className="at-sessions">
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            className={`at-sessions__row${session.id === activeId ? " at-sessions__row--active" : ""}`}
            aria-current={session.id === activeId ? "true" : undefined}
            onClick={() => onOpen(session.id)}
          >
            <span className="at-sessions__title">{session.title}</span>
            <span className="at-sessions__when">{session.when}</span>
            {session.state && <S.StatusBadge state={session.state} />}
          </button>
        </li>
      ))}
    </ul>
  );
}
