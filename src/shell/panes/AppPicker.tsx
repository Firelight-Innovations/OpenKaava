/**
 * The compact "open an app" picker: a filter field over the list of everything
 * the Apps menu offers, with the arrow keys, Enter and Escape a menu has.
 *
 * It draws the list it is handed and decides nothing about it. `WindowRoot`
 * passes the same `Openable[]` the Apps menu is built from, and the same open
 * handler, so an app added to the registry shows up here with no edit.
 *
 * Portalled to `document.body` under a transparent backdrop, for the reason
 * `switcher/AddAppButton.tsx` gives at length: a pane's strip is a scroll
 * container and would clip it, and a click on an app's iframe never reaches the
 * shell's `window`, so a backdrop is the one dismissal that works everywhere.
 * With an `anchor` it hangs under the button; without one it sits near the top,
 * centred, which is where the empty state, the shortcut and the palette raise it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppWindow, FileText, Terminal, type LucideIcon } from "lucide-react";
import type { Openable } from "../../bindings";
import { filterApps, stepIndex } from "./pickerFilter";
import "./picker.css";

/** A per-app glyph where one is obvious; everything else is a generic window. */
const ICONS: Record<string, LucideIcon> = { terminal: Terminal, files: FileText };

export interface AppPickerProps {
  apps: Openable[];
  /** Why nothing can be opened right now, or `undefined`. Rows are inert with it. */
  blocked?: string;
  /** Viewport coordinates of the popover's top-left corner. `null`: centred. */
  anchor?: { top: number; left: number } | null;
  onPick: (entry: Openable) => void;
  onClose: () => void;
}

/** Keeps an anchored popover inside the window; matches `.app-picker`'s width. */
const WIDTH = 280;
const EDGE_GAP = 8;

export default function AppPicker({ apps, blocked, anchor, onPick, onClose }: AppPickerProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const fieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = useMemo(() => filterApps(apps, query), [apps, query]);
  // Clamped rather than corrected in an effect, so no frame paints a highlight
  // off the end of a list that just shrank.
  const active = rows.length === 0 ? 0 : Math.min(index, rows.length - 1);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (entry: Openable | undefined) => {
    if (entry === undefined || blocked !== undefined) return;
    onPick(entry);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(stepIndex(active, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const style = anchor
    ? {
        top: anchor.top,
        left: Math.max(EDGE_GAP, Math.min(anchor.left, window.innerWidth - WIDTH - EDGE_GAP)),
      }
    : undefined;

  return createPortal(
    <div
      className="app-picker__backdrop"
      // `onMouseDown` on the backdrop itself, so a press inside the popover is
      // never mistaken for one outside it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="app-picker"
        data-centered={anchor ? undefined : true}
        style={style}
        role="dialog"
        aria-label="Open an app"
      >
        <input
          ref={fieldRef}
          className="app-picker__field"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="app-picker-list"
          aria-label="Filter apps"
          placeholder="Open an app…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        {blocked !== undefined && <p className="app-picker__note">{blocked}</p>}
        {rows.length === 0 ? (
          <p className="app-picker__empty">No app matches that.</p>
        ) : (
          <ul id="app-picker-list" ref={listRef} className="app-picker__list" role="listbox">
            {rows.map((entry, i) => {
              const Icon = ICONS[entry.id] ?? (entry.kind === "terminal" ? Terminal : AppWindow);
              return (
                <li
                  key={entry.id}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={blocked !== undefined || undefined}
                  className="app-picker__row"
                  data-active={i === active || undefined}
                  title={entry.description}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => pick(entry)}
                >
                  <Icon size={16} strokeWidth={1.5} className="app-picker__icon" aria-hidden />
                  <span className="app-picker__name">{entry.name}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
