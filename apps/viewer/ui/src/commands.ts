/**
 * The title bar's File and Edit menus, from this side.
 *
 * The shell's menu bar cannot reach into this app — File Viewer runs in an
 * iframe and the shell must not import its hooks or poke its DOM. So a menu
 * item is a *message*: the shell posts a transport-B `command` to the active
 * frame and this module answers it. `docs/tool-protocol.md` §3 has the wire
 * shape; `@veistra/bridge`'s `onCommand` is the receiving end.
 *
 * There is a second copy of this file in `apps/files/ui/src/`, answering the
 * commands that act on the tree. Neither knows about the other: each declares
 * what it can do, the shell aims a command at whichever surface is active, and
 * the menu is the union of what the active frame offered — which is why the
 * split needed no change in the title bar at all.
 *
 * Two arguments live in `docs/design-notes/viewer-app.md`: why declaring is the
 * more important half of the feature, and why the ids below are spelled out
 * rather than imported from the shell.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { declareCommands, onCommand } from "@veistra/bridge";
import { activeEditor, subscribeActiveEditor } from "./viewer/activeEditor";
import { documents, type OpenFiles } from "./tabs/useOpenFiles";
import type { DeleteTarget } from "./useDelete";
import { describe, duplicate, saveAs } from "./rpc";

/**
 * Every command this app answers. Mirrors `APP_COMMAND` in the shell.
 *
 * **`file/new-file` and `file/trash` are not here**, and their absence is the
 * split showing through rather than an omission: both act on the *tree* — where
 * a new file lands, which folder's deleted entries to show — and the tree is
 * the File Explorer's, in a different frame. Each app declares what it can do
 * and the shell greys out the rest, with no list of either in the title bar.
 */
export const COMMAND = {
  save: "file/save",
  saveAs: "file/save-as",
  duplicate: "file/duplicate",
  delete: "file/delete",
  undo: "edit/undo",
  redo: "edit/redo",
  cut: "edit/cut",
  copy: "edit/copy",
  find: "edit/find",
  replace: "edit/replace",
} as const;

/**
 * `edit/paste` is deliberately absent. The shell disables Paste outright and
 * says why in `src/shell/titlebar/useEditTarget.ts`: `execCommand("paste")` is
 * refused by every Chromium engine, and `navigator.clipboard.readText()` is
 * gated on a permission whose behaviour in a Tauri WebView2 window this work
 * could not establish without running the app. Ctrl+V is unaffected — that is
 * the browser's own paste, and it never comes through here.
 *
 * Clipboard *write* is not blocked: Cut and Copy below go through
 * `navigator.clipboard.writeText`, which this app already relies on for the
 * context menu's "Copy path".
 */
export const PASTE_IS_NOT_DECLARED = true;

export interface MenuCommandDeps {
  files: OpenFiles;
  /** Put the delete confirmation up. The same one the tab strip raises. */
  askDelete: (target: DeleteTarget) => void;
  /**
   * A file appeared on disk under a new name — Save As, or Duplicate. Reported
   * as a rename because that is the shape the Explorer can act on: it has no way
   * to learn about a file this app created, and a tree that did not re-list
   * would simply not show it. `from` and `to` are the same path when there is no
   * original to move — a duplicate leaves the source where it is — which the
   * Explorer reads as "re-read the tree" and every Viewer's `rename` treats as a
   * no-op, since `retarget` returns early when the two match.
   */
  onTreeChanged: (from: string, to: string) => void;
  /** Report a failure where the user will see it. */
  onError: (message: string) => void;
}

/**
 * Answer the shell's menu, and keep it honest about what is possible. Returns
 * nothing: everything it does is a side effect on the app's own state or a
 * declaration going out over the bridge.
 */
export function useMenuCommands({
  files,
  askDelete,
  onTreeChanged,
  onError,
}: MenuCommandDeps): void {
  // Not a ref and not state: the editor mounts *asynchronously*, a `files/read`
  // after the tab appears, so nothing this component already re-renders on
  // marks the moment the Edit menu becomes usable. See `viewer/activeEditor`.
  const editor = useSyncExternalStore(subscribeActiveEditor, activeEditor);

  const active = files.tabs.find((tab) => tab.path === files.activePath) ?? null;
  /**
   * Whether the active tab is dirty, asked of the buffer rather than the `dirty`
   * Set — the reason `close` does: the render mirror lags a keystroke by a
   * commit, and a Save greyed out a beat after the last character was typed
   * would be wrong at exactly the moment it matters. Both are consulted, so a
   * viewer reporting dirty without a Monaco document (there is none today) is
   * not missed.
   */
  const dirty = active !== null && (documents.isDirty(active.path) || files.dirty.has(active.path));

  /** A file that is open and still on disk — what Duplicate and Delete need. */
  const onDisk = active !== null && !active.missing;

  const run = useCallback(
    (command: string) => {
      switch (command) {
        case COMMAND.save:
          // Straight to the tab model's own save, which is the same one Ctrl+S
          // reaches and the same one the close-a-dirty-tab prompt uses. There is
          // no second write path in this app, by design.
          void files.saveActive().catch((err: unknown) => onError(describe("files/write", err)));
          return;

        case COMMAND.saveAs: {
          if (!active) return;
          const doc = documents.get(active.path);
          if (!doc) return;
          // The buffer, not the file: Save As on a file with unsaved changes
          // should write what is on screen, not a disk copy that silently
          // discards the edit it was called to preserve.
          void saveAs(active.name, doc.model.getValue())
            .then((result) => {
              // Cancelled. Not a failure, and nothing to report.
              if (!result) return;
              onTreeChanged(result.path, result.path);
              // The copy opens; the original tab keeps its unsaved changes,
              // because they are still unsaved *at that path* and marking it
              // clean would be claiming a write that never happened there.
              files.open(result.path, false);
            })
            .catch((err: unknown) => onError(describe("files/save-as", err)));
          return;
        }

        case COMMAND.duplicate: {
          if (!active) return;
          void duplicate(active.path)
            .then((made) => {
              onTreeChanged(made.path, made.path);
              // A real open rather than a preview: duplicating a file is a
              // deliberate act, the same as naming a new one in the tree.
              if (made.kind !== "dir") files.open(made.path, false);
            })
            .catch((err: unknown) => onError(describe("files/duplicate", err)));
          return;
        }

        case COMMAND.delete:
          // Through `useDelete`, the *only* way anything in this app deletes. A
          // menu-bar Delete that called `files/delete` itself would skip the
          // confirmation that names the file, counts a folder's contents and
          // warns about unsaved work; a different route is no reason to lose it.
          if (active && !active.missing) {
            askDelete({ path: active.path, name: active.name, kind: "file" });
          }
          return;

        default:
          runEditorCommand(command, onError);
      }
    },
    [active, askDelete, files, onError, onTreeChanged],
  );

  // `run` changes identity on every render — `files` is a fresh object each
  // time and is one of its dependencies. Subscribing directly would tear the
  // listener down and re-add it after every render, with a window in between
  // where a command would land on nothing. A ref keeps it installed once and
  // still current, the shape `src/shell/keys/useKeyboard.ts` uses.
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => onCommand((command) => latest.current(command)), []);

  useEffect(() => {
    const available: string[] = [];

    if (dirty) available.push(COMMAND.save);
    if (active && documents.get(active.path)) available.push(COMMAND.saveAs);
    if (onDisk) available.push(COMMAND.duplicate, COMMAND.delete);

    if (editor) {
      // Undo, Redo, Cut and Copy are declared for as long as an editor is
      // mounted, rather than tracked against the undo stack and the selection.
      // A deliberate trade: both change on every keystroke and cursor move, so
      // tracking them means a `veistra/commands` message per keystroke for a grey
      // pixel — and what an undeclared item buys is not there. Monaco's undo
      // with an empty stack does nothing, exactly what a disabled item does, and
      // its copy with no selection copies the current line, a real action.
      //
      // Save is tracked, because that one is not a no-op-when-unavailable: a
      // Save offered on a clean file claims there is something to write.
      available.push(COMMAND.undo, COMMAND.redo, COMMAND.copy, COMMAND.find);

      // A truncated file opens read-only — see `TextViewer`. Cut and Replace
      // change the text, so they go with the ability to; Copy and Find do not.
      if (!editor.getOption(EDITOR_OPTION_READ_ONLY)) {
        available.push(COMMAND.cut, COMMAND.replace);
      }
    }

    declareCommands(available);
  }, [active, dirty, onDisk, editor]);
}

/**
 * Monaco's numeric id for the `readOnly` option.
 *
 * `editor.getOption` takes an `EditorOption` enum member, and importing that
 * enum would mean a static `import` of `monaco-editor` from a module `App.tsx`
 * loads — the one thing `viewer/monaco.ts`'s header forbids, because it moves
 * 3.86 MB into the Files entry chunk. So the value is written down. It is
 * stable within a Monaco version (the enum is generated alphabetically and
 * pinned in `package.json`), and if it ever moves the failure is the mildest
 * available: Cut and Replace offered on a read-only pane, where Monaco refuses
 * them anyway. `getOption` on an out-of-range id returns `undefined`, so a
 * shifted enum cannot make an editable pane read-only.
 */
const EDITOR_OPTION_READ_ONLY = 96;

/**
 * The Edit commands, which all act on the mounted editor.
 *
 * Focused first, every time. A menu command arrives because someone clicked the
 * title bar, which means focus is on a button in the *shell's* document — and
 * Monaco's actions read the editor's own focus and selection. Without this,
 * Find would open a widget nobody can type into.
 *
 * Undo and Redo go through `trigger` rather than `getAction`: they are model
 * operations rather than registered editor actions, and `getAction("undo")`
 * finds nothing.
 *
 * Cut and Copy go through `navigator.clipboard` rather than Monaco's own
 * actions, which wrap `document.execCommand` and would silently do nothing for
 * a command that arrives by `postMessage`. With no selection both act on the
 * whole current line — VS Code's behaviour, and the reason these two are worth
 * offering without tracking the selection. The full argument is in
 * `docs/design-notes/viewer-app.md`.
 */
function runEditorCommand(command: string, onError: (message: string) => void): void {
  const editor = activeEditor();
  if (!editor) return;
  editor.focus();

  switch (command) {
    case COMMAND.undo:
      editor.trigger("menu", "undo", null);
      return;
    case COMMAND.redo:
      editor.trigger("menu", "redo", null);
      return;
    case COMMAND.find:
      void editor.getAction("actions.find")?.run();
      return;
    case COMMAND.replace:
      void editor.getAction("editor.action.startFindReplaceAction")?.run();
      return;
    case COMMAND.copy:
    case COMMAND.cut: {
      const model = editor.getModel();
      const selection = editor.getSelection();
      if (!model || !selection) return;

      // An empty selection means the whole line, including its line break, so
      // that a cut closes the gap rather than leaving a blank row behind.
      const range = selection.isEmpty()
        ? {
            startLineNumber: selection.startLineNumber,
            startColumn: 1,
            endLineNumber: selection.startLineNumber + 1,
            endColumn: 1,
          }
        : selection;

      const text = model.getValueInRange(range);
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          if (command !== COMMAND.cut) return;
          // Only after the write succeeded. A cut that removed the text and
          // then failed to put it on the clipboard would have destroyed it —
          // undoable, but only by someone who noticed.
          editor.executeEdits("menu", [{ range, text: "" }]);
        })
        .catch((err: unknown) =>
          onError(
            `The clipboard refused this: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return;
    }
    default:
      // A command the shell sent that this app never declared. Dropped rather
      // than guessed at: the shell only sends what was declared, so reaching
      // here means the two disagreed and acting on it is the worse answer.
      return;
  }
}
