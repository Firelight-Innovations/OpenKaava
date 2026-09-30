import { Fragment, Suspense, lazy, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Search } from "../../ui/Icon";
import { instant, instantOut, popover } from "../motion";
import { ALL_KINDS, KIND_LABEL } from "./kinds";
import type { SearchSession } from "./useSearchSession";
import type { ResultRow, SearchHit, SearchKind, SearchMatch } from "./types";
import "./searchOverlay.css";

/**
 * The search dialog: a command-palette-style overlay over a scrim.
 *
 * Search is a mode you enter, use and leave in a few seconds, so it is a
 * dialog rather than a place in the layout. The workspace stays drawn behind
 * the scrim, and closing it puts nothing back because nothing was moved.
 *
 * The field, the type filters and the results share one box and one focus:
 * the input never loses it, which is why the arrow keys and Enter are bound
 * on the panel and the rows are not tabbable.
 */

/** Monaco is heavy enough that it must not sit in the startup bundle, so the
 *  lazy boundary goes around the preview alone. The list draws instantly and
 *  the editor arrives a moment later. */
const PreviewPane = lazy(() => import("./PreviewPane"));

/** The viewport width at which the preview earns its half of the dialog. */
const PREVIEW_MIN_WIDTH = 1000;

export interface SearchOverlayProps {
  session: SearchSession;
  /** The active cluster's directory. Null when no project is open. */
  root: string | null;
  clusterId: string | null;
  /** Open one result in the Files app. Takes the path rather than reading the
   *  focused row, because a click means the row under the pointer. */
  onOpen: (path: string) => void;
  /** Enter: open whatever the cursor is on. */
  onSubmit: () => void;
  onClose: () => void;
}

export default function SearchOverlay({
  session,
  root,
  clusterId,
  onOpen,
  onSubmit,
  onClose,
}: SearchOverlayProps) {
  const { rows, searching, parsed, activeIndex, setActiveIndex, focus, kinds, toggleKind } =
    session;
  const inputRef = useRef<HTMLInputElement>(null);
  const wide = useMinWidth(PREVIEW_MIN_WIDTH);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // On the document rather than the panel, so Escape still closes after a
  // click on the panel's own padding has moved focus to the body.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  function onPanelKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      session.moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      session.moveActive(-1);
    } else if (e.key === "Enter" && e.target === inputRef.current) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <motion.div
      className="k-dialog-scrim search-dialog__scrim"
      data-region="search-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: instant }}
      exit={{ opacity: 0, transition: instantOut }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        className={`k-dialog search-dialog${wide ? " search-dialog--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        variants={popover}
        initial="initial"
        animate="animate"
        exit="exit"
        onKeyDown={onPanelKeyDown}
      >
        <div className="search-dialog__head">
          <label className="search-dialog__field">
            <Search size={16} className="search-dialog__glyph" />
            <input
              ref={inputRef}
              className="search-dialog__input"
              value={session.query}
              onChange={(e) => session.setQuery(e.target.value)}
              placeholder="Search this project"
              aria-label="Search this project"
              spellCheck={false}
              autoComplete="off"
            />
            <kbd className="k-kbd">Esc</kbd>
          </label>
        </div>

        <div className="search-dialog__filters" role="group" aria-label="Filter by type">
          {ALL_KINDS.map((kind) => (
            <KindChip
              key={kind}
              kind={kind}
              selected={kinds.includes(kind)}
              onToggle={() => toggleKind(kind)}
            />
          ))}
          <span className="search-dialog__count">{kinds.length} of 4 types</span>
        </div>

        <div className="search-dialog__main">
          <div className="search-dialog__results">
            <ResultsRegion
              rows={rows}
              searching={searching}
              // The needle, not the raw field text: a field holding only
              // filters has nothing to search *for* yet, and "no results"
              // would blame the filter for a term that was never given.
              needle={parsed.needle}
              root={root}
              activeIndex={activeIndex}
              onFocusIndex={setActiveIndex}
              onOpen={onOpen}
            />
          </div>
          {wide && (
            <div className="search-dialog__preview">
              <Suspense fallback={<div className="search-dialog__preview-loading" />}>
                <PreviewPane clusterId={clusterId} focus={focus} />
              </Suspense>
            </div>
          )}
        </div>

        <footer className="search-dialog__footer">
          <span>
            <kbd className="k-kbd">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="k-kbd">Enter</kbd> open
          </span>
          <span>
            <kbd className="k-kbd">Esc</kbd> close
          </span>
        </footer>
      </motion.div>
    </motion.div>
  );
}

/** A compact type-filter chip. Toggling rewrites the field's `kind:` tokens
 *  through the session, so the chip and the typed token are one state. */
function KindChip({
  kind,
  selected,
  onToggle,
}: {
  kind: SearchKind;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="search-dialog__chip"
      aria-pressed={selected}
      onClick={onToggle}
    >
      {KIND_LABEL[kind]}
    </button>
  );
}

/**
 * The results list, grouped by kind with a heading where the kind changes.
 *
 * The session already orders hits by kind, so the headings are a pure
 * function of the flat rows the cursor indexes — grouping adds no rows the
 * arrow keys could land on.
 */
function ResultsRegion({
  rows,
  searching,
  needle,
  root,
  activeIndex,
  onFocusIndex,
  onOpen,
}: {
  rows: ResultRow[];
  searching: boolean;
  needle: string;
  root: string | null;
  activeIndex: number;
  onFocusIndex: (index: number) => void;
  onOpen: (path: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // The cursor moves from the keyboard while the pointer sits still, so the
  // active row can leave the scrolled view without the pointer being involved.
  useEffect(() => {
    const container = scrollRef.current;
    const row = container?.querySelector<HTMLElement>('[data-active="true"]');
    if (!container || !row) return;

    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowTop < container.scrollTop) {
      container.scrollTop = rowTop;
    } else if (rowBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = rowBottom - container.clientHeight;
    }
  }, [activeIndex, rows]);

  if (root === null) return <Empty title="No project open in this cluster" />;
  if (needle.trim() === "") return <Empty title="Search this project" />;
  if (rows.length === 0) return <Empty title={searching ? "Searching…" : "No results"} />;

  return (
    <div className="search-dialog__list" role="listbox" aria-label="Results" ref={scrollRef}>
      {rows.map((row, index) => {
        const previous = rows[index - 1];
        const startsGroup = row.row === "file" && (!previous || previous.hit.kind !== row.hit.kind);
        const key = row.row === "file" ? `f:${row.hit.path}` : `m:${row.hit.path}:${row.ordinal}`;
        return (
          <Fragment key={key}>
            {startsGroup && <div className="search-dialog__group">{KIND_LABEL[row.hit.kind]}</div>}
            {row.row === "file" ? (
              <FileRow
                hit={row.hit}
                root={root}
                active={index === activeIndex}
                onFocus={() => onFocusIndex(index)}
                onOpen={() => onOpen(row.hit.path)}
              />
            ) : (
              <MatchRow
                match={row.match}
                active={index === activeIndex}
                onFocus={() => onFocusIndex(index)}
                // Opens the file the match is in. The line is not carried
                // across yet: `files:open-path` takes a path and nothing else.
                onOpen={() => onOpen(row.hit.path)}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** One file: its name, where it lives, and how many times the query is in it. */
function FileRow({
  hit,
  root,
  active,
  onFocus,
  onOpen,
}: {
  hit: SearchHit;
  root: string;
  active: boolean;
  onFocus: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className="search-dialog__row"
      data-active={active || undefined}
      onMouseEnter={onFocus}
      onClick={onOpen}
      role="option"
      aria-selected={active}
    >
      <span className="search-dialog__row-name">{hit.name}</span>
      <span className="search-dialog__row-path">{relativeTo(root, hit.path)}</span>
      {/* Absent rather than "0" for a name-only hit: a zero beside a file that
          genuinely matched reads as a contradiction. */}
      {hit.matches.length > 0 && (
        <span className="search-dialog__row-count">{hit.matches.length}</span>
      )}
    </div>
  );
}

/** One match inside the file above it: the line number locates it and the
 *  trimmed text identifies it. `match.column` still indexes the untrimmed line,
 *  which is what the preview highlights against. */
function MatchRow({
  match,
  active,
  onFocus,
  onOpen,
}: {
  match: SearchMatch;
  active: boolean;
  onFocus: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className="search-dialog__row search-dialog__row--match"
      data-active={active || undefined}
      onMouseEnter={onFocus}
      onClick={onOpen}
      role="option"
      aria-selected={active}
    >
      <span className="search-dialog__row-line">{match.line}</span>
      <span className="search-dialog__row-snippet">{match.text.trim()}</span>
    </div>
  );
}

function Empty({ title }: { title: string }) {
  return (
    <div className="search-dialog__empty">
      <p className="search-dialog__empty-title">{title}</p>
    </div>
  );
}

/** True while the viewport is at least `px` wide. False where `matchMedia` does
 *  not exist, so the preview simply stays out of a test environment. */
function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * The path to show on a row: relative to the search root, without the file's
 * own name, since the name already has its own column. Falls back to the
 * absolute path if the hit somehow sits outside the root, because a row that
 * silently showed the wrong folder would be worse than an ugly one.
 */
function relativeTo(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");

  if (!normalizedPath.startsWith(normalizedRoot + "/")) return normalizedPath;

  const rest = normalizedPath.slice(normalizedRoot.length + 1);
  const cut = rest.lastIndexOf("/");
  return cut === -1 ? "" : rest.slice(0, cut);
}
