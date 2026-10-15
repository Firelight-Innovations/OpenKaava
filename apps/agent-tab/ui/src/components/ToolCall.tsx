import { Check, Circle, LoaderCircle, X, type LucideIcon } from "lucide-react";
import type { ToolStatus } from "../protocol.generated";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { ToolCallProps } from "./types";
import "./items.css";

/** The shell's own icon set. Colours come from `--k-tool-*` in agent-tokens.css. */
const ICON: Record<ToolStatus, LucideIcon> = {
  pending: Circle,
  inProgress: LoaderCircle,
  completed: Check,
  failed: X,
};

/**
 * One quiet row: glyph, summary, what it changed, and its status while it is
 * not yet done. Expands to its files, diffs and output.
 */
export function ToolCall({ title, status, output, truncated, paths, diffs }: ToolCallProps) {
  const S = useSlots();
  const hasBody = output !== "" || paths.length > 0 || diffs.length > 0;
  const added = diffs.reduce((n, diff) => n + diff.added, 0);
  const removed = diffs.reduce((n, diff) => n + diff.removed, 0);
  const done = status === "completed";
  const Icon = ICON[status];
  const head = (
    <>
      <Icon
        className={`at-tool__glyph at-tool__glyph--${status}`}
        size={14}
        strokeWidth={2.5}
        aria-hidden="true"
      />
      <span className="at-tool__title" title={title}>
        {title}
      </span>
      {added + removed > 0 && (
        <span className="at-tool__counts">
          <span className="at-diff__add">{strings.diffAdded(added)}</span>{" "}
          <span className="at-diff__del">{strings.diffRemoved(removed)}</span>
        </span>
      )}
      <span className={done ? "at-sr" : "at-tool__status"}>{strings.tool[status]}</span>
    </>
  );
  if (!hasBody) return <div className="at-item at-tool at-tool__head">{head}</div>;
  return (
    <details className="at-item at-tool">
      <summary className="at-tool__head">{head}</summary>
      <S.PathList paths={paths} />
      {diffs.map((diff, i) => (
        <S.Diff key={`${i}:${diff.path}`} {...diff} />
      ))}
      {output !== "" && <pre className="at-pre">{output}</pre>}
      {truncated && <S.Note text={strings.outputTruncated} />}
    </details>
  );
}
