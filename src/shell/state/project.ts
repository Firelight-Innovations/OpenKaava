/**
 * Which project a cluster is working on, for the shell itself.
 *
 * **Per cluster.** Two windows on two monitors are meant to name two different
 * projects at once, so this takes a cluster id rather than reading an ambient
 * value. There is no watcher: a project renamed on disk keeps its old name in
 * the bar until something opens it again, the same staleness `ProjectInfo.name`
 * has everywhere else. Why the shell subscribes at all, and why the initial read
 * goes through `clusterProject` rather than Home's `home/state`, is in
 * docs/design-notes/shell-state.md.
 */
import { useEffect, useState } from "react";
import { clusterProject, onProjectChanged } from "../../bindings";

/** The part of Rust's `ProjectInfo` anything in the shell reads. */
export interface OpenProject {
  name: string;
  path: string;
}

/**
 * The project `clusterId` is pointed at. `null` for "no project", "no cluster"
 * and "not answered yet" alike — the bar draws the same thing for all three.
 *
 * Re-fetched when the cluster changes, since switching chips changes the answer
 * with no event firing; the subscription covers the other half, a project
 * opening or closing under a cluster already on screen.
 */
export function useClusterProject(clusterId: string | null): OpenProject | null {
  const [open, setOpen] = useState<OpenProject | null>(null);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;

    // Cleared rather than left showing the previous cluster's project mid-fetch:
    // a stale name is the one wrong answer here that looks entirely plausible.
    setOpen(null);

    void clusterProject(clusterId)
      .then((info) => live && setOpen(info))
      // Left as "no project": the bar draws the same thing for a failed read and
      // for nothing open, and a title has no slot for an error.
      .catch((err: unknown) =>
        console.error("veistra: could not read the cluster's project:", err),
      );

    // Async, and a cleanup must return synchronously, so this runs in the
    // background and `live` covers the gap.
    void (async () => {
      const stop = await onProjectChanged((payload) => {
        // Only this cluster's. The event reaches every window in the process,
        // and a switch on the other monitor must not rename the cluster in
        // front of you — that would undo the feature in its most visible place.
        if (!live || clusterOf(payload) !== clusterId) return;
        setOpen(openOf(payload));
      });
      if (!live) return stop();
      unlisten = stop;
    })();

    return () => {
      live = false;
      unlisten?.();
    };
  }, [clusterId]);

  return open;
}

/**
 * Pull the changed cluster's id out of a `project:changed` payload, or `null`
 * from anything that isn't one. Defensive because the payload is `unknown`,
 * relayed from Rust untyped: a malformed event matches no cluster and is
 * ignored, so the bar is never renamed by a message it could not read.
 */
function clusterOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { clusterId } = payload as { clusterId?: unknown };
  return typeof clusterId === "string" ? clusterId : null;
}

/**
 * Pull the open project out of a `project:changed` payload, or `null` from
 * anything that isn't one. Defensive for `clusterOf`'s reason: a shape check
 * keeps a malformed payload from putting `undefined` in the window title.
 */
function openOf(payload: unknown): OpenProject | null {
  const value = (payload as { open?: unknown } | null)?.open;
  if (typeof value !== "object" || value === null) return null;

  const { name, path } = value as { name?: unknown; path?: unknown };
  if (typeof name !== "string" || typeof path !== "string") return null;
  return { name, path };
}
