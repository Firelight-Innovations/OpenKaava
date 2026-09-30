/**
 * The pieces every "pick one thing from a filtered list" surface is made of:
 * the field, the row, and the glyph an app gets.
 *
 * The strip's `+` popover and the command palette both draw from here, which is
 * what keeps them one visual system — a row restyled in `picker.css` changes in
 * both, and there is no second set of classes to forget.
 */
import type { ReactNode } from "react";
import { AppWindow, ChevronRight, FileText, Terminal, type LucideIcon } from "lucide-react";
import type { Openable } from "../bindings";
import "./picker.css";

/** A per-app glyph where one is obvious; everything else is a generic window. */
const ICONS: Record<string, LucideIcon> = { terminal: Terminal, files: FileText };

export function iconFor(entry: Openable): LucideIcon {
  return ICONS[entry.id] ?? (entry.kind === "terminal" ? Terminal : AppWindow);
}

export function PickerField({
  ref,
  listId,
  label,
  placeholder,
  value,
  onChange,
  onKeyDown,
}: {
  ref?: React.Ref<HTMLInputElement>;
  listId: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      ref={ref}
      className="app-picker__field"
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls={listId}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}

export function PickerRow({
  icon: Icon,
  active,
  disabled,
  title,
  accelerator,
  chevron,
  onHover,
  onRun,
  children,
}: {
  icon?: LucideIcon;
  active: boolean;
  disabled?: boolean;
  title?: string;
  /** A keyboard shortcut, drawn at the right edge. */
  accelerator?: string;
  /** A right-facing chevron: activating the row opens another page. */
  chevron?: boolean;
  onHover: () => void;
  onRun: () => void;
  children: ReactNode;
}) {
  return (
    <li
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      className="app-picker__row"
      data-active={active || undefined}
      title={title}
      onMouseEnter={onHover}
      onClick={onRun}
    >
      {Icon && <Icon size={16} strokeWidth={1.5} className="app-picker__icon" aria-hidden />}
      <span className="app-picker__name">{children}</span>
      {accelerator !== undefined && <span className="app-picker__accel">{accelerator}</span>}
      {chevron && (
        <ChevronRight
          size={14}
          strokeWidth={1.5}
          className="app-picker__chevron"
          data-testid="picker-chevron"
          aria-hidden
        />
      )}
    </li>
  );
}
