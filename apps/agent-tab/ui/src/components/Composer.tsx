import { strings } from "../strings";
import type { ComposerProps } from "./types";
import "./composer.css";

/**
 * The prompt box: notices, then one rounded card holding the input and, under
 * it, a footer of controls and Send or Stop.
 */
export function Composer({
  ref,
  value,
  placeholder,
  onChange,
  onKeyDown,
  notices,
  controls,
  meters,
  action,
}: ComposerProps) {
  return (
    <footer className="at-prompt">
      {notices}
      <div className="at-prompt__box">
        <textarea
          ref={ref}
          className="at-prompt__input"
          aria-label={strings.promptLabel}
          placeholder={placeholder}
          value={value}
          rows={2}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="at-prompt__footer">
          {controls}
          <span className="at-prompt__spacer" />
          {meters}
          {action}
        </div>
      </div>
    </footer>
  );
}
