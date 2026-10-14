/**
 * One renderer per transcript item kind (handoff §2.2). Status is always text
 * plus a glyph, never colour alone (§2.5).
 */
import { useMemo, useState, type MouseEvent } from "react";
import type { ApprovalOption, FileDiff, Item, ItemKind } from "./protocol.generated";
import { counts, lineDiff } from "./diff";
import { renderMarkdown } from "./markdown";
import { strings } from "./strings";

type Kind<K extends ItemKind["kind"]> = Extract<ItemKind, { kind: K }>;

export interface ItemActions {
  /** Rejects if the answer did not land, so the card can be answered again. */
  onAnswer: (itemId: string, optionId: string) => Promise<void>;
  /** Send again what the user asked before the error `itemId`. */
  onRetry: (itemId: string) => void;
}

export function ItemView({ item, actions }: { item: Item; actions: ItemActions }) {
  const kind = item.kind;
  switch (kind.kind) {
    case "userMessage":
      return (
        <div className="at-item at-user">
          <div className="at-item__label">{strings.you}</div>
          <div className="at-user__text">{kind.text}</div>
        </div>
      );
    case "assistantText":
      return <Markdown text={kind.text} />;
    case "reasoning":
      return (
        <details className="at-item at-reasoning">
          <summary>{strings.thinking}</summary>
          <div className="at-reasoning__text">{kind.text}</div>
        </details>
      );
    case "toolCall":
      return <ToolRow tool={kind} />;
    case "approval":
      return <ApprovalCard id={item.id} approval={kind} onAnswer={actions.onAnswer} />;
    case "plan":
      return <PlanCard plan={kind} />;
    case "usage":
      return <div className="at-usage">{strings.usage(kind.used, kind.size)}</div>;
    case "error":
      return (
        <div className="at-item at-error" role="alert">
          <div className="at-error__message">
            <span aria-hidden="true">✕ </span>
            {strings.error}: {kind.message}
          </div>
          {kind.hint && <div className="at-hint">{strings.hint[kind.hint]}</div>}
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            onClick={() => actions.onRetry(item.id)}
          >
            {strings.retry}
          </button>
        </div>
      );
  }
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // A link would navigate this frame away from the tab; nothing opens yet.
    if (target.closest("a")) event.preventDefault();
    const copy = target.closest<HTMLButtonElement>("[data-copy]");
    const code = copy?.parentElement?.querySelector("pre")?.textContent;
    if (!copy || code === undefined || code === null) return;
    void navigator.clipboard?.writeText(code).then(
      () => {
        copy.textContent = strings.copied;
      },
      () => {},
    );
  };
  // A middle click would open the link in a window of its own.
  const onAuxClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("a")) event.preventDefault();
  };
  return (
    <div
      className="at-item at-assistant"
      onClick={onClick}
      onAuxClick={onAuxClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ToolRow({ tool }: { tool: Kind<"toolCall"> }) {
  const label = strings.tool[tool.status];
  const hasBody = tool.output !== "" || tool.paths.length > 0 || tool.diffs.length > 0;
  const head = (
    <>
      <span className={`at-tool__glyph at-tool__glyph--${tool.status}`} aria-hidden="true">
        {strings.toolGlyph[tool.status]}
      </span>
      <span className="at-tool__title">{tool.title}</span>
      <span className="at-tool__status">{label}</span>
    </>
  );
  if (!hasBody) return <div className="at-item at-tool at-tool__head">{head}</div>;
  return (
    <details className="at-item at-tool">
      <summary className="at-tool__head">{head}</summary>
      <Paths paths={tool.paths} />
      {tool.diffs.map((diff) => (
        <DiffView key={diff.path} diff={diff} />
      ))}
      {tool.output !== "" && <pre className="at-pre">{tool.output}</pre>}
      {tool.truncated && <div className="at-note">{strings.outputTruncated}</div>}
    </details>
  );
}

function Paths({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <ul className="at-paths" aria-label={strings.files}>
      {paths.map((path) => (
        <li key={path} className="at-mono">
          {path}
        </li>
      ))}
    </ul>
  );
}

function DiffView({ diff }: { diff: FileDiff }) {
  const lines = useMemo(
    () => (diff.tooLarge ? null : lineDiff(diff.oldText, diff.newText)),
    [diff],
  );
  const tally = lines ? counts(lines) : null;
  return (
    <div className="at-diff">
      <div className="at-diff__head">
        <span className="at-mono">{diff.path}</span>
        {diff.oldText === null && !diff.tooLarge && (
          <span className="at-diff__new">{strings.newFile}</span>
        )}
        {tally && (
          <span className="at-diff__counts">
            <span className="at-diff__add">{strings.diffAdded(tally.added)}</span>{" "}
            <span className="at-diff__del">{strings.diffRemoved(tally.removed)}</span>
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
        <div className="at-note">{strings.diffTooLarge}</div>
      )}
    </div>
  );
}

function opName(op: " " | "+" | "-"): string {
  return op === "+" ? "add" : op === "-" ? "del" : "same";
}

function ApprovalCard({
  id,
  approval,
  onAnswer,
}: {
  id: string;
  approval: Kind<"approval">;
  onAnswer: ItemActions["onAnswer"];
}) {
  const [sent, setSent] = useState<string | null>(null);
  const answered = approval.answer !== null;
  return (
    <div className="at-item at-approval" role="group" aria-label={strings.approval.heading}>
      <div className="at-approval__head">
        <span aria-hidden="true">⚠ </span>
        {strings.approval.heading}: {approval.title}
      </div>
      {approval.detail && <pre className="at-pre">{approval.detail}</pre>}
      <Paths paths={approval.paths} />
      {approval.diffs.map((diff) => (
        <DiffView key={diff.path} diff={diff} />
      ))}
      {answered ? (
        <div className="at-approval__answer">{answerText(approval)}</div>
      ) : (
        <div className="at-approval__options">
          {approval.options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              className={`k-btn k-btn--sm ${optionStyle(option)}`}
              disabled={sent !== null}
              onClick={() => {
                setSent(option.optionId);
                onAnswer(id, option.optionId).catch(() => setSent(null));
              }}
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

function answerText(approval: Kind<"approval">): string {
  if (approval.answer === "cancelled") return strings.approval.cancelled;
  if (approval.answer === "outside") return strings.approval.outside;
  const option = approval.options.find((o) => o.optionId === approval.answer);
  return strings.approval.answered(option?.name ?? approval.answer ?? "");
}

function PlanCard({ plan }: { plan: Kind<"plan"> }) {
  return (
    <div className="at-item at-plan">
      <div className="at-item__label">{strings.plan}</div>
      <ul>
        {plan.entries.map((entry, i) => (
          <li key={i} className={`at-plan__entry at-plan__entry--${entry.status}`}>
            <span aria-hidden="true">{strings.planGlyph[entry.status] ?? "○"} </span>
            {entry.content}
          </li>
        ))}
      </ul>
    </div>
  );
}
