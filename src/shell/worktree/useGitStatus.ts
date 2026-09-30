/**
 * One git status, fetched once, read by two regions.
 *
 * This sits in `WindowRoot` rather than inside `SourceControlView` for the
 * reason the old `stubWorktreeSource` wiring gave: the status bar and the
 * source-control tab both name the checked-out branch, and two independent
 * fetches would be two chances to disagree about it. It also outlives the tab
 * — the rail's Git page only mounts its views while the page is open, so a
 * hook owned by the view would take the status bar's branch away every time
 * the page closed.
 *
 * There is no watcher behind `GitControl`, so nothing here can push. `refresh`
 * is what the panel calls after every mutation. A change of `clusterId` re-asks,
 * and so does a change of `root`: a cluster repointed at another project keeps
 * its id, and keying on the id alone left Source Control describing the old
 * repository until a reload.
 */
import { useCallback, useEffect, useState } from "react";
import type { GitControl, GitStatus } from "../contract";

export interface GitStatusHandle {
  /** `null` for "no cluster", "not a repo", or "the last fetch failed". */
  status: GitStatus | null;
  /** True while a fetch is outstanding — the empty state waits for this so it
   *  doesn't flash between a cluster being chosen and its status arriving. */
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Keyed on the **cluster**, not on the focused app. It was the latter until the
 * status bar and the source-control view were found to be showing nothing at
 * all: `activeAppId` is `null` for any focused terminal, and even a non-null
 * app id resolved through a tool list that is empty for every project (see the
 * scope note in `SourceControlView.tsx`). A cluster is also the honest subject
 * — "which branch am I on" is a property of what you are working on, not of
 * which pane happens to have focus.
 */
export function useGitStatus(
  control: GitControl,
  clusterId: string | null,
  /** Where the cluster is pointed: its worktree, else its project. Only
   *  compared, never read, so any string that changes with it will do. */
  root: string | null = null,
): GitStatusHandle {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(clusterId !== null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (clusterId === null) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Guards against the answer to a superseded question landing last: switch
    // clusters twice quickly and the first request can still resolve after the
    // second, which would leave the panel showing the wrong repo.
    let live = true;
    setLoading(true);

    control.status(clusterId).then(
      (next) => {
        if (!live) return;
        setStatus(next);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!live) return;
        setStatus(null);
        setError(gitMessage(reason));
        setLoading(false);
      },
    );

    return () => {
      live = false;
    };
  }, [control, clusterId, root, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { status, loading, error, refresh };
}

/**
 * What a rejected `GitControl` call is carrying.
 *
 * Tauri serialises `AppError` across the bridge, so a rejection here is
 * usually already the `Display` string ("git commit failed: nothing to
 * commit…") rather than an `Error`. Both shapes are handled because only one
 * of them survives the boundary and the other is what a genuine frontend bug
 * would throw.
 */
export function gitMessage(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
