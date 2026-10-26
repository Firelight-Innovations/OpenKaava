/**
 * The frontend half of the updater.
 *
 * Mirrors `src-tauri/src/updater.rs`, which owns the check, the download and
 * the installer. Nothing here touches the network — it subscribes to a state
 * Rust publishes and sends two verbs back, which is the whole of a region's job
 * per STANDARDS.md §1.
 *
 * It subscribes before it fetches, for the reason `useLayoutPresets` gives: the
 * launch check can settle while the mount's round trip is in flight, and the
 * event is the newer of the two answers.
 */
import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, installUpdate, onUpdateChanged, updateState } from "../../bindings";
import type { UpdateState } from "../../bindings";

/** What `useUpdates` hands back. */
export interface Updates {
  state: UpdateState;
  /**
   * Whether anybody in this window has *asked*. Latched on the first manual
   * check and never cleared: having asked once, you are owed the answer, and a
   * bar that went quiet again while the request was still running would be
   * worse than one that never spoke.
   */
  asked: boolean;
  /** Ask now. What the Help menu's item calls. */
  check: () => void;
  /** Take the standing offer. Never resolves — the installer ends the process. */
  install: () => void;
}

export function useUpdates(): Updates {
  const [state, setState] = useState<UpdateState>({ state: "idle" });
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let live = true;
    let settled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      unlisten = await onUpdateChanged((next) => {
        if (!live) return;
        settled = true;
        setState(next);
      });

      try {
        const initial = await updateState();
        // The launch check landed while that round trip was in flight, and its
        // answer is the newer one. Dropping this is the whole point of the flag.
        if (live && !settled) setState(initial);
      } catch (err: unknown) {
        // Reaching here means the *command* failed, not the check — Rust turns
        // a failed check into a `failed` state rather than an error. A shell
        // running outside Tauri is the ordinary case, and it has no updater to
        // report on, so this stays a console line rather than a state.
        console.error("veistra: could not read the update state:", err);
      }
    })();

    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  const check = useCallback(() => {
    setAsked(true);
    // The resolved value is the same state the event already carried, so it is
    // dropped rather than applied — one writer keeps the two windows level.
    void checkForUpdate().catch((err: unknown) => {
      console.error("veistra: could not check for an update:", err);
    });
  }, []);

  const install = useCallback(() => {
    setAsked(true);
    void installUpdate().catch((err: unknown) => {
      // Rust has already published a `failed` state carrying the sentence to
      // show, so there is nothing for this to render. It logs so a rejection
      // that never became a state is still visible somewhere.
      console.error("veistra: could not install the update:", err);
    });
  }, []);

  return { state, asked, check, install };
}
