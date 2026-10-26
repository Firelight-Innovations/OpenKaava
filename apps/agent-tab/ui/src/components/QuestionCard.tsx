import { strings } from "../strings";
import type { QuestionCardProps, QuestionCardQuestion } from "./types";
import "./question.css";

/**
 * The agent's question: the question in bold, then one full-width row per
 * choice, numbered. Answered, it keeps the question and shows the answer.
 */
export function QuestionCard({
  message,
  questions,
  open,
  ended,
  current,
  submit,
  ready,
  sending,
  onPick,
  onSubmit,
  onSkip,
}: QuestionCardProps) {
  const typeable = questions.some((q) => q.other && q.choices.length > 0);
  const typeOnly = questions.length > 0 && questions.every((q) => q.choices.length === 0);
  return (
    <div
      className="at-item at-question"
      role="group"
      aria-label={strings.question.heading}
      data-open={open || undefined}
    >
      {message && <div className="at-question__message">{message}</div>}
      {questions.map((question, index) => (
        <QuestionBlock
          key={index}
          index={index}
          question={question}
          open={open}
          current={open && index === current && questions.length > 1}
          answered={!open && ended === null}
          sending={sending}
          onPick={onPick}
        />
      ))}
      {open ? (
        <>
          <div className="at-question__hint">
            {typeOnly
              ? strings.question.typeOnly
              : [
                  questions.length > 0 ? strings.question.keysHint : "",
                  typeable ? strings.question.typeHint : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
          </div>
          <div className="at-question__actions">
            {submit && (
              <button
                type="button"
                className="k-btn k-btn--sm k-btn--primary"
                disabled={!ready || sending}
                onClick={onSubmit}
              >
                {strings.question.submit}
              </button>
            )}
            <button
              type="button"
              className="k-btn k-btn--sm k-btn--secondary"
              disabled={sending}
              onClick={onSkip}
            >
              {strings.question.skip}
            </button>
          </div>
        </>
      ) : (
        ended !== null && <div className="at-question__ended">{ended}</div>
      )}
    </div>
  );
}

function QuestionBlock({
  index,
  question,
  open,
  current,
  answered,
  sending,
  onPick,
}: {
  index: number;
  question: QuestionCardQuestion;
  open: boolean;
  current: boolean;
  /** Closed with an answer: a question left blank says so. */
  answered: boolean;
  sending: boolean;
  onPick: QuestionCardProps["onPick"];
}) {
  // Answered, only what was chosen is left.
  const shown = open
    ? question.choices
    : question.choices.filter((c) => question.picks.includes(c.value));
  return (
    <div className="at-question__block" data-current={current || undefined}>
      {question.header && <div className="at-question__header">{question.header}</div>}
      {question.text && <div className="at-question__text">{question.text}</div>}
      {shown.length > 0 && (
        <div
          className="at-question__choices"
          role={question.multi ? "group" : "radiogroup"}
          aria-label={question.text ?? question.header ?? undefined}
        >
          {shown.map((choice) => {
            const n = question.choices.indexOf(choice) + 1;
            const picked = question.picks.includes(choice.value);
            return (
              <button
                key={choice.value}
                type="button"
                role={question.multi ? "checkbox" : "radio"}
                aria-checked={picked}
                className="at-question__choice"
                data-picked={picked || undefined}
                disabled={!open || sending}
                onClick={() => onPick(index, choice.value)}
              >
                <span className="at-question__number" aria-hidden="true">
                  {n <= 9 ? `${n} ·` : "·"}
                </span>
                {question.multi && (
                  <span className="at-question__box" aria-hidden="true">
                    {picked ? "✓" : ""}
                  </span>
                )}
                <span className="at-question__label">
                  {choice.label}
                  {choice.description && (
                    <span className="at-question__description">{choice.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {question.typed && (
        <div className="at-question__typed">{strings.question.typed(question.typed)}</div>
      )}
      {answered && shown.length === 0 && !question.typed && (
        <div className="at-question__typed">{strings.question.noAnswer}</div>
      )}
    </div>
  );
}
