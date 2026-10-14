import { strings } from "../strings";
import type { ComposerProps } from "./types";
import "./composer.css";

/** The prompt box: notices, the input, then a footer of controls and Send or Stop. */
export function Composer({
  ref,
  value,
  placeholder,
  onChange,
  onKeyDown,
  notices,
  controls,
  action,
}: ComposerProps) {
  return (
    <footer className="at-prompt">
      {notices}
      <textarea
        ref={ref}
        className="at-prompt__input"
        aria-label={strings.promptLabel}
        placeholder={placeholder}
        value={value}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="at-prompt__footer">
        {controls}
        <span className="at-prompt__spacer" />
        {action}
      </div>
    </footer>
  );
}
