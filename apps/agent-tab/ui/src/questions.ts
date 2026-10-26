/**
 * The logic behind a question card: what a pick or a typed answer does to the
 * replies, when the card is complete, and which card the number keys and the
 * composer answer. The card itself only draws (`components/QuestionCard.tsx`).
 *
 * Only one card is answered from the keyboard at a time: the newest one still
 * open. Each open card registers here, and the last to register takes the
 * number keys and the composer's text.
 */
import type { Question, QuestionReply } from "./protocol.generated";

/** One empty reply per question. */
export function emptyReplies(questions: readonly Question[]): QuestionReply[] {
  return questions.map(() => ({ picks: [], other: null }));
}

/** A reply says something: a pick, or typed text. */
export function answered(reply: QuestionReply | undefined): boolean {
  return !!reply && (reply.picks.length > 0 || (reply.other ?? "").trim() !== "");
}

/**
 * One click answers the card: a single question with one pick. Everything
 * else waits for Submit, so a second question or a second pick is not lost.
 */
export function oneClick(questions: readonly Question[]): boolean {
  return questions.length === 1 && !questions[0].multi;
}

/** Every question has an answer. A card with no questions is a plain confirmation. */
export function complete(questions: readonly Question[], replies: readonly QuestionReply[]) {
  return questions.every((_, i) => answered(replies[i]));
}

/**
 * The question the keyboard and the composer answer: the first without an
 * answer, else the last.
 */
export function current(questions: readonly Question[], replies: readonly QuestionReply[]) {
  const open = questions.findIndex((_, i) => !answered(replies[i]));
  return open === -1 ? Math.max(0, questions.length - 1) : open;
}

/**
 * Pick `value` on question `index`. A single-select takes it in place of the
 * typed answer; a multi-select toggles it and keeps what was typed.
 */
export function pick(
  questions: readonly Question[],
  replies: readonly QuestionReply[],
  index: number,
  value: string,
): QuestionReply[] {
  const question = questions[index];
  if (!question || !question.choices.some((c) => c.value === value)) return [...replies];
  return replies.map((reply, i) => {
    if (i !== index) return reply;
    if (!question.multi) return { picks: [value], other: null };
    const picks = reply.picks.includes(value)
      ? reply.picks.filter((p) => p !== value)
      : // In the agent's order, whatever order they were clicked in.
        question.choices.map((c) => c.value).filter((v) => v === value || reply.picks.includes(v));
    return { ...reply, picks };
  });
}

/**
 * Typed text as the answer to question `index`: in place of a pick for a
 * single-select, beside the picks for a multi-select. `null` when that
 * question takes no typed answer.
 */
export function typeOther(
  questions: readonly Question[],
  replies: readonly QuestionReply[],
  index: number,
  text: string,
): QuestionReply[] | null {
  const question = questions[index];
  if (!question?.other) return null;
  return replies.map((reply, i) => {
    if (i !== index) return reply;
    return question.multi ? { ...reply, other: text } : { picks: [], other: text };
  });
}

/** What an open card answers to: a number key, and the composer's text. */
export interface OpenCard {
  /** Pick choice `n` (0-based) on the current question. */
  pickNumber: (n: number) => boolean;
  /** Take typed text as an answer. False when the card takes none. */
  answerText: (text: string) => boolean;
}

const open: OpenCard[] = [];

/** Register an open card. Returns the call that unregisters it. */
export function registerOpen(card: OpenCard): () => void {
  open.push(card);
  return () => {
    const at = open.indexOf(card);
    if (at !== -1) open.splice(at, 1);
  };
}

/** The card the keyboard answers, if one is open. */
export function openCard(): OpenCard | null {
  return open[open.length - 1] ?? null;
}

/**
 * Hand the composer's text to the open card. True when a card took it, and the
 * text should not also go to the agent as a prompt.
 */
export function answerOpenCard(text: string): boolean {
  const card = openCard();
  return text.trim() !== "" && card !== null && card.answerText(text.trim());
}

/**
 * The digit a key press picks, `0` to `8` for keys 1 to 9, or `null`. A key
 * pressed while typing into a field that already holds text is the user's
 * typing, not a pick; so is any key with a modifier.
 */
export function numberKey(event: KeyboardEvent): number | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  const target = event.target as HTMLElement | null;
  if (target && typing(target)) return null;
  return Number(event.key) - 1;
}

function typing(target: HTMLElement): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    return target.value !== "";
  if (target.isContentEditable) return (target.textContent ?? "") !== "";
  return false;
}
