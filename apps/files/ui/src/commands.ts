/**
 * The title bar's File menu, from this side.
 *
 * The shell's menu bar cannot reach into this app — File Explorer runs in an
 * iframe and the shell must not import its hooks or poke its DOM. So a menu
 * item is a *message*: the shell posts a transport-B `command` to the active
 * frame, and this module is what this frame does about it.
 * `docs/tool-protocol.md` §3 has the wire shape; `@veistra/bridge`'s `onCommand`
 * is the receiving end.
 *
 * `docs/design-notes/files-app.md` holds two notes this header used to carry:
 * the second copy of this module in the Viewer, answering the commands that act
 * on an open buffer with no coordination between the two; and why `file/delete`
 * is declared there rather than here, a real narrowing taken deliberately.
 */
import { useCallback, useEffect, useRef } from "react";
import { declareCommands, onCommand } from "@veistra/bridge";
import type { ExplorerHandle } from "./explorer/Explorer";
import type { Root } from "./rpc";

/** Every command this app answers. Mirrors `APP_COMMAND` in
 *  `src/shell/titlebar/TitleBar.tsx`, spelled out rather than imported — the
 *  same restatement `rpc.ts`'s header argues for, so that the day this becomes
 *  a tool repository of its own, nothing in `apps/files/` is reaching into
 *  `src/`. */
export const COMMAND = {
  newFile: "file/new-file",
  trash: "file/trash",
} as const;

export interface MenuCommandDeps {
  root: Root | null;
  /** The tree, for New File and Trash. `null` until it mounts. */
  explorer: React.RefObject<ExplorerHandle | null>;
  /** Report a failure where the user will see it. */
  onError: (message: string) => void;
}

/** Answer the shell's menu, and keep it honest about what is possible. Returns
 *  nothing: everything it does is either a side effect on the tree or a
 *  declaration going out over the bridge. */
export function useMenuCommands({ root, explorer }: MenuCommandDeps): void {
  const run = useCallback(
    (command: string) => {
      switch (command) {
        case COMMAND.newFile:
          explorer.current?.newFile();
          return;

        case COMMAND.trash:
          explorer.current?.showTrash();
          return;

        default:
          // A command the shell sent that this app never declared. Dropped
          // rather than guessed at — the shell only sends what was declared, so
          // reaching here means the two disagreed, and acting on it is the
          // worse answer.
          return;
      }
    },
    [explorer],
  );

  // `run` is stable, but the listener is installed once through a ref anyway —
  // the same shape `src/shell/keys/useKeyboard.ts` uses, and cheap insurance
  // against a future dependency making it unstable without anyone noticing that
  // a re-subscribe leaves a window where a command lands on nothing.
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => onCommand((command) => latest.current(command)), []);

  useEffect(() => {
    // Both need somewhere to put a file, so both wait on a root. A tree that
    // has not resolved one cannot make a file and has no Recycle Bin to show.
    declareCommands(root !== null ? [COMMAND.newFile, COMMAND.trash] : []);
  }, [root]);
}
