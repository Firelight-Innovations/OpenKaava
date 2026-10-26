/**
 * The `files/git-head` call: one file's text as HEAD has it.
 *
 * A sibling of `./gitHunks.ts` rather than folded into it — same reasoning as
 * that file's header gives for staying out of `../rpc.ts`, and this is a
 * second, separate call with its own shape, not a variant of the first.
 */
import { invoke } from "@veistra/bridge";

export interface GitHeadText {
  /**
   * The file exactly as HEAD has it.
   *
   * Empty when the file is not in a git repository, is outside the checkout,
   * or was added since the last commit — all three genuinely have no
   * committed version, and `""` is how a diff expresses a pure addition, so a
   * caller slicing this by a hunk's `originalStart`/`originalLines` needs no
   * special case for any of them: an addition's `originalLines` is 0, so the
   * slice is empty regardless of what `text` holds.
   */
  text: string;
}

export const gitHead = (path: string) => invoke<GitHeadText>("files/git-head", { path });
