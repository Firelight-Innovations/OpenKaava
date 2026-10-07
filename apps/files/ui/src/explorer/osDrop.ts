/**
 * Where an operating-system file drop lands in the tree, and what to say about how it went.
 *
 * Pure so both are tested without a frame. The shell passes the drop in with coordinates
 * relative to this frame (`routeOsFileDrag`), because the webview owns OS drops and an
 * iframe never gets the HTML5 drop events.
 */
import type { Imported } from "../rpc";

/**
 * The folder a drop at `el` goes into: a folder row's own path, a file row's parent, and
 * the project root for anything else, blank space included.
 */
export function dropFolderAt(el: Element | null, rootPath: string): string {
  const row = el?.closest<HTMLElement>("[data-path][data-kind]");
  if (!row) return rootPath;
  if (row.dataset.kind === "dir") return row.dataset.path ?? rootPath;
  return row.dataset.parent || rootPath;
}

/** The last segment of a path, both separators. */
function leaf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** What the explorer says when a drop did not go entirely to plan; `null` when it did. */
export function importMessage(dest: string, rootPath: string, done: Imported): string | null {
  const where = dest === rootPath ? "the project folder" : `"${leaf(dest)}"`;
  const parts: string[] = [];
  if (done.conflicts.length > 0) {
    const one = done.conflicts.length === 1;
    parts.push(
      `Not copied, because ${where} already has ${one ? "an item" : "items"} with ${one ? "that name" : "those names"}: ${done.conflicts.join(", ")}. Nothing was overwritten.`,
    );
  }
  for (const failure of done.failed) {
    parts.push(`Could not copy ${failure.name}: ${failure.reason}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The refusal on a read-only checkout, in words that say what to do. */
export const READ_ONLY_DROP =
  "This checkout is read-only, so nothing can be dropped into it. Open a worktree cluster to add files.";
