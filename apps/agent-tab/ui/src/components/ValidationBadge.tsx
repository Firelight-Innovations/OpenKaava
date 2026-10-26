import { useEffect, useId, useRef, useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { ValidationBadgeProps } from "./types";
import "./meters.css";
import "./validation.css";

/**
 * The session's latest canvas validation beside the context ring: a tick when
 * every rule passed, a cross and the failed count when some did not, a spinner
 * while a check runs. A click opens the rules; Esc or a click elsewhere closes
 * them. Without a report it draws nothing.
 */
export function ValidationBadge({ running, report }: ValidationBadgeProps) {
  const S = useSlots();
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const shown = running || report !== null;

  // Esc is heard first, in the capture phase, and goes no further: closing
  // the popover does not also reach the prompt box and stop the turn.
  useEffect(() => {
    if (!open) return;
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    const press = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", press, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", press, true);
    };
  }, [open]);

  if (!shown) return null;
  const failed = report ? report.checks.filter((check) => !check.pass).length : 0;
  const tone = running ? "running" : failed === 0 ? "pass" : "fail";
  const label = running
    ? strings.validation.badge.running
    : failed === 0
      ? strings.validation.badge.passed
      : strings.validation.badge.failed(failed);
  const verdict = running
    ? strings.validation.running
    : failed === 0
      ? strings.validation.passed
      : strings.validation.failed(failed);

  return (
    <span className="at-vbadge" ref={root}>
      <button
        ref={button}
        type="button"
        className={`at-vbadge__button at-vbadge--${tone}`}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        {running ? (
          <LoaderCircle className="at-validation__spin" size={14} aria-hidden="true" />
        ) : failed === 0 ? (
          <Check size={14} strokeWidth={2.5} aria-hidden="true" />
        ) : (
          <>
            <X size={14} strokeWidth={2.5} aria-hidden="true" />
            <span className="at-vbadge__count">{failed}</span>
          </>
        )}
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={strings.validation.title} className="at-vbadge__pop">
          <div className="at-card__head">
            <span>{strings.validation.heading}</span>
            <span className={`at-card__figure at-vbadge--${tone}`}>{verdict}</span>
          </div>
          {report && <S.ValidationChecks checks={report.checks} />}
        </div>
      )}
    </span>
  );
}
