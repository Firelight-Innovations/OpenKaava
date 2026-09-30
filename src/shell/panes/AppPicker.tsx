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
import type { Openable } from "../../bindings";
import { filterApps, stepIndex } from "../pickerFilter";
import { PickerField, PickerRow, iconFor } from "../PickerParts";

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
        <PickerField
          ref={fieldRef}
          listId="app-picker-list"
          label="Filter apps"
          placeholder="Open an app…"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        {blocked !== undefined && <p className="app-picker__note">{blocked}</p>}
        {rows.length === 0 ? (
          <p className="app-picker__empty">No app matches that.</p>
        ) : (
          <ul id="app-picker-list" ref={listRef} className="app-picker__list" role="listbox">
            {rows.map((entry, i) => (
              <PickerRow
                key={entry.id}
                icon={iconFor(entry)}
                active={i === active}
                disabled={blocked !== undefined}
                title={entry.description}
                onHover={() => setIndex(i)}
                onRun={() => pick(entry)}
              >
                {entry.name}
              </PickerRow>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
