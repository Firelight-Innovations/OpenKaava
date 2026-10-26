import { strings } from "../strings";
import type { ComposerProps } from "./types";
import "./composer.css";

/**
 * The prompt box: notices, then one rounded card holding the input with Send
 * or Stop at its end, then a quiet row under the card with the settings button
 * at the left and the meters at the right.
 */
export function Composer({
  ref,
  value,
  placeholder,
  onChange,
  onKeyDown,
  notices,
  menu,
  menuActiveId,
  controls,
  meters,
  action,
}: ComposerProps) {
  return (
    <footer className="at-prompt">
      {notices}
      {menu && <div className="at-prompt__menu">{menu}</div>}
      <div className="at-prompt__box">
        <textarea
          ref={ref}
          className="at-prompt__input"
          aria-label={strings.promptLabel}
          placeholder={placeholder}
          value={value}
          rows={1}
          aria-activedescendant={menuActiveId ? `menu-item-${menuActiveId}` : undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {action}
      </div>
      <div className="at-prompt__footer">
        {controls}
        <span className="at-prompt__spacer" />
        {meters}
      </div>
    </footer>
  );
}
