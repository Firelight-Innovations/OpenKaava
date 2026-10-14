import { strings } from "../strings";
import type { DiffLine } from "../diff";
import { useSlots } from "./registry";
import type { DiffProps } from "./types";
import "./items.css";

export function Diff({ path, isNew, lines, added, removed }: DiffProps) {
  const S = useSlots();
  return (
    <div className="at-diff">
      <div className="at-diff__head">
        <span className="at-mono">{path}</span>
        {isNew && <span className="at-diff__new">{strings.newFile}</span>}
        {lines && (
          <span className="at-diff__counts">
            <span className="at-diff__add">{strings.diffAdded(added)}</span>{" "}
            <span className="at-diff__del">{strings.diffRemoved(removed)}</span>
          </span>
        )}
      </div>
      {lines ? (
        <pre className="at-pre at-diff__body">
          {lines.map((line, i) => (
            <div key={i} className={`at-diff__line at-diff__line--${opName(line.op)}`}>
              {line.op} {line.text}
            </div>
          ))}
        </pre>
      ) : (
        <S.Note text={strings.diffTooLarge} />
      )}
    </div>
  );
}

function opName(op: DiffLine["op"]): string {
  return op === "+" ? "add" : op === "-" ? "del" : "same";
}
