import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { onThemeChange } from "../themeBroadcast";
import type { TerminalTransport } from "../contract";
import { useDropZone } from "../dropZones";
import { attachClipboard } from "./clipboard";
import { requestHarnessRefresh } from "../harnessRefresh";
import { createFitController } from "./fitController";
import { isResizing, subscribeResizing } from "../resizeGate";
import { pasteImage } from "../contextInput";
// Imported here, not from a global entry, so nothing pays for xterm's CSS
// until a terminal actually mounts — the tool window and every other region
// stay ignorant of this parcel's existence.
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

/**
 * One session, one emulator.
 *
 * The `Terminal` instance is created exactly once per mounted instance and
 * disposed on unmount — never recreated on a prop change. `TerminalDeck`
 * guarantees that by keying each instance on the session id, so `id` and
 * `transport` are effectively constant for this component's lifetime; they
 * are still listed as effect deps (rather than read from a ref) because the
 * correct behaviour if either ever did change is to re-wire the transport,
 * not to silently keep talking to the old one.
 *
 * `onTitle` and `onFocus` do not get the same treatment; see the refs holding
 * them below.
 */
export interface XTermHandle {
  /**
   * Clears the emulator's own screen. Sends nothing to the pty — see the
   * comment on `TerminalDeck`'s `clear` for why that distinction matters.
   *
   * The one imperative method `ref` exposes, because split's "clear the active
   * pane" is the one action here that has to reach into a *specific* mounted
   * instance from outside: `SecondaryPanel`'s action bar isn't a parent of this
   * component, `TerminalDeck` is, so `TerminalDeck` forwards a ref map and this
   * is what each entry in it points at.
   */
  clear: () => void;
}

function XTermView(
  {
    id,
    transport,
    onTitle,
    onFocus,
    fileDropActive = false,
  }: {
    id: string;
    transport: TerminalTransport;
    /** Called with whatever the running program set its title to, via an
     *  OSC escape sequence. Optional — a caller that has no use for the
     *  title (there is none today) just omits it. */
    onTitle?: (title: string) => void;
    /** Called when this instance's own textarea takes focus — a click, or
     *  Tab landing on it. Optional; only a split pane's caller needs to
     *  track which one is focused. */
    onFocus?: () => void;
    /** Files are being dragged over *this* emulator right now. Drawn as an
     *  inset outline; see `.terminal__view[data-file-drop]`.
     *
     *  Handed in rather than read from the drag layer here, matching how
     *  `BottomPanel` takes its own `dropActive` and for the same reason: this
     *  component registers where it is (below) but has no business knowing what
     *  is in the air. Which emulator the drag is over is one answer for the
     *  whole window, and `WindowRoot` is where it is held. */
    fileDropActive?: boolean;
  },
  ref: React.ForwardedRef<XTermHandle>,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Read from refs rather than listed as effect deps. `TerminalDeck` binds both
  // fresh per session on every render — `onTitle` has to, the callback needs to
  // know which session's title changed, and `onFocus` follows the same shape for
  // the pane it marks focused — so each has a new identity most of the times
  // this component re-renders. Listing either as a dep would tear down and
  // recreate the `Terminal` instance on nearly every render of whatever's above
  // this in the tree, which is exactly the churn the header says must not
  // happen. This way the effect always calls whatever the latest callback is,
  // without its identity ever being a reason to re-run the effect.
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  useImperativeHandle(ref, () => ({ clear: () => termRef.current?.clear() }), []);

  // Every emulator is a file-drop target, wherever it is drawn — the band or a
  // pane. Registered here rather than by the two callers because there is one
  // rule ("files land in the terminal you point at") and this is the one
  // component both routes go through; the alternative was the same
  // registration written twice in `WindowRoot`, which is how the two would come
  // to disagree. Ordinary drags do not see this zone at all — `dropZones.ts`
  // has why.
  const dropZoneRef = useDropZone({ kind: "terminal", sessionId: id });

  // One element, two refs. The effect below measures and mounts xterm into it;
  // the registry needs the same node to hit-test against. `useCallback` with
  // both refs as deps rather than an inline arrow, because an unstable ref
  // callback makes React detach and reattach every render — which for the
  // registry means deregistering the zone continuously, and a drag sampling it
  // mid-render would find nothing there.
  const setContainer = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      dropZoneRef(el);
    },
    [dropZoneRef],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      // A coding harness's own scrollback is not this: this is the emulator's
      // buffer of everything that has scrolled off, for the user's own
      // scrollback (mouse wheel / search-to-come). Sized generously since a
      // long-running agent can produce a lot of output between glances.
      scrollback: 10000,
      fontFamily: readToken("--mono"),
      // The panel's terminal output has always rendered at 11.5px
      // (src/shell/panel/panel.css `.panel__terminal`) — matched here so a
      // real PTY's output sits at the same size the fake transcript did.
      fontSize: 11.5,
      theme: buildTheme(),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // A webview without a GPU context must degrade, not crash: `WebglAddon`
    // throws synchronously out of `activate()` (called by `loadAddon`) when
    // it can't get a WebGL2 context, so the fallback is a plain try/catch
    // rather than a feature check — xterm's canvas renderer is already
    // loaded and keeps working untouched.
    try {
      const webgl = new WebglAddon();
      // The context can also be lost after the fact (GPU reset, driver
      // update); disposing on loss drops back to the canvas renderer instead
      // of leaving the terminal blank.
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL2 context available in this webview — the canvas renderer
      // xterm already loaded stays in place.
    }

    term.open(container);
    termRef.current = term;
    // xterm paints to a canvas and cannot read CSS variables, so a light/dark
    // switch has to hand it a fresh palette resolved from the new tokens.
    const offTheme = onThemeChange(() => {
      term.options.theme = buildTheme();
    });

    const detach = transport.attach(id, (chunk) => term.write(chunk));
    const onData = term.onData((data) => transport.write(id, data));
    // Backed by xterm's own OSC parser — see `ShellState::set_terminal_title`
    // in the Rust module for why the parsing happens here rather than in the
    // pty layer: xterm already copes with a title sequence split across two
    // reads, which a from-scratch Rust parser would have to redo.
    // Claude Code and the other harnesses set the title when they start, so a
    // title change is a cheap hint that detection's answer may have changed.
    const onTitleChange = term.onTitleChange((title) => {
      requestHarnessRefresh(id);
      onTitleRef.current?.(title);
    });
    // xterm has no `onFocus` event of its own — focus lands on the hidden
    // `<textarea>` it types into (`term.textarea`), which only exists once
    // `open()` has run, so this is wired here rather than declared up front
    // with the other `on*` handlers.
    const onTextareaFocus = () => {
      requestHarnessRefresh(id);
      onFocusRef.current?.();
    };
    term.textarea?.addEventListener("focus", onTextareaFocus);

    // Ctrl+V, and what a right-click may and may not do. Wired after `open()`
    // because both halves need the textarea that call creates, and kept in
    // `clipboard.ts` because the policy is testable and this file is not.
    // An image on the clipboard is stored and referenced rather than dropped on
    // the floor, which is what `Ctrl+V` did with one before.
    const detachClipboard = attachClipboard(term, container, (image) => {
      void pasteImage(id, image);
    });

    // Fits are driven by a `ResizeObserver` on the container, not `window`'s
    // resize event — the panel is resized by a drag handle and by collapse,
    // neither of which touches the window. The policy — no fit during a
    // splitter drag, one fit on release, debounced otherwise — is
    // `fitController.ts`; this only supplies the measurements.
    const controller = createFitController({
      isResizing,
      subscribeResizing,
      measure: () => container.getBoundingClientRect(),
      propose: () => fitAddon.proposeDimensions(),
      fit: () => fitAddon.fit(),
      resize: (cols, rows) => transport.resize(id, cols, rows),
    });
    // A hidden terminal (the deck sets `display: none` on the inactive ones)
    // measures 0x0 by this element's own rect, and the controller skips it. It
    // is not measured with `FitAddon.proposeDimensions()`, which reads its
    // parent's computed width through `parseInt`: under `display: none` that
    // is the string "100%", which parses to a small finite 100 and sails past
    // a `cols <= 0` guard. The observer fires again on the 0 to real
    // transition, which is what re-establishes the size on a tab switch.
    const observer = new ResizeObserver(controller.notify);
    observer.observe(container);
    controller.notify(); // the container already has its first-paint size by now.

    return () => {
      observer.disconnect();
      controller.dispose();
      onData.dispose();
      onTitleChange.dispose();
      detachClipboard();
      term.textarea?.removeEventListener("focus", onTextareaFocus);
      detach();
      offTheme();
      termRef.current = null;
      term.dispose();
    };
  }, [id, transport]);

  return (
    <div
      ref={setContainer}
      className="terminal__view"
      data-file-drop={fileDropActive || undefined}
    />
  );
}

export default forwardRef(XTermView);

/** Reads a design token's literal value. Canvas-backed renderers (xterm's
 *  default, and WebGL's) need a real colour or font string — `var(--x)`
 *  isn't something either can consume — so every token this component needs
 *  is resolved once, here, rather than passed through as CSS. */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * xterm theme, built entirely from `src/tokens.css` — no hex value here that
 * isn't already named there.
 *
 * The token table has no discrete blue, magenta, or cyan (the handoff never
 * draws them), so those three ANSI slots and their bright variants are left
 * unset rather than invented: xterm's own built-in defaults fill them. Red,
 * green, and yellow have no separate "bright" shade in the token set either,
 * so the bright variant reuses the base token — a narrower palette than a
 * full 16-colour scheme, but not a fabricated one.
 */
export function buildTheme(): ITheme {
  const bg = readToken("--surface"); // the panel's own background — the deck
  // renders inside the panel body, which sets no background of its own.
  const text = readToken("--text");
  const textDim = readToken("--text-dim");
  const ok = readToken("--ok");
  const warn = readToken("--warn");
  const err = readToken("--err");

  return {
    background: bg,
    foreground: text,
    cursor: textDim,
    cursorAccent: bg,
    selectionBackground: readToken("--accent-wash"),

    black: readToken("--line-2"),
    red: err,
    green: ok,
    yellow: warn,
    white: textDim,

    brightBlack: readToken("--text-dim-3"),
    brightRed: err,
    brightGreen: ok,
    brightYellow: warn,
    brightWhite: text,
  };
}
