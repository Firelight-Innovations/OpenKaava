import { strings } from "../strings";
import { useSlots } from "./registry";
import type { ToolCallProps } from "./types";
import "./items.css";

/** One row: glyph, summary, status. Expands to its files, diffs and output. */
export function ToolCall({ title, status, output, truncated, paths, diffs }: ToolCallProps) {
  const S = useSlots();
  const hasBody = output !== "" || paths.length > 0 || diffs.length > 0;
  const head = (
    <>
      <span className={`at-tool__glyph at-tool__glyph--${status}`} aria-hidden="true">
        {strings.toolGlyph[status]}
      </span>
      <span className="at-tool__title">{title}</span>
      <span className="at-tool__status">{strings.tool[status]}</span>
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
