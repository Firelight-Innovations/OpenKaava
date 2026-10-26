/**
 * The open-file model: which tabs exist, which is showing, which are dirty, and
 * the buffers behind them.
 *
 * Two things live here that look like they belong elsewhere, and both are here
 * for the same reason — `ViewerProps` in `../viewer/registry.ts` is a fixed
 * four-prop contract and a viewer cannot be handed anything else: `documents`,
 * the module-scope store of Monaco models, and `saveDocument`, the single
 * implementation of "write this buffer to disk". Each is argued where it is
 * defined, as is the `import type` the Monaco types below must keep.
 *
 * What this deliberately does not do: watch the filesystem. There is no
 * watcher, so external changes are noticed by `stat`-ing the open files on tab
 * activate and on the window regaining focus. That is a poll and it has a
 * window — the `baseMtime` guard on `files/write` is the backstop that catches
 * what the poll misses, and it catches it at the only moment that matters.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice, NoticeAction } from "../NoticeBar";
import type { OpenFile } from "../viewer/registry";
// **`import type` on the next line, and it must stay that way.** It is erased
// before Rollup builds the graph, so this module — which `App.tsx` imports at
// load — never pulls Monaco into the Files entry chunk. A plain `import` would
// undo the dynamic-`import()` discipline `../viewer/registry.ts` exists to
// protect, moving 3.86 MB into a 175 kB entry chunk paid on every Files launch.
// Nothing would fail; `tsc` and the build would both stay green, which is
// exactly why it is written down. The measurements are in
// `docs/design-notes/viewer-app.md`. Nothing in this file *creates* a model; it
// only holds and disposes ones `TextViewer` made.
import type { TextModel, EditorViewState } from "../viewer/monaco";
import { baseName, extensionOf, stat, write } from "../rpc";
import { publish } from "@veistra/bridge";
import { FILE_SAVED, type FileSaved } from "../topics";

/** Bumped for every `FILE_SAVED`, so no two are equal and the bridge's dedup
 *  cannot swallow a second save of the same file. See `FileSaved`. */
let savedSeq = 0;

/**
 * A question the tab strip must put to the user before something irreversible
 * happens, or a report it must make about a tab going stale under them.
 *
 * The shape moved to `../NoticeBar` when the tree needed to ask questions of
 * its own — a file deleted from the explorer may not be open, so the bar could
 * no longer belong to the tab strip. Re-exported under its old name because
 * that is what a tab's field is called and renaming it would be churn for
 * nothing.
 *
 * It still rides on the tab rather than arriving as a prop: a notice is *about*
 * one file, and a tab strip handed a loose notice would have to be told which
 * chip it belonged under.
 *
 * Left-most action is the safe one, and `NoticeBar` focuses it. Nothing here
 * uses `window.confirm`: a modal that blocks the event loop inside an iframe is
 * a worse answer than a bar the user can ignore.
 */
export type TabNotice = Notice;
export type TabAction = NoticeAction;

export interface OpenTab extends OpenFile {
  /** Bumped to force the viewer to remount and re-read — an external reload. */
  nonce: number;
  /**
   * The file is gone from disk. The tab stays open regardless: its buffer may
   * be the only copy left, and closing it would be this app deleting someone's
   * work because something else deleted a file.
   */
  missing: boolean;
  /**
   * This tab is a *peek*, and the next peek will take its place. At most one
   * tab is ever in this state; see `open` for the whole of the rule and
   * `promote` for the ways out of it.
   */
  preview: boolean;
  notice: TabNotice | null;
}

/** The buffer behind one open tab, plus everything needed to save it. */
export interface TabDocument {
  model: TextModel;
  /**
   * `model.getAlternativeVersionId()` as of the last read or write. Dirty is
   * any difference — which, unlike a boolean flag, goes back to *clean* when
   * the user undoes their way to the saved text.
   */
  savedVersionId: number;
  /** The mtime of the read (or write) this text is based on. See `files/write`. */
  baseMtime: number | null;
  /**
   * The backend's byte cap, when the read came back truncated; `null` when the
   * whole file is here. One field rather than a boolean and a number, because
   * the banner needs the limit and the save guard needs the boolean, and two
   * fields could disagree.
   */
  truncatedAt: number | null;
  /** Cursor and scroll, saved on unmount so a tab switch comes back in place. */
  viewState: EditorViewState | null;
  /**
   * The extension this model's *language* was chosen from.
   *
   * Not the same fact as the tab's `ext`, and that is exactly why it is here: a
   * rename can change the extension under a buffer that must not be re-read, at
   * which point the model is still tokenizing `notes.txt` as plain text while
   * the tab says `notes.md`. `TextViewer` compares the two on mount and puts
   * the language right. Nothing else needs to know.
   */
  ext: string;
}

/** How the store reports back to the tab list that owns it. */
export interface DocumentHost {
  /** Drop this tab's buffer and remount its viewer, so it reads disk again. */
  reload(path: string): void;
  /** A write landed, and this is the mtime the file now has. */
  saved(path: string, mtime: number | null): void;
}

/**
 * One Monaco model per open path, at module scope rather than in hook state.
 *
 * `TextViewer` has no route to a hook's closure, and the whole point of the
 * store is that a model outlives the viewer that mounted it — which is what
 * makes undo history, cursor and scroll survive a tab switch. One Files frame
 * per window, so one store.
 */
class DocumentStore {
  private readonly byPath = new Map<string, TabDocument>();

  /** Set by the mounted `useOpenFiles`. `null` between frames. */
  host: DocumentHost | null = null;

  get(path: string): TabDocument | undefined {
    return this.byPath.get(path);
  }

  put(path: string, doc: TabDocument): void {
    this.discard(path);
    this.byPath.set(path, doc);
  }

  /**
   * Forget a buffer and dispose its model.
   *
   * Monaco models are not garbage: each one is registered with the model
   * service under its URI and holds its own tokenizer state and undo stack, so
   * one that is dropped without `dispose()` leaks for the life of the frame and
   * makes the next `createModel` at the same path throw. `DiffView.tsx`'s
   * closing comment documents the same trap from the other end.
   */
  discard(path: string): void {
    const doc = this.byPath.get(path);
    if (!doc) return;
    this.byPath.delete(path);
    doc.model.dispose();
  }

  /**
   * Move a buffer to a new path, keeping the model alive.
   *
   * The whole point of a rename following through to an open tab: the model is
   * *not* disposed and *not* re-read, so unsaved changes, undo history and the
   * cursor all survive a rename the way they survive a tab switch. Disposing
   * and re-reading would be this app deleting someone's work because they
   * corrected a typo in a filename.
   *
   * What it cannot move is the model's own URI, which Monaco fixes at creation.
   * That is tolerable because nothing here keys off it — no JSON `fileMatch`
   * associations are configured, and the language, which *is* derived from the
   * name, is put right by `TextViewer` on its next mount. If a language service
   * ever arrives, this is the line that has to become "make a new model and
   * transplant the undo stack", and there is no cheap version of that.
   */
  rekey(from: string, to: string): void {
    if (from === to) return;
    const doc = this.byPath.get(from);
    if (!doc) return;
    this.byPath.delete(from);
    // Anything already parked at the destination is gone from disk by now —
    // the rename would have been refused otherwise — so its buffer is stale.
    this.discard(to);
    this.byPath.set(to, doc);
  }

  /**
   * Whether this buffer differs from what is on disk, asked of the model
   * itself rather than of React state.
   *
   * Used by `close`, which must be right *now* — the dirty `Set` is a render
   * input that lags a keystroke by a commit, and closing a tab on a stale
   * answer would discard the last thing typed.
   */
  isDirty(path: string): boolean {
    const doc = this.byPath.get(path);
    return doc !== undefined && doc.model.getAlternativeVersionId() !== doc.savedVersionId;
  }
}

export const documents = new DocumentStore();

/** Saves in flight, keyed by path. See `saveDocument`. */
const saving = new Map<string, Promise<void>>();

/**
 * Where `path` ends up when `from` is renamed to `to`, or `null` if it is not
 * affected at all.
 *
 * The separator check is what keeps this from being a plain `startsWith`, and
 * it is not pedantry: renaming `src` would otherwise claim `src-generated` as
 * a child of it and rewrite that tab's path into nonsense. A path is inside a
 * folder only when the next character is a separator.
 *
 * Both separators are accepted for the reason `baseName` gives — a Windows
 * path can contain either, and the backend returns whatever `Display` produced.
 */
function retarget(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (!isAtOrUnder(path, from)) return null;
  return to + path.slice(from.length);
}

/**
 * Whether `path` is `root` itself or something inside it.
 *
 * The separator check is what keeps this from being a plain `startsWith`, and
 * it is not pedantry: without it `src` would claim `src-generated` as a child,
 * which for `retarget` means rewriting a tab's path into nonsense and for
 * `dropUnder` means closing a file the user did not delete.
 *
 * Both separators are accepted for the reason `baseName` gives — a Windows path
 * can contain either, and the backend returns whatever `Display` produced.
 */
function isAtOrUnder(path: string, root: string): boolean {
  if (path === root) return true;
  if (!path.startsWith(root)) return false;
  const next = path.charAt(root.length);
  return next === "\\" || next === "/";
}

/**
 * Write one open buffer to disk. The only place that calls `files/write`.
 *
 * Both the viewer's registered save and the close-a-dirty-tab prompt go through
 * it, so there is one place that knows about `baseMtime` and one place that can
 * be wrong.
 *
 * Rejects on every failure, including a stale-write conflict — callers decide
 * what to draw. `TextViewer` turns a stale rejection into its own banner;
 * `close` turns it into a notice and leaves the tab open. Neither may swallow
 * it, because a save that silently did nothing is how edits disappear.
 *
 * Concurrent calls for one path share a promise rather than racing. Monaco's
 * Ctrl+S and the document-level one in `App.tsx` can both fire for a single
 * keypress, and two writes with the same `baseMtime` would make the second one
 * fail as stale against the first — a conflict the app invented itself.
 */
export function saveDocument(path: string): Promise<void> {
  const running = saving.get(path);
  if (running) return running;

  const attempt = writeDocument(path).finally(() => saving.delete(path));
  saving.set(path, attempt);
  return attempt;
}

async function writeDocument(path: string): Promise<void> {
  const doc = documents.get(path);
  // Nothing open at this path is not a failure: `saveActive` may be called with
  // a read-only viewer showing, or with no tab at all.
  if (!doc) return;

  if (doc.truncatedAt !== null) {
    throw new Error("This file is only partly loaded — saving it would delete the rest.");
  }

  const text = doc.model.getValue();
  // Read the version *before* awaiting. Anything typed while the write is in
  // flight belongs to a later version, and must leave the tab dirty rather than
  // be marked saved by a write that did not contain it.
  const version = doc.model.getAlternativeVersionId();

  const result = await write(path, text, doc.baseMtime);

  doc.savedVersionId = version;
  doc.baseMtime = result.mtime;
  documents.host?.saved(path, result.mtime);
}

/**
 * Ask the tab list to reload one file from disk, discarding its buffer.
 *
 * The route a viewer takes to the nonce bump it cannot reach itself. A no-op
 * when no frame is mounted, which is the right answer: there is no tab to
 * remount.
 */
export function requestReload(path: string): void {
  documents.host?.reload(path);
}

/** Everything `App.tsx` needs from the tab model, and nothing more. */
export interface OpenFiles {
  tabs: OpenTab[];
  activePath: string | null;
  dirty: ReadonlySet<string>;
  /**
   * Show a file. `preview` opens it in the one replaceable slot; anything else
   * opens — or promotes — a tab that stays until it is closed.
   */
  open(path: string, preview?: boolean): void;
  /** Bring a tab forward. `promote` is the double-click on a preview tab. */
  activate(path: string, promote?: boolean): void;
  /** A rename landed on disk — move any tab that was pointing at the old path. */
  rename(from: string, to: string): void;
  close(path: string): void;
  /** Names of open files at or under `path` with unsaved work. For a confirmation. */
  unsavedUnder(path: string): string[];
  /** Close every tab at or under `path`, unprompted. For a confirmed delete. */
  dropUnder(path: string): void;
  setDirty(path: string, dirty: boolean): void;
  registerSave(path: string, save: (() => Promise<void>) | null): void;
  saveActive(): Promise<void>;
}

export function useOpenFiles(): OpenFiles {
  /**
   * Three pieces of state, each mirrored into a ref that is written first.
   *
   * The ref is the value; the state is the render mirror. Callbacks read the
   * ref, so none of them needs the state in a dependency array and none of them
   * changes identity — which matters because `App.tsx` passes them straight
   * into effects. It also keeps every update out of a `setState` updater
   * function, so nothing here misbehaves under StrictMode's double invoke.
   */
  const tabsRef = useRef<OpenTab[]>([]);
  const [tabs, setTabsState] = useState<OpenTab[]>(tabsRef.current);

  const activeRef = useRef<string | null>(null);
  const [activePath, setActiveState] = useState<string | null>(null);

  const dirtyRef = useRef<ReadonlySet<string>>(new Set<string>());
  const [dirty, setDirtyState] = useState<ReadonlySet<string>>(dirtyRef.current);

  /** Saves registered by whichever viewers are currently mounted. */
  const saves = useRef(new Map<string, () => Promise<void>>());

  const writeTabs = useCallback((next: OpenTab[]) => {
    tabsRef.current = next;
    setTabsState(next);
  }, []);

  const writeActive = useCallback((next: string | null) => {
    activeRef.current = next;
    setActiveState(next);
  }, []);

  const writeDirty = useCallback((path: string, isDirty: boolean) => {
    if (dirtyRef.current.has(path) === isDirty) return;
    const next = new Set(dirtyRef.current);
    if (isDirty) next.add(path);
    else next.delete(path);
    dirtyRef.current = next;
    setDirtyState(next);
  }, []);

  const patch = useCallback(
    (path: string, change: Partial<OpenTab>) => {
      if (!tabsRef.current.some((tab) => tab.path === path)) return;
      writeTabs(tabsRef.current.map((tab) => (tab.path === path ? { ...tab, ...change } : tab)));
    },
    [writeTabs],
  );

  /** Refresh a tab's disk facts. Silent on failure — see `open`. */
  const restat = useCallback(
    (path: string) => {
      void stat(path)
        .then((entry) => {
          const gone = !entry.exists;
          patch(path, {
            name: entry.name,
            ext: extensionOf(entry.name),
            size: entry.size,
            mtime: entry.mtime,
            missing: gone,
            // A deleted — or renamed — file makes this tab's buffer the last
            // copy of it, which `OpenTab.missing` is already the argument for
            // keeping. A preview tab is the one kind that gets taken away
            // without being asked, so it stops being one.
            ...(gone ? { preview: false } : {}),
          });
        })
        .catch(() => {
          /* A stat that failed says nothing about the file, only about the
             call. The viewer's own read is what reports a real problem. */
        });
    },
    [patch],
  );

  /**
   * Close a tab and let go of everything behind it.
   *
   * Unconditional — `close` decides whether it is allowed. Activation moves to
   * the tab on the right, or the left when there is none, which is what every
   * editor does and what keeps a run of closes from jumping around.
   */
  const drop = useCallback(
    (path: string) => {
      const index = tabsRef.current.findIndex((tab) => tab.path === path);
      if (index === -1) return;

      documents.discard(path);
      saves.current.delete(path);
      writeDirty(path, false);

      const next = tabsRef.current.filter((tab) => tab.path !== path);
      writeTabs(next);

      if (activeRef.current === path) {
        writeActive(next[index]?.path ?? next[index - 1]?.path ?? null);
      }
    },
    [writeTabs, writeActive, writeDirty],
  );

  /**
   * Throw away this tab's buffer and make its viewer read disk again.
   *
   * The nonce is what does it: `App.tsx` keys the viewer on `path:nonce`, so a
   * bump remounts it. Discarding the document first is what makes the remount
   * re-read rather than find the old buffer still in the store — and it is also
   * why a reload loses undo history, which is correct: the text it applied to
   * is gone.
   */
  const reload = useCallback(
    (path: string) => {
      const tab = tabsRef.current.find((entry) => entry.path === path);
      if (!tab) return;

      documents.discard(path);
      writeDirty(path, false);
      patch(path, { nonce: tab.nonce + 1, notice: null });
      restat(path);
    },
    [patch, restat, writeDirty],
  );

  /** Ask before losing edits. Save first — the safe answer goes on the left. */
  const askBeforeClosing = useCallback(
    (path: string, name: string) => {
      const notice: TabNotice = {
        tone: "warn",
        message: `${name} has unsaved changes.`,
        actions: [
          {
            label: "Save",
            run: () => {
              patch(path, { notice: null });
              void saveDocument(path)
                .then(() => drop(path))
                .catch((err: unknown) => {
                  // The tab stays open. A close that lost the save *and* the
                  // buffer is the one outcome this whole prompt exists to
                  // prevent, so a failed save can only ever end here.
                  patch(path, {
                    notice: {
                      tone: "err",
                      message: `Could not save ${name}: ${err instanceof Error ? err.message : String(err)}`,
                      actions: [
                        { label: "Keep editing", run: () => patch(path, { notice: null }) },
                        { label: "Discard changes", run: () => drop(path) },
                      ],
                    },
                  });
                });
            },
          },
          { label: "Discard", run: () => drop(path) },
          { label: "Cancel", run: () => patch(path, { notice: null }) },
        ],
      };
      patch(path, { notice });
    },
    [drop, patch],
  );

  /**
   * `stat` every open file and react to what moved.
   *
   * Runs on activate and when the window comes back — see the header on why
   * there is no watcher. A tab already showing a notice is skipped: it is
   * already asking the user a question, and re-asking it every poll would
   * replace the notice object under their cursor.
   */
  const poll = useCallback(() => {
    for (const tab of tabsRef.current) {
      if (tab.notice) continue;

      const path = tab.path;
      const knownMtime = tab.mtime;

      void stat(path)
        .then((entry) => {
          if (!entry.exists) {
            // Same reasoning as `restat`: the buffer is the last copy, so the
            // tab must stop being replaceable.
            patch(path, { missing: true, preview: false });
            return;
          }
          if (tab.missing) patch(path, { missing: false });

          // A filesystem that cannot report times can't be polled; the
          // `baseMtime` guard on write is the whole defence there, and it
          // treats a null base as "write anyway" by design.
          if (entry.mtime === null || knownMtime === null || entry.mtime === knownMtime) return;

          if (!documents.isDirty(path) && !dirtyRef.current.has(path)) {
            reload(path);
            return;
          }

          const observed = entry.mtime;
          patch(path, {
            notice: {
              tone: "warn",
              message: `${tab.name} changed on disk, and you have unsaved changes.`,
              actions: [
                { label: "Keep mine", run: () => patch(path, { mtime: observed, notice: null }) },
                { label: "Reload from disk", run: () => reload(path) },
              ],
            },
          });
        })
        .catch(() => {
          /* Same as `restat`: a failed poll is not evidence about the file. */
        });
    }
  }, [patch, reload]);

  /**
   * This tab is a preview *and* nothing would be lost by replacing it.
   *
   * A preview that has been typed into, or whose file went away, or that is
   * asking the user a question is promoted where it stands and the new file
   * opens beside it. The rule this enforces is the only one that really matters
   * here: **no buffer with unsaved work in it is ever discarded without being
   * asked.**
   */
  const isSpare = useCallback((tab: OpenTab) => {
    if (!tab.preview) return false;
    // Every one of these is supposed to have cleared `preview` already — see
    // `setDirty` and `restat`. Asked again here because this is the moment a
    // buffer would actually be thrown away, and the cost of a redundant check
    // is nothing against the cost of being wrong once. `documents.isDirty`
    // rather than only the `Set`, for the reason given on that method: the
    // render mirror lags a keystroke by a commit.
    if (tab.notice || tab.missing) return false;
    return !documents.isDirty(tab.path) && !dirtyRef.current.has(tab.path);
  }, []);

  /** Stop a tab being replaceable. Idempotent, and the only way out of preview. */
  const promote = useCallback((path: string) => patch(path, { preview: false }), [patch]);

  /**
   * Open a file, or bring its tab forward if it is already open.
   *
   * The tab appears at once and its disk facts are filled in when the `stat`
   * lands, rather than the other way round — a click that does nothing for a
   * round trip reads as a click that missed. Everything downstream tolerates
   * the gap: the viewer takes its `baseMtime` from its own read, not from here,
   * and the poll skips a tab whose mtime is still null.
   *
   * `preview` is VS Code's single-click: the file opens in a slot that the
   * *next* single click takes over, so browsing a folder leaves one tab behind
   * rather than forty. There is at most one such slot — "the preview tab" is a
   * role, not a property a second tab could also hold — and it is only ever
   * replaced when replacing it loses nothing; see `isSpare` above.
   *
   * Nothing here debounces or times anything, and the double-click case is not
   * special-cased: the DOM fires `click` before `dblclick`, so it arrives as a
   * preview open followed by this same function with `preview: false`, which
   * promotes the tab the first click just made. Exactly VS Code's sequence.
   */
  const open = useCallback(
    (path: string, preview = false) => {
      writeActive(path);

      const existing = tabsRef.current.find((tab) => tab.path === path);
      if (existing) {
        // A deliberate open of a file that is already peeked makes it stay. A
        // preview open of a tab that is already permanent changes nothing —
        // demoting it would be an editor taking a tab away.
        if (!preview && existing.preview) promote(path);
        restat(path);
        return;
      }

      const name = baseName(path);
      const tab: OpenTab = {
        path,
        name,
        ext: extensionOf(name),
        size: null,
        mtime: null,
        nonce: 0,
        missing: false,
        preview,
        notice: null,
      };

      const slot = preview ? tabsRef.current.findIndex(isSpare) : -1;
      if (slot === -1) {
        // Any preview tab still standing was not spare, so it keeps its place
        // in the strip and loses only its replaceability.
        for (const other of tabsRef.current) if (other.preview) promote(other.path);
        writeTabs([...tabsRef.current, tab]);
      } else {
        // In place, not close-then-append: the strip must not reshuffle under
        // someone arrowing down a folder one file at a time.
        const outgoing = tabsRef.current[slot].path;
        documents.discard(outgoing);
        saves.current.delete(outgoing);
        writeDirty(outgoing, false);
        writeTabs(tabsRef.current.map((other, index) => (index === slot ? tab : other)));
      }

      restat(path);
    },
    [isSpare, promote, restat, writeActive, writeDirty, writeTabs],
  );

  const activate = useCallback(
    (path: string, shouldPromote = false) => {
      writeActive(path);
      if (shouldPromote) promote(path);
      poll();
    },
    [poll, promote, writeActive],
  );

  /**
   * A rename landed on disk; bring every affected tab with it.
   *
   * Called by the tree once `files/rename` has come back, and it must run
   * *before* anything polls: a tab still pointing at the old path would `stat`,
   * find nothing, and mark itself missing — a phantom "deleted" tab for a file
   * that is perfectly fine, which is the exact failure this exists to prevent.
   *
   * Folders count. Renaming `src` to `source` moves every open tab underneath
   * it, because those tabs' paths are just as stale as the folder's and each
   * one would otherwise go missing for the same reason.
   *
   * Nothing is re-read. `documents.rekey` carries the live buffer across, so a
   * tab with unsaved changes stays dirty, keeps its undo history, and is still
   * the same buffer afterwards — see that method for the one thing it cannot
   * move.
   */
  const rename = useCallback(
    (from: string, to: string) => {
      const moves = new Map<string, string>();
      for (const tab of tabsRef.current) {
        const moved = retarget(tab.path, from, to);
        if (moved !== null && moved !== tab.path) moves.set(tab.path, moved);
      }
      if (moves.size === 0) return;

      for (const [was, now] of moves) {
        documents.rekey(was, now);
        // The viewer remounts on the new path and registers a fresh save; the
        // one filed under the old path closes over a path that is now wrong.
        saves.current.delete(was);
      }

      const nextDirty = new Set(dirtyRef.current);
      for (const [was, now] of moves) {
        if (nextDirty.delete(was)) nextDirty.add(now);
      }
      dirtyRef.current = nextDirty;
      setDirtyState(nextDirty);

      writeTabs(
        tabsRef.current.map((tab) => {
          const now = moves.get(tab.path);
          if (now === undefined) return tab;
          const name = baseName(now);
          return {
            ...tab,
            path: now,
            name,
            ext: extensionOf(name),
            // Whatever this tab was worried about was about the old path. A
            // "changed on disk" question in particular cannot be answered any
            // more, and leaving it up would be asking about a file that is
            // gone under a name that is not.
            missing: false,
            notice: null,
          };
        }),
      );

      const active = activeRef.current;
      if (active !== null) {
        const moved = moves.get(active);
        if (moved !== undefined) writeActive(moved);
      }

      for (const now of moves.values()) restat(now);
    },
    [restat, writeActive, writeTabs],
  );

  /**
   * The names of open files at or under `path` that have unsaved work.
   *
   * Asked *before* a delete is confirmed, so the confirmation can name what is
   * about to be lost. `documents.isDirty` as well as the `Set`, for the reason
   * given on that method: the render mirror lags a keystroke by a commit, and a
   * warning that misses the last thing typed is the warning that matters.
   *
   * Inclusive of `path` itself, so it answers for a single file and for every
   * open file inside a folder with one call.
   */
  const unsavedUnder = useCallback((path: string): string[] => {
    return tabsRef.current
      .filter((tab) => isAtOrUnder(tab.path, path))
      .filter((tab) => documents.isDirty(tab.path) || dirtyRef.current.has(tab.path))
      .map((tab) => tab.name);
  }, []);

  /**
   * Close every tab at or under `path`, without asking.
   *
   * For a delete that has already happened. Unconditional on purpose: `close`
   * would prompt about unsaved changes, and the user has just been asked that
   * exact question by the confirmation and answered it. Prompting again would
   * be asking whether they meant the thing they already confirmed.
   *
   * The file is gone, so there is nothing for a tab to be about. This is the
   * one case that overrides `OpenTab.missing`'s rule about keeping a tab whose
   * buffer may be the last copy — that rule is for a file that vanished
   * *unexpectedly*, and this one left because the user said so.
   */
  const dropUnder = useCallback(
    (path: string) => {
      for (const tab of tabsRef.current.filter((entry) => isAtOrUnder(entry.path, path))) {
        drop(tab.path);
      }
    },
    [drop],
  );

  const close = useCallback(
    (path: string) => {
      const tab = tabsRef.current.find((entry) => entry.path === path);
      if (!tab) return;

      if (documents.isDirty(path) || dirtyRef.current.has(path)) {
        askBeforeClosing(path, tab.name);
        return;
      }
      drop(path);
    },
    [askBeforeClosing, drop],
  );

  const setDirty = useCallback(
    (path: string, isDirty: boolean) => {
      writeDirty(path, isDirty);
      // Typing into a peek is the plainest statement there is that this file
      // was worth opening. Promoting on the first keystroke is also what makes
      // `isSpare` almost always redundant, which is the point: by the time
      // anything would consider replacing this tab, it is no longer a preview.
      if (isDirty) promote(path);
    },
    [promote, writeDirty],
  );

  const registerSave = useCallback((path: string, save: (() => Promise<void>) | null) => {
    if (save) saves.current.set(path, save);
    else saves.current.delete(path);
  }, []);

  /**
   * Save whatever is showing, if it can be saved.
   *
   * Resolves rather than rejecting when there is nothing to save — no tab, or a
   * read-only viewer that never registered anything. Ctrl+S over an image is
   * not an error.
   */
  const saveActive = useCallback(async () => {
    const path = activeRef.current;
    if (!path) return;
    const save = saves.current.get(path);
    if (!save) return;
    await save();
  }, []);

  // The store's way back to the tab list. Re-installed rather than merged, so
  // a remounted frame replaces a stale closure instead of racing one.
  useEffect(() => {
    documents.host = {
      reload,
      saved: (path, mtime) => {
        writeDirty(path, false);
        patch(path, { mtime, notice: null });
        // The one place a write is known to have landed, whichever route it
        // came in by — Ctrl+S, the close prompt, a viewer's own save button.
        // The Explorer re-asks git on it, so the row goes yellow the moment
        // the file does.
        savedSeq += 1;
        publish(FILE_SAVED, { path, seq: savedSeq } satisfies FileSaved);
      },
    };
    return () => {
      documents.host = null;
    };
  }, [patch, reload, writeDirty]);

  /**
   * Notice external changes when the user comes back.
   *
   * Both events, because this app runs in an iframe and neither is sufficient
   * alone: `focus` fires when focus re-enters *this* frame, which misses an
   * alt-tab away and back if focus was elsewhere in the shell, and
   * `visibilitychange` mirrors the top-level document, which misses a move
   * between two visible windows.
   */
  useEffect(() => {
    const onFocus = () => poll();
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  return {
    tabs,
    activePath,
    dirty,
    open,
    activate,
    rename,
    close,
    unsavedUnder,
    dropUnder,
    setDirty,
    registerSave,
    saveActive,
  };
}
