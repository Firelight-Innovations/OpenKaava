/**
 * The terminal's clipboard, owned here rather than left to xterm — whose own
 * behaviour is wrong for a Windows terminal in both directions at once, which is
 * what issue #50 reported as two bugs. The account of both, and of what was
 * considered and rejected, is in `docs/design-notes/terminal-clipboard.md`.
 */
import type { Terminal } from "@xterm/xterm";

/** The parts of xterm's `Terminal` this module touches. A real `Terminal` satisfies
 *  it; so does a plain object in a test, which is the point — `vitest.config.ts`
 *  runs on `node` with no DOM. */
export interface ClipboardTerminal {
  /** Hand text to the emulator as a paste: xterm normalises the line endings, adds
   *  the bracketed-paste markers when the running program asked for them, and emits
   *  the one data event that reaches the pty. */
  paste(data: string): void;
  /** Whatever is selected on screen right now, `""` when nothing is. */
  getSelection(): string;
  /** xterm's off-screen `<textarea>`. `undefined` until `open()` has run. */
  readonly textarea: { value: string } | undefined;
}

/** The parts of a `KeyboardEvent` the gesture table reads. */
export interface KeyGesture {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** A file on the clipboard, as much of `File` as this module reads. */
export interface PastedFile {
  readonly type: string;
  readonly name?: string;
}

/** The parts of a `ClipboardEvent` `handlePaste` reads and answers. */
export interface PasteGesture {
  readonly clipboardData: {
    getData(format: string): string;
    /** Absent on a bare fake, which is a clipboard with no files. */
    readonly files?: ArrayLike<PastedFile>;
  } | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Is this the paste gesture? `Ctrl+V` and `Ctrl+Shift+V` both are, because a
 *  Windows terminal conventionally takes either. `Alt` disqualifies the combo
 *  deliberately: `Ctrl+Alt` *is* `AltGr` on most non-US layouts, where `AltGr+V`
 *  is a character somebody means to type. */
export function isPasteKey(ev: KeyGesture): boolean {
  if (!ev.ctrlKey || ev.altKey || ev.metaKey) return false;
  return ev.key === "v" || ev.key === "V";
}

/** Ctrl+Tab and Ctrl+Shift+Tab — the shell's next/previous-cluster chords. xterm
 *  would otherwise type a Tab into the pty and cancel the event, so the shell's
 *  document listener would never see it. */
export function isClusterCycleKey(ev: KeyGesture): boolean {
  return ev.key === "Tab" && ev.ctrlKey && !ev.altKey && !ev.metaKey;
}

/** The handler for xterm's `attachCustomKeyEventHandler`. `false` means "not yours"
 *  — xterm returns without emitting anything **and without cancelling the event**,
 *  so the webview runs its own paste and `handlePaste` below turns that into one
 *  write to the pty. Reading the clipboard here was rejected; see the design note.
 *  The cluster-cycle chords are declined the same way, so they bubble to the shell. */
export function handleKey(ev: KeyGesture): boolean {
  return !isPasteKey(ev) && !isClusterCycleKey(ev);
}

/** The first image among a clipboard's files, or `undefined`. */
export function firstImage<T extends PastedFile>(files: ArrayLike<T> | undefined): T | undefined {
  if (!files) return undefined;
  for (let i = 0; i < files.length; i++) {
    if (files[i].type.startsWith("image/")) return files[i];
  }
  return undefined;
}

/** A paste arriving at the terminal, from `Ctrl+V` or from the native menu.
 *  `stopPropagation` keeps xterm's own handler from sending the text a second time;
 *  `preventDefault` stops the browser depositing it in the hidden textarea, which is
 *  the residue that made a later right-click paste it again. An empty or absent
 *  clipboard is left alone rather than swallowed.
 *
 *  **Text always wins.** A copied spreadsheet range carries a bitmap as well as its
 *  text, and the text is what was meant. Only a clipboard with *no* text and an image
 *  file goes to `onImage` — which is what makes `Ctrl+V` work for a screenshot, where
 *  it used to send nothing at all. */
export function handlePaste(
  term: ClipboardTerminal,
  ev: PasteGesture,
  onImage?: (image: PastedFile) => void,
): void {
  const text = ev.clipboardData?.getData("text/plain") ?? "";
  if (!text) {
    const image = onImage ? firstImage(ev.clipboardData?.files) : undefined;
    if (image && onImage) {
      ev.stopPropagation();
      ev.preventDefault();
      onImage(image);
    }
    return;
  }

  ev.stopPropagation();
  ev.preventDefault();
  term.paste(text);

  // xterm's `paste()` already blanks the textarea. Asserted rather than assumed
  // of a dependency, because it is the invariant the second bug turned on.
  const textarea = term.textarea;
  if (textarea) textarea.value = "";
}

/**
 * A right-click on the terminal. **It writes nothing to the pty** — that is the
 * whole rule, and `clipboard.test.ts` pins it.
 *
 * It runs after xterm's own `contextmenu` handler, and adds the invariant that
 * handler is missing: after a right-click the textarea holds the terminal's
 * selection and nothing else. Why none of xterm's part is removed: design note.
 */
export function handleContextMenu(term: ClipboardTerminal): void {
  const textarea = term.textarea;
  if (!textarea) return;

  const selection = term.getSelection();
  if (textarea.value !== selection) textarea.value = selection;
}

/**
 * Wire the three above to one mounted emulator; the returned function unwires
 * the two DOM listeners. `paste` is captured on the container so it is reached
 * before xterm's listeners and `stopPropagation` can suppress them; `contextmenu`
 * bubbles for the mirror-image reason, since it has to run after xterm's.
 *
 * The key handler has no removal because xterm exposes none, and needs none:
 * `XTermView` disposes the `Terminal` on unmount and the handler goes with it.
 */
export function attachClipboard(
  term: Terminal,
  container: HTMLElement,
  onImage?: (image: File) => void,
): () => void {
  const onPaste = (ev: ClipboardEvent) => handlePaste(term, ev, onImage as (f: PastedFile) => void);
  const onContextMenu = () => handleContextMenu(term);

  term.attachCustomKeyEventHandler(handleKey);
  container.addEventListener("paste", onPaste, true);
  container.addEventListener("contextmenu", onContextMenu);

  return () => {
    container.removeEventListener("paste", onPaste, true);
    container.removeEventListener("contextmenu", onContextMenu);
  };
}
