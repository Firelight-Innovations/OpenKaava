import { strings } from "../strings";
import type { TodoListProps } from "./types";
import "./items.css";

/** ACP's plan: Claude's to-do list, updated in place. */
export function TodoList({ entries }: TodoListProps) {
  return (
    <div className="at-item at-plan">
      <div className="at-item__label">{strings.plan}</div>
      <ul>
        {entries.map((entry, i) => (
          <li key={i} className={`at-plan__entry at-plan__entry--${entry.status}`}>
            <span aria-hidden="true">{strings.planGlyph[entry.status] ?? "○"} </span>
            {entry.content}
          </li>
        ))}
      </ul>
    </div>
  );
}
