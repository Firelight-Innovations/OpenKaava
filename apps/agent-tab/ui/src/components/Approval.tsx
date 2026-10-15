import type { ApprovalOption } from "../protocol.generated";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { ApprovalProps } from "./types";
import "./items.css";

/** The request, the exact command or change, and the agent's own choices. */
export function Approval({
  title,
  detail,
  detailTruncated,
  paths,
  diffs,
  options,
  answer,
  sending,
  onChoose,
}: ApprovalProps) {
  const S = useSlots();
  return (
    <div className="at-item at-approval" role="group" aria-label={strings.approval.heading}>
      <div className="at-approval__head">
        <span aria-hidden="true">⚠ </span>
        {strings.approval.heading}: {title}
      </div>
      {detail && <pre className="at-pre">{detail}</pre>}
      {detailTruncated && <S.Note text={strings.detailTruncated} />}
      <S.PathList paths={paths} />
      {diffs.map((diff, i) => (
        <S.Diff key={`${i}:${diff.path}`} {...diff} />
      ))}
      {answer !== null ? (
        <div className="at-approval__answer">{answer}</div>
      ) : (
        <div className="at-approval__options">
          {options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              className={`k-btn k-btn--sm ${optionStyle(option)}`}
              disabled={sending !== null}
              onClick={() => onChoose(option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function optionStyle(option: ApprovalOption): string {
  if (option.kind === "allow_once") return "k-btn--primary";
  if (option.kind.startsWith("reject")) return "k-btn--danger";
  return "k-btn--secondary";
}
