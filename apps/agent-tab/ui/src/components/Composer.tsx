import { strings } from "../strings";
import { Plus, Mic, X, File, Sparkles } from "lucide-react";
import type { ComposerProps } from "./types";
import "./composer.css";
import "./composer-effects.css";

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
  onAttach,
  onDictate,
  onSelect,
  contextNotice,
  sideChat,
  auxiliary,
  chips = [],
  onRemoveChip,
  effortLevel,
}: ComposerProps) {
  return (
    <footer className="at-prompt" data-effort={effortLevel}>
      {sideChat}
      {auxiliary}
      {notices}
      {contextNotice && (
        <div className="at-prompt__context-note" role="status">
          {contextNotice}
        </div>
      )}
      {menu && <div className="at-prompt__menu">{menu}</div>}
      <div className="at-prompt__box">
        <button
          className="at-prompt__icon"
          type="button"
          aria-label={strings.attachContext}
          title={strings.attachContext}
          onClick={onAttach}
        >
          <Plus size={18} />
        </button>
        <div className="at-prompt__writing">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="at-chip"
              data-kind={chip.kind}
              title={chip.uri ?? chip.command}
            >
              {chip.command ? (
                <Sparkles size={12} aria-hidden="true" />
              ) : (
                <File size={12} aria-hidden="true" />
              )}
              <span>{chip.label}</span>
              <button
                type="button"
                aria-label={strings.removeChip(chip.label)}
                onClick={() => onRemoveChip?.(chip.id)}
              >
                <X size={11} />
              </button>
            </span>
          ))}
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
            onSelect={(event) => onSelect?.(event.currentTarget.selectionStart)}
          />
        </div>
        <button
          className="at-prompt__icon"
          type="button"
          aria-label={strings.dictate}
          title={strings.dictateLater}
          onClick={onDictate}
        >
          <Mic size={17} />
        </button>
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
