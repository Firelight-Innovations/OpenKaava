/**
 * File Viewer — one file, and the pane it fills.
 *
 * Opening another file opens another viewer as a pane tab (the shell routes
 * that; see `src/shell/viewerSubjects.ts`), so there is no tab row here. This
 * app tells the shell which file it has, and floats the Code / Preview / Steps
 * switch over the editor.
 *
 * This file is the join. The open-file model is `tabs/useOpenFiles.ts` (a list,
 * only ever asked for one entry), and what a file looks like is
 * `viewer/registry.ts`; adding a format never touches this file.
 *
 * What used to be props between a tree and a tab strip is messages now:
 * `OPENED_EVENT` in, `ACTIVE_PATH` and `DIRTY_PATHS` out, `TREE_CHANGE` both ways.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke, on, publish, reportPainted, subscribe, OPENED_EVENT } from "@openkaava/bridge";
import NoticeBar from "./NoticeBar";
import { useMenuCommands } from "./commands";
import { useDelete } from "./useDelete";
import SendToAgent from "./SendToAgent";
import { SendFooter } from "../../../shared/SendFooter";
import { useOpenFiles } from "./tabs/useOpenFiles";
import Viewer from "./viewer/Viewer";
import ModeSwitch from "./ModeSwitch";
import type { ViewMode } from "./modeRules";
import { loadSettings } from "./settings";
import { ACTIVE_PATH, DIRTY_PATHS, TREE_CHANGE, asTreeChange } from "./topics";
import { describe, getRoot, type Root } from "./rpc";

export default function App() {
  const [root, setRoot] = useState<Root | null>(null);
  const [error, setError] = useState<string | null>(null);

  const files = useOpenFiles();

  /**
   * The project root, for the tab strip's relative paths. Read here rather than
   * passed in because this app is rooted the same way the Explorer is —
   * `files/root` is answered against whichever cluster the shell resolved this
   * frame into, so two Viewers in two clusters get two answers without either
   * of them asking a different question.
   */
  const loadRoot = useCallback(() => {
    void getRoot()
      .then((next) => {
        setRoot(next);
        setError(null);
      })
      .catch((err: unknown) => setError(describe("files/root", err)));
  }, []);

  useEffect(loadRoot, [loadRoot]);

  /**
   * The project changed under us — a different folder is open in this cluster.
   * Open tabs are left alone rather than closed, unchanged from when this was
   * half of Files: a file still on disk is still readable, and closing someone's
   * editor because they switched projects would lose work to a guess about
   * intent. Only the root is re-read, for the tab strip's paths.
   */
  useEffect(() => on("project:changed", loadRoot), [loadRoot]);

  /**
   * Someone asked for a file to be put on screen.
   *
   * The Explorer's click, the search overlay's Enter key, and — later — the
   * source control view's. None of them named this instance: each asked the
   * shell for a viewer in its own cluster, and the shell picked. See
   * `docs/tool-protocol.md` §3.
   *
   * `preview` is VS Code's single click, and `tabs/useOpenFiles.ts` is what
   * gives it meaning: the file opens in one replaceable slot that the next peek
   * takes over, unless something has been typed into it. The gesture that
   * decided is the sender's to interpret — a tree row click is a peek, a search
   * hit is not — so this end reads the flag and does not second-guess it.
   */
  useEffect(
    () =>
      on(OPENED_EVENT, (payload) => {
        const request = payload as { path?: unknown; preview?: unknown } | null;
        if (typeof request?.path !== "string") return;
        files.open(request.path, request.preview === true);
      }),
    [files],
  );

  /**
   * A rename or a delete landed on disk, wherever it was started. The
   * Explorer's tree is the usual source, but this app publishes the same topic
   * when a delete is confirmed from a tab, so a second Viewer in the cluster
   * closes its tab too. The shell excludes a publisher from its own broadcast,
   * so nothing here can hear itself.
   *
   * `rename` must run before anything polls: a tab still pointing at the old
   * path would `stat`, find nothing, and mark itself missing — a phantom
   * "deleted" tab for a file that is perfectly fine.
   */
  useEffect(
    () =>
      subscribe(TREE_CHANGE, (value) => {
        const change = asTreeChange(value);
        if (!change) return;
        if (change.kind === "renamed") files.rename(change.from, change.to);
        else files.dropUnder(change.path);
      }),
    [files],
  );

  /**
   * Which file is showing, and what is unsaved — announced rather than asked
   * for, and this app does not know whether anyone is listening. The dirty list
   * is the repair for the one thing the split genuinely took away: a delete
   * confirmation raised in the Explorer can still name work that only exists
   * here.
   *
   * Both are de-duplicated inside the bridge against the last value sent, which
   * is what makes it safe to call them from an effect that runs on every render.
   * `activePath` is published as `null` when nothing is open, because that is
   * true and because a retained stale path would leave a row highlighted in a
   * tree under a closed editor. The dirty list is sorted so two renders
   * producing the same set in a different order do not read as a change — the
   * same reasoning `declareCommands` gives for sorting before it compares.
   */
  useEffect(() => {
    publish(ACTIVE_PATH, files.activePath);
  }, [files.activePath]);

  useEffect(() => {
    publish(DIRTY_PATHS, [...files.dirty].sort());
  }, [files.dirty]);

  /**
   * The splash window waits for this pane before the main window is shown — but
   * only when a Viewer is in the restored layout, since `boot::expected` narrows
   * the roster to what is actually open.
   *
   * Reported once the first render is committed, including the empty one. An
   * empty viewer is a *finished* screen: no call in flight and no version of it
   * that looks more complete, the same reason `apps/README.md` gives for an
   * error state counting.
   */
  useEffect(reportPainted, []);

  /**
   * Ctrl+S at the document level, so it works with focus anywhere in the app.
   * Monaco binds its own inside the editor and wins there; this catches focus in
   * the tab strip, and both reach the same `save`. `ctrlKey` alone: `metaKey` is
   * the Windows key, and `shell/accelerators.ts` says why the shell refuses it.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== "s") return;
      event.preventDefault();
      void files.saveActive().catch((err: unknown) => setError(describe("files/write", err)));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [files]);

  /**
   * The delete confirmation for a delete started from a tab. This app can still
   * answer the question it always could — it is the side that knows about open
   * buffers — and it tells everyone else afterwards rather than before:
   * `TREE_CHANGE` is published on success so the Explorer re-lists and any
   * other Viewer closes its tabs.
   */
  const del = useDelete({
    unsavedUnder: files.unsavedUnder,
    dropUnder: files.dropUnder,
    onDeleted: (target) => publish(TREE_CHANGE, { kind: "deleted", path: target.path }),
  });

  useMenuCommands({
    files,
    askDelete: del.ask,
    onTreeChanged: (from, to) => publish(TREE_CHANGE, { kind: "renamed", from, to }),
    onError: setError,
  });

  const active = files.tabs.find((tab) => tab.path === files.activePath) ?? null;
  const activeDirty = active !== null && files.dirty.has(active.path);

  /**
   * One file per viewer. The shell only ever sends this instance the file it
   * has, or a peek that replaces it, so a second tab can only be left over — a
   * peek that was dirty when the next one arrived. Anything clean that is not
   * the file on screen is closed; unsaved work is never discarded here.
   */
  useEffect(() => {
    for (const tab of files.tabs) {
      if (tab.path !== files.activePath && !files.dirty.has(tab.path)) files.close(tab.path);
    }
  }, [files]);

  /**
   * Tell the shell which file this is, so the pane tab can be named for it and
   * wear its icon, and so a second request for the same file focuses this
   * viewer rather than opening another. `preview` is false once there are edits:
   * a peek with unsaved work must not be taken over.
   */
  const activeName = active?.name ?? null;
  const activePath = active?.path ?? null;
  const activePreview = active?.preview ?? false;
  const hadFile = useRef(false);
  useEffect(() => {
    if (activeName === null || activePath === null) {
      // Back to empty: the shell must forget the old file, or this viewer is
      // never offered the next one. Not sent on mount, which would race a restore.
      if (hadFile.current) {
        hadFile.current = false;
        void invoke("kaava/title", { title: "File Viewer", subject: null }).catch(() => {});
      }
      return;
    }
    hadFile.current = true;
    void invoke("kaava/title", {
      title: activeName,
      subject: activePath,
      preview: activePreview && !activeDirty,
      dirty: activeDirty,
    }).catch(() => {});
  }, [activeName, activePath, activePreview, activeDirty]);

  /**
   * Code vs. Steps, per view rather than per file: nothing builds the diagram
   * yet, so there is no state worth carrying. The viewer stays mounted under
   * the placeholder, so the preview control survives a visit to Steps and
   * Monaco keeps its scroll and undo history.
   */
  const [viewMode, setViewMode] = useState<ViewMode>("code");
  useEffect(() => setViewMode("code"), [files.activePath]);

  /**
   * How far from the right edge the floating switch sits: past the scrollbar,
   * and past the minimap when the editor draws one. Read once; the setting
   * applies on next launch (see `settings.ts`).
   */
  const [floatRight, setFloatRight] = useState(28);
  useEffect(() => {
    let live = true;
    void loadSettings().then((settings) => {
      if (live && settings.toggle("editor.minimap", true)) setFloatRight(112);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="viewerapp">
      {error && <p className="app__error viewerapp__error">{error}</p>}

      {active?.notice && <NoticeBar notice={active.notice} />}

      {/* The delete confirmation, under the strip where every other question in
          this app appears. Escape answers it the same way Cancel does. */}
      {del.notice && <NoticeBar notice={del.notice} onEscape={del.cancel} />}

      {active && (
        <div
          className="viewerapp__body"
          style={{ "--viewer-float-right": `${floatRight}px` } as CSSProperties}
        >
          <div className="viewerapp__file" hidden={viewMode !== "code"}>
            <Viewer
              // The nonce is in the key so an external reload remounts the viewer
              // and it re-reads from disk. The path alone would not: reloading the
              // same file is not a different file.
              key={`${active.path}:${active.nonce}`}
              file={active}
              onDirty={(dirty) => files.setDirty(active.path, dirty)}
              registerSave={(save) => files.registerSave(active.path, save)}
              openPath={(path) => files.open(path, false)}
            />
          </div>

          {viewMode === "steps" && (
            <p className="app__note viewerapp__steps">
              Steps isn&rsquo;t built yet. The plan is a step diagram for scripts like{" "}
              <code>build_bed.py</code> — frame, legs, materials, export, render — each step
              commentable the way a Blender mesh part is. See <code>docs/KAAVA-UX-REWORK.md</code>{" "}
              §8.
            </p>
          )}

          <ModeSwitch view={viewMode} onView={setViewMode} />
        </div>
      )}

      {/* Send to agent lives at the bottom, out of the way of the file: a slim
          footer on the region's own surface, like the terminal's Context strip.
          It used to be a toolbar row of its own above the tabs. */}
      {active && (
        <SendFooter>
          <SendToAgent
            path={active.path}
            rootPath={root?.path ?? null}
            dirty={files.dirty.has(active.path)}
            missing={active.missing === true}
            onError={setError}
          />
        </SendFooter>
      )}

      {!active && <p className="app__note viewerapp__empty">Select a file to open it.</p>}
    </div>
  );
}
