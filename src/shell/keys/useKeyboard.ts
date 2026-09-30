/**
 * The shell's global keyboard shortcuts — everything except Ctrl+K and Escape,
 * which `SearchSlot` already owns (its own `keydown` listener opens on Ctrl+K and
 * its field's `onKeyDown` closes on Escape). Binding either here too would give
 * the shell two handlers racing for the same key, with the outcome depending on
 * listener order — so this hook deliberately leaves them alone. Confirmed by
 * reading `src/shell/search/SearchSlot.tsx` before writing anything below.
 *
 * Nothing here resolves *which* tool is at a given index, what "the booting
 * tool" is, or whether Save is even possible right now — that is `WindowRoot`'s
 * job, passed in as callbacks. An action that cannot run is a callback that
 * does nothing, decided by the same `blocked()` that greys the menu item out,
 * so a keystroke and a click can never disagree.
 */
import { useEffect, useRef } from "react";
import { hasPrimaryModifier } from "../accelerators";

/**
 * Everything the shell can be asked for by keystroke.
 *
 * The first three come from `docs/handoffs/shell-spec.html` — the only
 * accelerators that document states anywhere (it draws them in Mac notation,
 * which is how to find them in it): the "Open Forger" chip on the empty tool
 * window, the "Re-scan tools" chip in that same empty state, and "cancel Ctrl+."
 * under the booting-tool spinner. Everything after them is here because the menu
 * bar displays it.
 */
export interface KeyboardActions {
  /** Ctrl+1…Ctrl+9 — select the nth tool in this window's bar. */
  selectToolByIndex(index: number): void;
  /** Ctrl+R — re-scan tools. */
  rescan(): void;
  /** Ctrl+. — cancel the tool that is currently booting. */
  cancelBoot(): void;

  // --- File -----------------------------------------------------------------
  /** Ctrl+N */
  newFile(): void;
  /** Ctrl+Shift+N — open the New Cluster dialog (board 04). */
  newCluster(): void;
  /** Ctrl+O */
  openProject(): void;
  /** Ctrl+S */
  save(): void;
  /** Ctrl+Shift+S */
  saveAs(): void;
  /** Ctrl+D */
  duplicate(): void;
  /** Ctrl+Shift+W */
  closeWindow(): void;

  // --- View -----------------------------------------------------------------
  /** Ctrl+Shift+P */
  commandPalette(): void;
  /** Ctrl+Shift+A — the app picker. */
  openApp(): void;
  /** Ctrl+Alt+P and Shift+Alt+P — open the Switch project dialog (board 08). */
  switchProject(): void;
  /** Ctrl+B */
  togglePanel(): void;
  /** Ctrl+` */
  toggleTerminal(): void;
  /** F11 */
  toggleFullscreen(): void;
  /** Ctrl+= and Ctrl++ — both, because the two are the same physical key. */
  zoomIn(): void;
  /** Ctrl+- */
  zoomOut(): void;

  // --- Terminal -------------------------------------------------------------
  /** Ctrl+Shift+` */
  newTerminal(): void;
  /** Ctrl+\ */
  splitTerminal(): void;
}

type ChordRun = (a: KeyboardActions) => () => void;

/** One primary-modifier chord: what it runs plain, and what it runs with Shift. */
interface Chord {
  plain: ChordRun | null;
  shift: ChordRun | null;
}

/**
 * The accelerators, one row per `e.key.toLowerCase()`; `null` is declined on
 * purpose.
 *
 * The rule in `titlebar/TitleBar.tsx` is bind it or drop it — an accelerator
 * drawn beside a menu item is a promise the keystroke does that thing — so every
 * File, View and Terminal accelerator on display has a row here.
 *
 * The Edit menu's do not, and that is the same rule rather than an exception to
 * it. Ctrl+Z, Ctrl+X, Ctrl+F and the rest are already bound by the surface that
 * has focus: Monaco inside the Files iframe, the browser inside a shell
 * `<input>`. A key event inside a cross-document iframe never reaches this
 * listener, so a binding here could only ever fire when focus was *outside* the
 * editor — and where it did fire it would be a second handler racing the
 * browser's own for a key that already works. That is exactly the collision the
 * file header opens by describing.
 */
// Exported for `shortcuts.test.ts`, which holds the shortcuts screen to it.
export const CHORDS: Record<string, Chord> = {
  n: {
    plain: (a) => a.newFile,
    shift: (a) => a.newCluster,
  },
  o: {
    plain: (a) => a.openProject,
    shift: null,
  },
  s: {
    plain: (a) => a.save,
    shift: (a) => a.saveAs,
  },
  d: {
    plain: (a) => a.duplicate,
    shift: null,
  },
  // Only with Shift. Plain Ctrl+W closes a *tab* everywhere it is bound, and
  // this window is not one — binding it to "close the window" would be the most
  // destructive possible reading of a very common keystroke.
  w: {
    plain: null,
    shift: (a) => a.closeWindow,
  },
  p: {
    plain: null,
    shift: (a) => a.commandPalette,
  },
  // Only with Shift: plain Ctrl+A is select-all in every field and editor.
  a: {
    plain: null,
    shift: (a) => a.openApp,
  },
  b: {
    plain: (a) => a.togglePanel,
    shift: null,
  },
  "\\": {
    plain: (a) => a.splitTerminal,
    shift: null,
  },
  // `=`/`+` and `-`/`_` are each the same physical key on a US layout, and
  // which half arrives depends on Shift and on the layout. Both halves mean the
  // same zoom; nobody reaching for it is thinking about which.
  "=": {
    plain: (a) => a.zoomIn,
    shift: (a) => a.zoomIn,
  },
  "+": {
    plain: (a) => a.zoomIn,
    shift: (a) => a.zoomIn,
  },
  "-": {
    plain: (a) => a.zoomOut,
    shift: (a) => a.zoomOut,
  },
  _: {
    plain: (a) => a.zoomOut,
    shift: (a) => a.zoomOut,
  },
};

/** One Alt-modified binding. `code` is the physical key, not the character. */
export interface AltChord {
  code: string;
  ctrl: boolean;
  shift: boolean;
  run: ChordRun;
}

/**
 * The bindings that hold Alt, kept apart from `CHORDS` because not all of them
 * hold Ctrl — Shift+Alt+P is here because it is what Braden reached for first.
 *
 * Matched on `e.code` rather than `e.key`: with Alt held, `key` is whatever the
 * layout's Alt layer produces, which on several layouts is not the letter at
 * all. The modifiers are matched exactly, so Ctrl+Shift+Alt+P is neither.
 */
// Exported for `shortcuts.test.ts`, the same as `CHORDS`.
export const ALT_CHORDS: AltChord[] = [
  { code: "KeyP", ctrl: true, shift: false, run: (a) => a.switchProject },
  { code: "KeyP", ctrl: false, shift: true, run: (a) => a.switchProject },
];

/** The `ALT_CHORDS` row this event is, if any. Pure, for the test. */
export function altChordFor(
  e: Pick<KeyboardEvent, "code" | "altKey" | "ctrlKey" | "shiftKey" | "metaKey">,
): AltChord | null {
  if (!e.altKey || e.metaKey) return null;
  return (
    ALT_CHORDS.find(
      (row) => row.code === e.code && row.ctrl === e.ctrlKey && row.shift === e.shiftKey,
    ) ?? null
  );
}

/**
 * The menu-bar accelerators, in one table. `true` when the key was ours.
 *
 * Split out of the listener because it is a lookup rather than a decision: every
 * row is "this keystroke, that action", and the listener below still owns the
 * two things that *are* decisions — whether a field has focus, and which
 * bindings that suppresses.
 *
 * `preventDefault` on all of them, unconditionally, for the reason the Ctrl+1…9
 * case below already gives: the shell reaches an ordinary browser tab in
 * development, and several of these are bound there (Ctrl+N opens a window,
 * Ctrl+O a file picker, Ctrl+S saves the page, Ctrl+D bookmarks it, Ctrl+- and
 * Ctrl+= zoom the *browser*). Once a keystroke is matched, the shell owns it.
 *
 * `e.code` for the backquote pair rather than `e.key`, because `key` is what
 * the layout produces and a non-US keyboard does not put a backtick there.
 * `Backquote` is the physical key, which is what "the key under Escape" means
 * to everyone who reaches for it.
 */
function matched(e: KeyboardEvent, a: KeyboardActions): boolean {
  const shift = e.shiftKey;
  const key = e.key.toLowerCase();

  const fire = (run: () => void) => {
    e.preventDefault();
    run();
    return true;
  };

  if (e.code === "Backquote") return fire(shift ? a.newTerminal : a.toggleTerminal);

  const row = CHORDS[key];
  if (!row) return false;

  const bound = shift ? row.shift : row.plain;
  if (!bound) return false;

  return fire(bound(a));
}

/** True for `<input>`, `<textarea>`, and anything `contenteditable`. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function useKeyboard(actions: KeyboardActions): void {
  // The listener below is installed exactly once (empty deps). If it closed
  // over `actions` directly, every render that passed a new actions object
  // (a new inline `{ selectToolByIndex, rescan, cancelBoot }` from
  // `WindowRoot`, as is typical) would force the effect to tear down and
  // re-add the `document` listener. A ref sidesteps that: the effect that
  // keeps it current is cheap and runs every render, but the `keydown`
  // listener itself never moves, so there's no window where a keystroke can
  // land between a remove and an add.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const a = actionsRef.current;

      // F11 first: the one binding with no modifier, and the one Windows
      // convention strong enough that it is worth taking even from a field —
      // nothing anyone types into an <input> is F11.
      if (e.key === "F11" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        a.toggleFullscreen();
        return;
      }

      // Alt chords ahead of the primary-modifier gate, since Shift+Alt+P
      // holds no Ctrl. Ahead of the text-entry guard too: no Alt chord is
      // typing, and the dialog these open is itself mostly a text field.
      const alt = altChordFor(e);
      if (alt) {
        e.preventDefault();
        alt.run(a)();
        return;
      }

      // `hasPrimaryModifier` rather than a test written out here, so this and
      // SearchSlot's own Ctrl+K handler cannot drift apart about what the
      // primary modifier is. It is Ctrl, and only Ctrl — `accelerators.ts` has
      // the note on why the Windows key is not a second spelling of it.
      if (!hasPrimaryModifier(e)) return;

      // The menu-bar accelerators, before the text-entry guard below.
      //
      // The guard is there so a bare-ish keystroke does not get stolen out of
      // the search field, and every binding in this block is a command the user
      // could not possibly have meant as typing: Ctrl+S in a search box is
      // still Save. Ctrl+1…9, Ctrl+R and Ctrl+. stay behind the guard, because
      // those three are chips on an empty tool window and firing them from
      // inside a field the user is filling in would be a surprise.
      if (matched(e, a)) return;

      // Never steal a key while the user is typing — the search field in
      // particular is a real <input>, and "r" typed into it must stay "r".
      if (isTextEntryTarget(e.target)) return;

      if (e.key >= "1" && e.key <= "9") {
        // preventDefault: Ctrl+1…9 is bound by every major browser to
        // jump to a tab by position. The shell only runs inside a Tauri
        // webview in production, but in dev it's also reachable in an
        // ordinary browser tab (see the project's own warning against
        // `pnpm app` orphaning Vite on :1420) — so without this, the same
        // keystroke that should switch tools would instead switch the
        // browser's tab.
        e.preventDefault();
        actionsRef.current.selectToolByIndex(Number(e.key) - 1);
        return;
      }

      if (e.key.toLowerCase() === "r") {
        // preventDefault: required — Ctrl+R reloads the page, which
        // would restart the whole shell out from under itself.
        e.preventDefault();
        actionsRef.current.rescan();
        return;
      }

      if (e.key === ".") {
        // preventDefault: no browser binds Ctrl+. to anything, but the shell
        // is consuming the keystroke as a real command, so it is prevented for
        // the same reason the other two are — "once matched, the shell owns it",
        // not because anything else is competing for it.
        e.preventDefault();
        actionsRef.current.cancelBoot();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
