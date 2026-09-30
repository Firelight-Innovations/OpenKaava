/**
 * Whether this window is maximised, kept current by the window's own resize
 * event rather than by polling. A maximise, a restore and a snap all resize the
 * window, so one listener covers them; the state is re-read from the window on
 * each event because the size alone does not say which it was.
 */
import { useEffect, useState } from "react";
import { hostWindowIsMaximized, onHostWindowResized } from "../../bindings";
import { isTauri } from "../hostWindow";

export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | null = null;

    const refresh = () => {
      hostWindowIsMaximized()
        .then((m) => {
          if (alive) setMaximized(m);
        })
        .catch(() => {
          // No window to ask: keep whatever was last known.
        });
    };

    refresh();
    onHostWindowResized(refresh)
      .then((off) => {
        if (alive) unlisten = off;
        else off();
      })
      .catch(() => {
        // Listening is best-effort; the icon just stops tracking.
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return maximized;
}
