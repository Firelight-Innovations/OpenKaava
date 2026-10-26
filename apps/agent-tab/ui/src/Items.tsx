/**
 * Which slot draws each transcript item kind (handoff §2.2), and the logic
 * behind it: markdown, diffs, the copy button, an approval in flight. Nothing
 * here draws; every piece of DOM comes from `components/` through `useSlots()`.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type {
  FileDiff,
  Harness,
  Hint,
  Item,
  ItemKind,
  QuestionOutcome,
  QuestionReply,
} from "./protocol.generated";
import { counts, lineDiff } from "./diff";
import { renderMarkdown } from "./markdown";
import {
  complete,
  current,
  emptyReplies,
  numberKey,
  oneClick,
  openCard,
  pick,
  registerOpen,
  typeOther,
  type OpenCard,
} from "./questions";
import { strings } from "./strings";
import { useSlots } from "./components/registry";
import type { DiffProps } from "./components/types";

type Kind<K extends ItemKind["kind"]> = Extract<ItemKind, { kind: K }>;

export interface ItemActions {
  /** Rejects if the answer did not land, so the card can be answered again. */
  onAnswer: (itemId: string, optionId: string) => Promise<void>;
  /** Answers a question card. Rejects if the answer did not land, as `onAnswer` does. */
  onQuestion: (itemId: string, outcome: QuestionOutcome) => Promise<void>;
  /** Send again what the user asked before the error `itemId`. */
  onRetry: (itemId: string) => void;
  /** A hint as a sentence about `harness`, the one that raised it. */
  hintText: (hint: Hint, harness: Harness) => string;
}

/** `live`: the item is the part still streaming in a running turn. */
export function ItemView({
  item,
  actions,
  live = false,
}: {
  item: Item;
  actions: ItemActions;
  live?: boolean;
}) {
  const S = useSlots();
  const kind = item.kind;
  switch (kind.kind) {
    case "userMessage":
      return <S.UserMessage text={kind.text} />;
    case "assistantText":
      return <AssistantItem text={kind.text} />;
    case "reasoning":
      return <S.Thinking text={kind.text} live={live} />;
    case "toolCall":
      return <ToolItem tool={kind} />;
    case "approval":
      return <ApprovalItem id={item.id} approval={kind} onAnswer={actions.onAnswer} />;
    case "question":
      return <QuestionItem id={item.id} question={kind} onQuestion={actions.onQuestion} />;
    // The plan is pinned over the composer and the usage is the composer's
    // context ring, so neither repeats in the transcript.
    case "plan":
    case "usage":
      return null;
    case "error":
      return (
        <S.ErrorItem
          message={kind.message}
          hint={kind.hint && actions.hintText(kind.hint, kind.harness)}
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

/**
 * A question card. While open it is the card the number keys and the
 * composer answer, if it is the newest open one (`questions.ts`). A single
 * question with one pick is sent on the click; anything else waits for Submit.
 */
function QuestionItem({
  id,
  question,
  onQuestion,
}: {
  id: string;
  question: Kind<"question">;
  onQuestion: ItemActions["onQuestion"];
}) {
  const S = useSlots();
  const { questions, outcome } = question;
  const [replies, setReplies] = useState<QuestionReply[]>(() => emptyReplies(questions));
  const [sending, setSending] = useState(false);
  const open = outcome === null;
  const submit = !oneClick(questions);

  const send = (sent: QuestionOutcome) => {
    setSending(true);
    onQuestion(id, sent).catch(() => setSending(false));
  };
  const answer = (next: QuestionReply[]) => send({ kind: "answered", replies: next });
  const choose = (index: number, value: string) => {
    const next = pick(questions, replies, index, value);
    setReplies(next);
    if (!submit) answer(next);
  };

  // The registered card reads the latest replies without registering again.
  const latest = useRef({ replies, choose, answer });
  latest.current = { replies, choose, answer };
  const listening = open && !sending;
  useEffect(() => {
    if (!listening) return;
    const card: OpenCard = {
      pickNumber: (n) => {
        const { replies: now, choose: pickIt } = latest.current;
        const at = current(questions, now);
        const choice = questions[at]?.choices[n];
        if (!choice) return false;
        pickIt(at, choice.value);
        return true;
      },
      answerText: (text) => {
        const now = latest.current.replies;
        const next = typeOther(questions, now, current(questions, now), text);
        if (next === null) return false;
        setReplies(next);
        if (!submit) latest.current.answer(next);
        return true;
      },
    };
    const unregister = registerOpen(card);
    const onKey = (event: KeyboardEvent) => {
      if (openCard() !== card) return;
      const n = numberKey(event);
      if (n !== null && card.pickNumber(n)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unregister();
      window.removeEventListener("keydown", onKey);
    };
  }, [listening, questions, submit]);

  // Closed, the card shows what the host says was sent, not what was clicked.
  const shown = outcome?.kind === "answered" ? outcome.replies : open ? replies : [];
  return (
    <S.QuestionCard
      message={question.message}
      questions={questions.map((q, i) => ({
        header: q.header,
        text: q.text,
        choices: q.choices,
        multi: q.multi,
        other: q.other,
        picks: shown[i]?.picks ?? [],
        typed: shown[i]?.other?.trim() || null,
      }))}
      open={open}
      ended={
        outcome?.kind === "skipped"
          ? strings.question.skipped
          : outcome?.kind === "cancelled"
            ? strings.question.cancelled
            : null
      }
      current={current(questions, replies)}
      submit={submit}
      ready={complete(questions, replies)}
      sending={sending}
      onPick={choose}
      onSubmit={() => answer(replies)}
      onSkip={() => send({ kind: "skipped" })}
    />
  );
}
