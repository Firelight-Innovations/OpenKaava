/**
 * The command palette: one panel over a dimmed window, with a page for the
 * commands and a page for the apps.
 *
 * A sheet portalled to `document.body` rather than a band in the frame, and
 * that is the same call `SettingsScreen` made for the same reason — the palette
 * is not a place in the layout. It is opened, used and gone in a few seconds,
 * nothing may be dragged into it, and the window underneath must be exactly as
 * it was when it closes.
 *
 * The scrim is always there while the palette is, on every page: choosing
 * "Open app…" moves to the apps page inside the same `role="dialog"` element
 * rather than swapping to another popup, so nothing flashes and the window
 * behind stays dimmed. The field, rows, icons and sizing are the app picker's
 * own (`PickerParts.tsx`).
 *
 * The surface is mounted fresh on every open and every change of starting page
 * (`key`), which is why nothing here resets state: an unmount is the reset.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, Command as CommandIcon } from "lucide-react";
import type { Openable } from "../../bindings";
import { settingsBackdrop, settingsScreen } from "../motion";
import { PickerField, PickerRow, iconFor } from "../PickerParts";
import { filterApps, stepIndex } from "../pickerFilter";
import { matchRuns } from "./fuzzy";
import { initialIndex, rankCommands, type Command, type RankedCommand } from "./registry";
import "./palette.css";

export type PalettePage = "commands" | "apps";

export interface CommandPaletteProps {
  open: boolean;
  /** Which page it opens on: Ctrl+Shift+P on the commands, Ctrl+Shift+A on the apps. */
  page?: PalettePage;
  /** Every command the shell has, flattened from the live menu tree. Rebuilt on
   *  every render of the window, so a row that has just become possible is
   *  possible here in the same frame. */
  commands: Command[];
  /** The apps page's list: the Apps menu's own. */
  apps: Openable[];
  /** Why nothing can be opened right now, or `undefined`. */
  blocked?: string;
  onPickApp: (entry: Openable) => void;
  onClose: () => void;
}

/**
 * The portal is outside `AnimatePresence` and the surface inside it, which is
 * `ContextMenuHost`'s shape rather than a choice made again here — the wrapper
 * is always rendered so presence can watch the sheet leave, and an empty one
 * draws no DOM.
 */
export default function CommandPalette({
  open,
  page = "commands",
  commands,
  apps,
  blocked,
  onPickApp,
  onClose,
}: CommandPaletteProps) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="palette"
          data-testid="palette-backdrop"
          variants={settingsBackdrop}
          initial="initial"
          animate="animate"
          exit="exit"
          // `onMouseDown` on the backdrop itself, so a press inside the sheet is
          // never mistaken for one outside it, and a selection dragged past the
          // edge is not a dismissal.
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            className="app-picker palette__sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            variants={settingsScreen}
          >
            <Palette
              key={page}
              initialPage={page}
              commands={commands}
              apps={apps}
              blocked={blocked}
              onPickApp={onPickApp}
              onClose={onClose}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** The sheet's contents: a page of commands, a page of apps, or the one field a
 *  command that needs an argument asked for. */
function Palette({
  initialPage,
  commands,
  apps,
  blocked,
  onPickApp,
  onClose,
}: Omit<CommandPaletteProps, "open" | "page"> & { initialPage: PalettePage }) {
  const [page, setPage] = useState<PalettePage>(initialPage);

  // The command whose one line of text is being asked for, or `null` for the
  // list. Two stages in one surface rather than handing the person back to the
  // menu to find the row with the field on it.
  const [asking, setAsking] = useState<Command | null>(null);

  if (asking !== null) {
    return <PromptStage command={asking} onDone={onClose} onBack={() => setAsking(null)} />;
  }

  // Keyed by page so the field, the query and the highlight are fresh on each,
  // and so the short fade replays on the swap.
  return page === "apps" ? (
    <AppsPage
      key="apps"
      apps={apps}
      blocked={blocked}
      onPick={(entry) => {
        onPickApp(entry);
        onClose();
      }}
      onBack={() => setPage("commands")}
      onClose={onClose}
    />
  ) : (
    <CommandsPage
      key="commands"
      commands={commands}
      onDrill={setPage}
      onAsk={setAsking}
      onClose={onClose}
    />
  );
}

/** Escape closes, and is stopped here rather than left to bubble: `SearchSlot`
 *  listens for Escape on the window, and dismissing this should not also close
 *  a search the palette was opened over. */
function closeOnEscape(e: React.KeyboardEvent, onClose: () => void) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  onClose();
}

/** True when the caret sits at the very end of the field, where ArrowRight has
 *  nothing left to move past and can mean "go in". */
function caretAtEnd(input: HTMLInputElement): boolean {
  return input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
}

function CommandsPage({
  commands,
  onDrill,
  onAsk,
  onClose,
}: {
  commands: Command[];
  onDrill: (page: PalettePage) => void;
  onAsk: (command: Command) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => rankCommands(commands, query), [commands, query]);
  const [index, setIndex] = useState(() => initialIndex(rows));
  const listRef = useRef<HTMLUListElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  // Clamped rather than corrected in an effect. The list shrinks under a stored
  // index on every keystroke, and an effect that fixed it afterwards would let
  // one frame paint with the highlight off the end of the list.
  const active = rows.length === 0 ? 0 : Math.min(index, rows.length - 1);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  // `block: "nearest"` so a highlight already on screen does not scroll the
  // list under it.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onQuery = (value: string) => {
    setQuery(value);
    // Back to the first row that can run, in the same update as the text that
    // changed the list.
    setIndex(initialIndex(rankCommands(commands, value)));
  };

  const run = (row: RankedCommand | undefined) => {
    if (row === undefined || row.command.disabled) return;
    if (row.command.drill) {
      onDrill(row.command.drill);
      return;
    }
    if (row.command.prompt) {
      onAsk(row.command);
      return;
    }
    row.command.onSelect?.();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(stepIndex(active, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(rows[active]);
    } else if (e.key === "ArrowRight") {
      const row = rows[active];
      if (row?.command.drill && caretAtEnd(e.currentTarget)) {
        e.preventDefault();
        run(row);
      }
    } else {
      closeOnEscape(e, onClose);
    }
  };

  return (
    <div className="palette__page">
      <PickerField
        ref={fieldRef}
        listId="palette-list"
        label="Run a command"
        placeholder="Type a command"
        value={query}
        onChange={onQuery}
        onKeyDown={onKeyDown}
      />

      {rows.length === 0 ? (
        <p className="app-picker__empty">No command matches that.</p>
      ) : (
        <ul id="palette-list" ref={listRef} className="app-picker__list" role="listbox">
          {rows.map((row, i) => (
            <PickerRow
              // Indexed as well as labelled: two presets saved under one name
              // would otherwise be one key for two rows.
              key={`${row.command.label}-${i}`}
              icon={row.command.icon ?? CommandIcon}
              active={i === active}
              disabled={row.command.disabled}
              // The reason rides on the row: a `disabled` button receives no
              // pointer events, so a `title` there would be readable on exactly
              // the rows that never need explaining.
              title={row.command.hint}
              accelerator={row.command.accelerator}
              chevron={row.command.drill !== undefined}
              // Focus follows the pointer, so the row under the cursor is the
              // row Enter would run.
              onHover={() => setIndex(i)}
              onRun={() => run(row)}
            >
              {matchRuns(row.command.label, row.positions).map((part, j) =>
                part.hit ? (
                  <mark key={j} className="palette__hit">
                    {part.text}
                  </mark>
                ) : (
                  <span key={j}>{part.text}</span>
                ),
              )}
            </PickerRow>
          ))}
        </ul>
      )}
    </div>
  );
}

function AppsPage({
  apps,
  blocked,
  onPick,
  onBack,
  onClose,
}: {
  apps: Openable[];
  blocked?: string;
  onPick: (entry: Openable) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const fieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = useMemo(() => filterApps(apps, query), [apps, query]);
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
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(stepIndex(active, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[active]);
    } else if (e.key === "Backspace" && query === "") {
      e.preventDefault();
      onBack();
    } else if (e.key === "ArrowLeft" && e.currentTarget.selectionEnd === 0) {
      // Only with the caret at the start, so ← still edits the text otherwise.
      e.preventDefault();
      onBack();
    } else {
      closeOnEscape(e, onClose);
    }
  };

  return (
    <div className="palette__page">
      <button type="button" className="palette__crumb" onClick={onBack}>
        <ChevronLeft size={14} strokeWidth={1.5} aria-hidden />
        <span>Commands</span>
        <span className="palette__crumb-sep" aria-hidden>
          ›
        </span>
        <span className="palette__crumb-here">Open app</span>
      </button>
      <PickerField
        ref={fieldRef}
        listId="palette-apps-list"
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
        <ul id="palette-apps-list" ref={listRef} className="app-picker__list" role="listbox">
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
  );
}

/**
 * The prompt stage: one line of text for a command that needs one.
 *
 * The same shape `MenuItemList`'s `PromptField` uses, and for the same reasons —
 * the refusal is shown under the field because it is an answer to what was just
 * typed, and success closes the whole surface because the thing asked for
 * happened.
 */
function PromptStage({
  command,
  onDone,
  onBack,
}: {
  command: Command;
  onDone: () => void;
  onBack: () => void;
}) {
  const prompt = command.prompt;
  const [value, setValue] = useState(prompt?.initialValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, []);

  if (prompt === undefined) return null;

  const submit = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    prompt
      .onSubmit(value)
      .then(onDone)
      .catch((err: unknown) => {
        // Rust's `AppError` serializes to its message and arrives as a bare
        // string; anything else is a fault rather than a refusal and still has
        // to say something, or the button would look broken.
        setError(typeof err === "string" ? err : String(err));
        setBusy(false);
        fieldRef.current?.focus();
      });
  };

  return (
    <form
      className="palette__prompt"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="palette__prompt-command">{command.label}</p>
      <label className="palette__prompt-label" htmlFor="palette-prompt-field">
        {prompt.label}
      </label>
      <input
        id="palette-prompt-field"
        ref={fieldRef}
        className="app-picker__field"
        value={value}
        placeholder={prompt.placeholder}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          if (error !== null) setError(null);
        }}
        // Escape backs out to the list rather than closing the surface: the
        // command was chosen deliberately and the field is one keystroke of
        // that choice, so undoing it should undo one step.
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          onBack();
        }}
      />
      {error !== null && <p className="palette__error">{error}</p>}
      <button type="submit" className="palette__confirm" disabled={busy || value.trim() === ""}>
        {prompt.confirmLabel}
      </button>
    </form>
  );
}
