import { Check, TriangleAlert, X } from "lucide-react";
import { strings } from "../strings";
import type { ValidationChecksProps } from "./types";
import "./validation.css";

/** How many offending elements a failed rule names before "and N more". */
const SHOWN = 3;

/**
 * One row per rule of a canvas validation report, ticked or crossed, with the
 * first few offending elements under a failed one. The transcript's card and
 * the composer's badge both list a report this way.
 */
export function ValidationChecks({ checks }: ValidationChecksProps) {
  return (
    <ul className="at-validation__checks">
      {checks.map((check) => (
        <li
          key={check.id}
          className="at-validation__check"
          data-pass={check.pass}
          data-warn={check.warn || undefined}
        >
          {!check.pass ? (
            <X size={14} strokeWidth={2.5} aria-label={strings.validation.rule.failed} />
          ) : check.warn ? (
            <TriangleAlert size={14} aria-label={strings.validation.warning} />
          ) : (
            <Check size={14} strokeWidth={2.5} aria-label={strings.validation.rule.passed} />
          )}
          <span className="at-validation__label">{check.label}</span>
          {check.count > 0 && <span className="at-validation__count">{check.count}</span>}
          {!check.pass && check.issues.length > 0 && (
            <ul className="at-validation__issues">
              {check.issues.slice(0, SHOWN).map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
              {check.count > SHOWN && <li>{strings.validation.more(check.count - SHOWN)}</li>}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
