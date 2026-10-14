/**
 * Which slot draws each transcript item kind (handoff §2.2), and the logic
 * behind it: markdown, diffs, the copy button, an approval in flight. Nothing
 * here draws; every piece of DOM comes from `components/` through `useSlots()`.
 */
import { useMemo, useState, type MouseEvent } from "react";
import type { FileDiff, Item, ItemKind } from "./protocol.generated";
import { counts, lineDiff } from "./diff";
import { renderMarkdown } from "./markdown";
import { strings } from "./strings";
import { useSlots } from "./components/registry";
import type { DiffProps } from "./components/types";

type Kind<K extends ItemKind["kind"]> = Extract<ItemKind, { kind: K }>;

export interface ItemActions {
  /** Rejects if the answer did not land, so the card can be answered again. */
  onAnswer: (itemId: string, optionId: string) => Promise<void>;
  /** Send again what the user asked before the error `itemId`. */
  onRetry: (itemId: string) => void;
}

export function ItemView({ item, actions }: { item: Item; actions: ItemActions }) {
  const S = useSlots();
  const kind = item.kind;
  switch (kind.kind) {
    case "userMessage":
      return <S.UserMessage text={kind.text} />;
    case "assistantText":
      return <AssistantItem text={kind.text} />;
    case "reasoning":
      return <S.Thinking text={kind.text} />;
    case "toolCall":
      return <ToolItem tool={kind} />;
    case "approval":
      return <ApprovalItem id={item.id} approval={kind} onAnswer={actions.onAnswer} />;
    case "plan":
      return <S.TodoList entries={kind.entries} />;
    case "usage":
      return <S.Usage used={kind.used} size={kind.size} />;
    case "error":
      return (
        <S.ErrorItem
          message={kind.message}
          hint={kind.hint}
          onRetry={() => actions.onRetry(item.id)}
        />
      );
  }
}

function AssistantItem({ text }: { text: string }) {
  const S = useSlots();
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
  return <S.AssistantText html={html} onClick={onClick} onAuxClick={onAuxClick} />;
}

/** Each file's line diff, worked out once per change rather than per draw. */
function useDiffs(diffs: FileDiff[]): DiffProps[] {
  return useMemo(
    () =>
      diffs.map((diff) => {
        const lines = diff.tooLarge ? null : lineDiff(diff.oldText, diff.newText);
        const tally = lines ? counts(lines) : { added: 0, removed: 0 };
        return {
          path: diff.path,
          isNew: diff.oldText === null && !diff.tooLarge,
          lines,
          ...tally,
        };
      }),
    [diffs],
  );
}

function ToolItem({ tool }: { tool: Kind<"toolCall"> }) {
  const S = useSlots();
  const diffs = useDiffs(tool.diffs);
  return (
    <S.ToolCall
      title={tool.title}
      toolKind={tool.toolKind}
      status={tool.status}
      output={tool.output}
      truncated={tool.truncated}
      paths={tool.paths}
      diffs={diffs}
    />
  );
}

function ApprovalItem({
  id,
  approval,
  onAnswer,
}: {
  id: string;
  approval: Kind<"approval">;
  onAnswer: ItemActions["onAnswer"];
}) {
  const S = useSlots();
  const [sent, setSent] = useState<string | null>(null);
  const diffs = useDiffs(approval.diffs);
  return (
    <S.Approval
      title={approval.title}
      detail={approval.detail}
      detailTruncated={approval.detailTruncated}
      paths={approval.paths}
      diffs={diffs}
      options={approval.options}
      answer={approval.answer === null ? null : answerText(approval)}
      sending={sent}
      onChoose={(optionId) => {
        setSent(optionId);
        onAnswer(id, optionId).catch(() => setSent(null));
      }}
    />
  );
}

function answerText(approval: Kind<"approval">): string {
  if (approval.answer === "cancelled") return strings.approval.cancelled;
  if (approval.answer === "outside") return strings.approval.outside;
  const option = approval.options.find((o) => o.optionId === approval.answer);
  return strings.approval.answered(option?.name ?? approval.answer ?? "");
}
