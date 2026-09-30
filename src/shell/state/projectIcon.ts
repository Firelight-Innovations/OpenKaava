/**
 * A project's custom icon, for every place the shell draws a project tile.
 *
 * Keyed on the project's **path**, not a cluster: the Switch project dialog
 * draws projects no cluster has open. The answer is a `data:` URL or `null`,
 * and `null` means "draw the letter tile" for every reason it can be null (no
 * icon, not read yet, a failed read). A tile has no room to say which.
 *
 * `project:icon` keeps it live: choosing an icon from one window redraws the
 * pill and the dialog rows in every window, without anyone asking again.
 */
import { useEffect, useState } from "react";
import { onProjectIconChanged, projectIcon } from "../../bindings";

export function useProjectIcon(path: string | null): string | null {
  const [icon, setIcon] = useState<string | null>(null);

  useEffect(() => {
    setIcon(null);
    if (path === null) return;

    let live = true;
    let unlisten: (() => void) | undefined;

    void projectIcon(path)
      .then((found) => {
        if (live) setIcon(found);
      })
      .catch(() => {
        // The letter tile, which is what `null` already draws.
      });

    // The same background-subscribe shape `useClusterProject` uses, for its
    // reason: a cleanup has to return synchronously and `listen` does not.
    void (async () => {
      const stop = await onProjectIconChanged((payload) => {
        if (live && samePath(payload.path, path)) setIcon(payload.icon);
      });
      if (!live) return stop();
      unlisten = stop;
    })();

    return () => {
      live = false;
      unlisten?.();
    };
  }, [path]);

  return icon;
}

/** Windows paths, compared the way Windows does: case and slash direction
 *  do not matter, so `C:/Game` and `c:\game` are one project. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
