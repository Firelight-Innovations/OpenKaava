import { Check, LoaderCircle, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { strings } from "../strings";
import type { ValidationProps } from "./types";
import "./validation.css";

/**
 * The canvas topology check as a card of its own, so it is plain that the
 * agent is validating and what came of it: one row per rule, ticked or
 * crossed, with the offending elements under a failed one.
 */
export function Validation({ status, report }: ValidationProps) {
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
      {report && (
        <ul className="at-validation__checks">
          {report.checks.map((check) => (
            <li
              key={check.id}
              className="at-validation__check"
              data-pass={check.pass}
              data-warn={check.warn || undefined}
            >
              {!check.pass ? (
                <X size={14} strokeWidth={2.5} aria-label="Failed" />
              ) : check.warn ? (
                <TriangleAlert size={14} aria-label={strings.validation.warning} />
              ) : (
                <Check size={14} strokeWidth={2.5} aria-label="Passed" />
              )}
              <span className="at-validation__label">{check.label}</span>
              {check.count > 0 && <span className="at-validation__count">{check.count}</span>}
              {!check.pass && check.issues.length > 0 && (
                <ul className="at-validation__issues">
                  {check.issues.slice(0, 3).map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                  {check.count > 3 && <li>{strings.validation.more(check.count - 3)}</li>}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
