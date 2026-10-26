/**
 * The `files/git-hunks` call, used only by the dirty-diff gutter in `./monaco.ts`.
 *
 * Not folded into `../rpc.ts`. Every call in that file is shared by the
 * explorer and every viewer; this one belongs to the gutter alone, and giving
 * it its own module keeps it beside the code that calls it instead of growing
 * a shared file neither the explorer nor the other viewers need to import.
 * The shape below mirrors `src-tauri/src/apps/files.rs`, restated rather than
 * imported for the same reason `../rpc.ts`'s header gives: an app knows its
 * host only through `@veistra/bridge`, and a Rust test is what is meant to catch
 * a drift between the two, not `tsc`.
 */
import { invoke } from "@veistra/bridge";

/**
 * One contiguous change between HEAD and the working copy, in the current
 * file's line numbers.
 *
 * `start`/`lines` describe the CURRENT file; `originalStart`/`originalLines`
 * describe the same region as it reads in HEAD. A `"deleted"` hunk has
 * `lines: 0` — the removed text occupies no line of the current file, only a
 * point between two of them — and the backend already clamps `start` to a
 * minimum of 1, so a deletion at the very top of the file still anchors
 * somewhere real rather than at line 0.
 */
export interface GitHunk {
  kind: "added" | "modified" | "deleted";
  start: number;
  lines: number;
  originalStart: number;
  originalLines: number;
}

/**
 * The hunks for one open file.
 *
 * `[]` for an unchanged file, an untracked file, or a path outside a git
 * checkout — the backend does not distinguish those, and the gutter draws the
 * same thing (nothing) for all three, so this module does not need to either.
 */
export const gitHunks = (path: string) => invoke<GitHunk[]>("files/git-hunks", { path });
