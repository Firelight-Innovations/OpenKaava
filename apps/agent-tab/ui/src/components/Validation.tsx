import { LoaderCircle, ShieldCheck } from "lucide-react";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { ValidationProps } from "./types";
import "./validation.css";

/**
 * The canvas topology check as a card of its own, so it is plain that the
 * agent is validating and what came of it: one row per rule, ticked or
 * crossed, with the offending elements under a failed one.
 */
export function Validation({ status, report }: ValidationProps) {
  const S = useSlots();
  const running = status === "pending" || status === "inProgress";
  const failed = report ? report.checks.filter((c) => !c.pass).length : 0;
  const verdict = running
    ? strings.validation.running
    : report === null
      ? strings.validation.unreadable
      : failed === 0
        ? strings.validation.passed
        : strings.validation.failed(failed);
  const tone = running ? "running" : report?.pass ? "pass" : "fail";
  return (
    <section className={`at-item at-validation at-validation--${tone}`} aria-live="polite">
      <header className="at-validation__head">
        {running ? (
          <LoaderCircle className="at-validation__spin" size={16} aria-hidden="true" />
        ) : (
          <ShieldCheck size={16} aria-hidden="true" />
        )}
        <span className="at-validation__title">{strings.validation.title}</span>
        <span className="at-validation__verdict">{verdict}</span>
      </header>
      {report && <S.ValidationChecks checks={report.checks} />}
    </section>
  );
}
