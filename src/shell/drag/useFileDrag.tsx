/**
 * Files dragged onto a terminal, from either place they can come from.
 *
 * The other drag. `useDrag` is a pointer gesture watched from press to release,
 * moving things the shell already owns; this one carries paths, and neither
 * source of it looks like a `pointerdown` the shell saw. What they share is the
 * part worth sharing: both ask `dropZones.ts` where a release lands.
 *
 * Two sources, one commit. **The operating system's** arrives through Tauri
 * already in flight, carrying paths and a position, with Explorer drawing its
 * own cursor. **An app frame's** — the Files tree — is a pointer gesture inside
 * an iframe the shell cannot see into; the frame says it has begun and the
 * shell takes over on `window`. The full argument, including why neither half
 * of that is redundant: `docs/design-notes/drag-files-to-terminal.md`.
 *
 * Adapted from `handleInternalTerminalFileDrop` in Orca's
 * `src/renderer/src/components/terminal-pane/terminal-drop-handler.ts` (MIT,
 * (c) Lovecast Inc.; see THIRD-PARTY-NOTICES). None of the code is — Orca reads
 * a `DataTransfer`, which a Tauri webview never hands you.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMotionValue, useSpring } from "framer-motion";
import { onFileDrag } from "../../bindings";
import { terminalAt } from "../dropZones";
import { windowLabel } from "../state/shellState";
import { toolWindowBridge, type OsFileDragMessage } from "../toolWindowRegistry";
import { terminalTransport } from "../state/terminals";
import { ghostSpring } from "./ghostSpring";
import FileGhost from "./FileGhost";
import "./drag.css";

/** What `useFileDrag` hands `WindowRoot`. */
export interface FileDragLayer {
  /** The session under the cursor, or `null`. What an affordance draws from. */
  targetId: string | null;
  /** An app frame has begun dragging these paths. See `useFrameFileDrag`. */
  begin: (paths: string[]) => void;
  /** That frame's own release, for the drags the shell never sees end. */
  end: () => void;
  /** The chip that follows the cursor, for `FrameSlots.overlay`. `null` unless
   *  a frame drag is in the air — an operating-system drag has Explorer's own
   *  cursor on it already, and a second chip beside it would be two answers to
   *  "what am I carrying". */
  overlay: React.ReactNode;
}

export function useFileDrag(): FileDragLayer {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [frameDrag, setFrameDrag] = useState<string[] | null>(null);

  // Written raw per move and chased by a spring rather than routed through
  // React state, for the reason `useDrag` gives at its own pair: the ghost has
  // to read as attached to the cursor, and a re-render per frame cannot promise
  // that. `targetId` is React state and can be, because it changes only when
  // the cursor crosses into or out of an emulator.
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const ghostX = useSpring(rawX, ghostSpring);
  const ghostY = useSpring(rawY, ghostSpring);

  useOsFileDrag(setTargetId);

  const { begin, end } = useFrameFileDrag({ setTargetId, setFrameDrag, rawX, rawY });

  const overlay = useMemo(
    () =>
      frameDrag ? (
        <div className="drag-overlay">
          <FileGhost paths={frameDrag} x={ghostX} y={ghostY} />
        </div>
      ) : null,
    [frameDrag, ghostX, ghostY],
  );

  return { targetId, begin, end, overlay };
}

/**
 * The operating system's drag, reported by the webview through Tauri.
 *
 * Nothing to track: every event carries its own position, so this is a
 * subscription and a hit test and no gesture state at all.
 */
function useOsFileDrag(setTargetId: (id: string | null) => void): void {
  useEffect(() => {
    let live = true;
    let stop: (() => void) | null = null;

    void (async () => {
      const unlisten = await onFileDrag((drag) => {
        if (!live) return;
        if (drag.kind === "leave") {
          setTargetId(null);
          return routeToFiles({ phase: "leave" });
        }
        if (drag.kind === "over") {
          const terminal = terminalAt(drag.x, drag.y);
          setTargetId(terminal);
          // Over a terminal the terminal's own affordance is the answer; anywhere else the
          // File Explorer under the cursor, if there is one, shows where the drop would land.
          return routeToFiles(
            terminal ? { phase: "leave" } : { phase: "over", x: drag.x, y: drag.y },
          );
        }

        setTargetId(null);
        if (terminalAt(drag.x, drag.y)) {
          routeToFiles({ phase: "leave" });
          return commit(drag.x, drag.y, drag.paths);
        }
        // Not a terminal: a File Explorer frame under the cursor takes the drop, which
        // copies the paths into the folder it landed on. Over nothing, nothing happens.
        const taken = routeToFiles({ phase: "drop", x: drag.x, y: drag.y, paths: drag.paths });
        if (!taken) commit(drag.x, drag.y, drag.paths);
      });

      if (!live) return unlisten();
      stop = unlisten;
    })();

    return () => {
      live = false;
      stop?.();
    };
  }, [setTargetId]);
}

/** Pass an OS drag to the Files frame under the cursor. `false` when none is there. */
function routeToFiles(message: OsFileDragMessage): boolean {
  return toolWindowBridge(windowLabel())?.routeOsFileDrag(message) ?? false;
}

/**
 * A drag that began inside an app frame, and is tracked out here.
 *
 * An iframe's pointer events do not reach this document, and this document's do
 * not reach the iframe: whichever one the cursor is over gets them, and only
 * that one. So the two halves each cover what the other is blind to, and both
 * are needed.
 *
 * The frame says **`begin`** once its press clears a threshold, and **`end`**
 * on its own release — the one release the shell never sees, because letting go
 * over the frame sends `pointerup` to the frame. Which of the two acts, and why
 * a real drop always wins the race: `docs/design-notes/drag-files-to-terminal.md`.
 */
function useFrameFileDrag({
  setTargetId,
  setFrameDrag,
  rawX,
  rawY,
}: {
  setTargetId: (id: string | null) => void;
  setFrameDrag: (paths: string[] | null) => void;
  rawX: { set: (v: number) => void; jump: (v: number) => void };
  rawY: { set: (v: number) => void; jump: (v: number) => void };
}): { begin: (paths: string[]) => void; end: () => void } {
  const paths = useRef<string[] | null>(null);
  // How this gesture takes its listeners down. Held rather than recreated, so
  // `finish` can remove exactly the functions `begin` added.
  const detach = useRef<(() => void) | null>(null);

  const finish = useCallback(() => {
    paths.current = null;
    detach.current?.();
    detach.current = null;
    setFrameDrag(null);
    setTargetId(null);
  }, [setFrameDrag, setTargetId]);

  const begin = useCallback(
    (started: string[]) => {
      if (started.length === 0) return;
      // A second `begin` without an `end` should not leave the first one's
      // listeners behind. Cheap, and the only ordering this cannot control:
      // the frame is a separate document and its messages are tasks.
      finish();
      paths.current = started;
      setFrameDrag(started);

      // Attached here rather than for the hook's whole life. A `pointermove`
      // handler on `window` fires for every pixel the cursor travels anywhere
      // in the app, and this one has something to do for the seconds a drag is
      // in the air — so it exists for exactly those seconds, as `useDrag`'s do.
      let seeded = false;

      const onMove = (e: PointerEvent) => {
        // Seeded on the first move out here, so the ghost springs from where
        // the cursor left the frame rather than flying in from the origin. The
        // press happened in a document this one never heard from, so there is
        // no earlier position to seed from.
        if (!seeded) {
          seeded = true;
          rawX.jump(e.clientX);
          rawY.jump(e.clientY);
        }
        rawX.set(e.clientX);
        rawY.set(e.clientY);
        setTargetId(terminalAt(e.clientX, e.clientY));
      };

      const onUp = (e: PointerEvent) => {
        const carried = paths.current;
        finish();
        if (carried) commit(e.clientX, e.clientY, carried);
      };

      // A cancel is not a release and commits nothing — the distinction
      // `useDrag` draws, for its reason: it carries the position of whatever
      // took the gesture away, not the position the user meant.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", finish);
      detach.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", finish);
      };
    },
    [finish, setFrameDrag, setTargetId, rawX, rawY],
  );

  // A window closing mid-drag takes its listeners with it.
  useEffect(() => () => detach.current?.(), []);

  return { begin, end: finish };
}

/**
 * A release. The target is hit-tested from the release's own coordinates rather
 * than reused from the last move: for the operating system's drag the two are
 * separate events and a flicked drag produces a `drop` no `over` reported, and
 * for a frame's the same call answering both keeps one rule in one place.
 */
function commit(x: number, y: number, paths: string[]): void {
  const id = terminalAt(x, y);
  if (!id) {
    // Over the window, over no terminal. Nothing is the right answer — a path
    // means nothing to a pane showing Files, and "the focused terminal" would
    // put text where the user was not pointing. Logged at `debug` because
    // declining is correct and a decline is otherwise indistinguishable from a
    // failure; see `useDrag`'s `commitCluster`, which says the same.
    console.debug(`kaava: ${paths.length} file(s) dropped over no terminal`);
    return;
  }
  if (paths.length > 0) terminalTransport.insertPaths(id, paths);
}
