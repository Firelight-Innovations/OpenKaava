import { useState } from "react";
import { ChevronRight, Circle, CircleCheck, LoaderCircle } from "lucide-react";
import { strings } from "../strings";
import type { TodoListProps } from "./types";
import "./plan.css";

/**
 * ACP's plan, the agent's to-do list, pinned over the composer the way Claude
 * Code pins its task list: a count, and one row per step that checks off as
 * the agent goes. Folded, it keeps the step in progress on its one line.
 */
export function TodoList({ entries, live }: TodoListProps) {
  const [open, setOpen] = useState(true);
  const done = entries.filter((e) => e.status === "completed").length;
  const current = entries.find((e) => e.status === "in_progress");
  return (
    <section className="at-plan" aria-label={strings.plan.title}>
      <button
        type="button"
        className="at-plan__head"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronRight className="at-plan__caret" size={14} aria-hidden="true" />
        <span className="at-plan__title">{strings.plan.title}</span>
        {!open && current && <span className="at-plan__current">{current.content}</span>}
        <span className="at-plan__count">{strings.plan.count(done, entries.length)}</span>
      </button>
      {open && (
        <ol className="at-plan__list">
          {entries.map((entry, i) => {
            const Glyph =
              entry.status === "completed"
                ? CircleCheck
                : entry.status === "in_progress"
                  ? LoaderCircle
                  : Circle;
            return (
              <li
                key={i}
                className="at-plan__entry"
                data-status={entry.status}
                data-live={live ? "" : undefined}
              >
                <Glyph
                  size={14}
                  aria-label={strings.plan.status[entry.status] ?? entry.status}
                  role="img"
                />
                <span>{entry.content}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
