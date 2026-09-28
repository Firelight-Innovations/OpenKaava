/**
 * The frontend half of the shared shell state.
 *
 * Mirrors `src-tauri/src/shell_state.rs`. Placement and terminal sessions are
 * owned by the backend because more than one window has to agree on them; this
 * is how a window subscribes to that agreement.
 *
 * Deliberately not a store. Every window is a projection of one broadcast
 * object, so there is nothing to reconcile and nothing to merge — the last
 * `shell:state` event is the truth, and `useShellState` re-renders with it.
 *
 * The types and the raw `invoke`/`listen` calls both live in `bindings.ts`
 * now (STANDARDS.md §1.1) — re-exported below so nothing that already imports
 * them from here has to change. What stays local is the one hook and the two
 * helpers that add real behaviour on top: subscribe-then-fetch ordering, and
 * reading this window's own label out of its URL.
 */
import { useEffect, useState } from "react";
import { onShellStateChanged, shellState, type ShellSnapshot } from "../../bindings";

export type {
  PageMode,
  RightPage,
  ShellSnapshot,
  TerminalSessionState,
  WindowGeometry,
  WindowPlacement,
} from "../../bindings";
export {
  activateInstance,
  addCluster,
  closeCluster,
  closeInstance,
  closePage,
  closeWindow,
  detachCluster,
  detachInstance,
  moveInstance,
  moveTerminal,
  newWindow,
  openInstance,
  openPage,
  renameCluster,
  setActiveCluster,
  setActiveTerminal,
  setBandHeight,
  setInstanceTitle,
  setPageMode,
  setPageWidth,
  setPaneSizes,
  setWindowGeometry,
  splitPane,
  windowAtCursor,
} from "../../bindings";

/**
 * Subscribe to the shared state.
 *
 * Subscribe first, then fetch — the same ordering the splash window uses for
 * `boot:status`, and for the same reason. Tauri events have no replay buffer,
 * so a window that fetched first would miss anything broadcast between the
 * fetch returning and the listener being registered. Doing it this way the
 * only risk is the opposite one, a stale fetch landing after a fresh event,
 * which the `settled` flag below discards.
 */
export function useShellState(): ShellSnapshot | null {
  const [snapshot, setSnapshot] = useState<ShellSnapshot | null>(null);

  useEffect(() => {
    let live = true;
    let settled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      unlisten = await onShellStateChanged((next) => {
        if (!live) return;
        settled = true;
        setSnapshot(next);
      });

      const initial = await shellState();
      // An event already arrived while that round-trip was in flight, and it is
      // newer than what we just asked for. Dropping this is the whole point of
      // the flag.
      if (live && !settled) setSnapshot(initial);
    })();

    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  return snapshot;
}

/**
 * One-shot read of the shared state, for a caller with no component to hang
 * `useShellState`'s subscription on.
 *
 * `search/openHit.ts` is the reason this exists: resolving where a search
 * hit's Enter keystroke should open into happens outside any render, so there
 * is no hook to call and no subscription worth keeping open for a single
 * answer. Every other reader of this state is a component and should still
 * prefer `useShellState` — polling on every keystroke would be the wrong
 * answer for a screen that is already told the moment something changes.
 */
export function fetchShellState(): Promise<ShellSnapshot> {
  return shellState();
}

/** This window's own label, from the URL it was opened with. */
export function windowLabel(): string {
  return new URLSearchParams(window.location.search).get("window") ?? "main";
}
