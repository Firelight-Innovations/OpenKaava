import { useEffect, useRef, useState, type MouseEvent } from "react";
import { strings } from "../strings";
import {
  Bookmark,
  File,
  FileText,
  Folder,
  Frame,
  GitBranch,
  Link,
  MessageSquare,
  Mic,
  MousePointer2,
  Plus,
  Shapes,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ComposerProps } from "./types";
import "./composer.css";
import "./composer-effects.css";

/** A chip's glyph, by the kind of thing it points at. */
const CHIP_ICON: Record<string, LucideIcon> = {
  skill: Sparkles,
  file: FileText,
  folder: Folder,
  canvas: Shapes,
  frame: Frame,
  comment: MessageSquare,
  "design-comment": MessageSquare,
  issue: Link,
  cluster: GitBranch,
  context: Bookmark,
  selection: MousePointer2,
};

/** What a press on the card that misses its controls should not take focus from. */
const INTERACTIVE = "button, a, input, textarea, select, [role='menu'], [role='listbox']";

/**
 * The prompt box: notices, then one rounded card holding the chips, the input,
 * and a toolbar along its foot — attach and the settings button at the left,
 * the meters, dictation and Send or Stop at the right.
 *
 * Pressing anywhere on the card that is not a control puts the caret in the
 * input, the way a text field the size of the card would.
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
  sideChat,
  plan,
  auxiliary,
  chips = [],
  onRemoveChip,
  effortLevel,
}: ComposerProps) {
  const focusInput = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
    event.preventDefault();
    const input = event.currentTarget.querySelector("textarea");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  };
  // Turning Ultra on sweeps the card once, then it is the plain card again.
  // No other effort change touches it.
  const [surge, setSurge] = useState(false);
  const lastEffort = useRef(effortLevel);
  useEffect(() => {
    const was = lastEffort.current;
    lastEffort.current = effortLevel;
    if (was === effortLevel) return;
    setSurge(effortLevel === "ultra");
    if (effortLevel !== "ultra") return;
    const timer = window.setTimeout(() => setSurge(false), 1400);
    return () => window.clearTimeout(timer);
  }, [effortLevel]);
  const floating = auxiliary ?? menu;
  return (
    <footer className="at-prompt" data-surge={surge ? "" : undefined}>
      {sideChat}
      {plan}
      {notices}
      {floating && <div className="at-prompt__menu">{floating}</div>}
      <div className="at-prompt__box" onMouseDown={focusInput}>
        {chips.length > 0 && (
          <div className="at-prompt__chips">
            {chips.map((chip) => {
              const Icon = chip.command ? Sparkles : (CHIP_ICON[chip.kind] ?? File);
              return (
                <span
                  key={chip.id}
                  className="at-chip"
                  data-kind={chip.kind}
                  title={chip.uri ?? chip.command}
                >
                  <Icon size={12} aria-hidden="true" />
                  <span>{chip.label}</span>
                  <button
                    type="button"
                    aria-label={strings.removeChip(chip.label)}
                    onClick={() => onRemoveChip?.(chip.id)}
                  >
                    <X size={11} />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <textarea
          ref={ref}
          className="at-prompt__input"
          aria-label={strings.promptLabel}
          placeholder={placeholder}
          value={value}
          rows={1}
          aria-activedescendant={menuActiveId ? `menu-item-${menuActiveId}` : undefined}
          onChange={(event) => onChange(event.target.value, event.target.selectionStart)}
          onKeyDown={onKeyDown}
          onSelect={(event) => onSelect?.(event.currentTarget.selectionStart)}
        />
        <div className="at-prompt__toolbar">
          <button
            className="at-prompt__icon"
            type="button"
            aria-label={strings.attachContext}
            title={strings.attachContext}
            onClick={onAttach}
          >
            <Plus size={16} />
          </button>
          {controls}
          <span className="at-prompt__spacer" />
          {meters}
          <button
            className="at-prompt__icon"
            type="button"
            aria-label={strings.dictate}
            title={strings.dictateLater}
            onClick={onDictate}
          >
            <Mic size={15} />
          </button>
          {action}
        </div>
      </div>
    </footer>
  );
}
