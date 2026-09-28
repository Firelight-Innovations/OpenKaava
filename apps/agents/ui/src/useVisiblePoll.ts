import { useEffect, useRef } from "react";

/**
 * Run `run` now and again `intervalMs` after each run finishes, only while the
 * document is visible. `docs/cloud-services.md` §8 asks for this: every poll
 * is a GCS list, and nobody needs one while the window is minimised. A hidden
 * document stops the loop; becoming visible runs it at once and restarts it.
 */
export function useVisiblePoll(run: () => Promise<void>, intervalMs: number): void {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  }, [run]);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    let inFlight = false;

    const tick = async (): Promise<void> => {
      window.clearTimeout(timer);
      if (cancelled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        await latest.current();
      } finally {
        inFlight = false;
      }
      if (!cancelled && document.visibilityState === "visible") {
        timer = window.setTimeout(() => void tick(), intervalMs);
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void tick();
    };

    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
}
