/**
 * The cluster icon picker, after the iPhone group-icon sheet: the current icon
 * on top, a Suggestions row of the initials in each palette tint, and a grid of
 * emoji each on its own soft tint. A field takes any emoji typed or pasted, and
 * filters the grid by name when given a word instead.
 *
 * Choosing anything applies it and closes, like the sheet's tap-to-pick; there is
 * no Save. "Reset to initials" is the way back to the default.
 *
 * Keyboard: the field is focused on open; Tab reaches the suggestions, then the
 * grid, which is one tab stop with the arrow keys moving inside it (Left/Right by
 * one, Up/Down by a row, Home/End to the ends); Enter picks; Escape closes.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Cluster, ClusterIcon } from "../../bindings";
import ClusterChip from "../ClusterChip";
import { EMOJI, EMOJI_COLUMNS, ICON_COLORS, iconColorOf, looksLikeEmoji } from "../clusterIcon";
import Dialog from "./Dialog";
import "./ClusterIconDialog.css";

export interface ClusterIconDialogProps {
  cluster: Cluster;
  /** The chosen icon, or `null` for a reset to the initials. */
  onPick: (icon: ClusterIcon | null) => void;
  onCancel: () => void;
}

export default function ClusterIconDialog({ cluster, onPick, onCancel }: ClusterIconDialogProps) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

  const typed = looksLikeEmoji(query) ? query.trim() : null;
  const shown = useMemo(() => {
    const all = EMOJI.map((e, i) => ({ ...e, tint: ICON_COLORS[i % ICON_COLORS.length] }));
    const q = query.trim().toLowerCase();
    if (q === "" || typed !== null) return all;
    return all.filter((e) => e.name.includes(q));
  }, [query, typed]);

  const keepColor = iconColorOf(cluster.icon) ?? null;

  const moveInGrid = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = shown.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(focused + 1, last);
    else if (e.key === "ArrowLeft") next = Math.max(focused - 1, 0);
    else if (e.key === "ArrowDown") next = Math.min(focused + EMOJI_COLUMNS, last);
    else if (e.key === "ArrowUp") next = Math.max(focused - EMOJI_COLUMNS, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    setFocused(next);
    gridRef.current?.querySelectorAll<HTMLElement>("[data-emoji]")[next]?.focus();
  };

  return (
    <Dialog label={`Change icon for ${cluster.name}`} onCancel={onCancel} className="icon-dialog">
      <div className="icon-dialog__body">
        <div className="icon-dialog__preview">
          <span className="icon-dialog__preview-chip">
            <ClusterChip cluster={cluster} />
          </span>
          <span className="icon-dialog__name">{cluster.name}</span>
        </div>

        <input
          type="text"
          className="icon-dialog__search"
          placeholder="Search, or type or paste an emoji"
          aria-label="Search or enter an emoji"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed !== null) {
              e.preventDefault();
              onPick({ emoji: typed, color: keepColor });
            }
          }}
        />
        {typed !== null && (
          <button
            type="button"
            className="icon-dialog__use"
            onClick={() => onPick({ emoji: typed, color: keepColor })}
          >
            Use {typed}
          </button>
        )}

        <section aria-labelledby="icon-dialog-suggestions">
          <h3 id="icon-dialog-suggestions" className="icon-dialog__heading">
            Suggestions
          </h3>
          <div className="icon-dialog__row">
            {ICON_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className="icon-dialog__tile"
                aria-label={`Initials on ${color}`}
                onClick={() => onPick({ emoji: "", color })}
              >
                <ClusterChip cluster={cluster} icon={{ emoji: "", color }} />
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="icon-dialog-more">
          <h3 id="icon-dialog-more" className="icon-dialog__heading">
            More
          </h3>
          {shown.length === 0 ? (
            <p className="icon-dialog__empty">No emoji match &ldquo;{query.trim()}&rdquo;.</p>
          ) : (
            <div
              className="icon-dialog__grid"
              role="group"
              aria-label="Emoji"
              ref={gridRef}
              onKeyDown={moveInGrid}
            >
              {shown.map((e, i) => (
                <button
                  key={e.emoji}
                  type="button"
                  data-emoji
                  className="icon-dialog__tile"
                  aria-label={e.name.split(" ")[0]}
                  title={e.name}
                  tabIndex={i === Math.min(focused, shown.length - 1) ? 0 : -1}
                  onFocus={() => setFocused(i)}
                  onClick={() => onPick({ emoji: e.emoji, color: e.tint })}
                >
                  <ClusterChip cluster={cluster} icon={{ emoji: e.emoji, color: e.tint }} />
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="icon-dialog__footer">
          <button
            type="button"
            className="k-btn k-btn--secondary"
            disabled={!cluster.icon}
            onClick={() => onPick(null)}
          >
            Reset to initials
          </button>
          <button type="button" className="k-btn k-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
