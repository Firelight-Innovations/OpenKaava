/**
 * File Viewer — the tabs, and the pane they fill.
 *
 * This file is the join. It owns the two-region layout and the state that spans
 * them — which file is showing — and nothing else. The tab model is `tabs/`,
 * and what a file *looks* like is `viewer/registry.ts`. Each can be read
 * without reading this one.
 *
 * Four things used to be React props between a tree and a tab strip in one
 * component. They are messages now — `OPENED_EVENT` in, `ACTIVE_PATH` and
 * `DIRTY_PATHS` out, `TREE_CHANGE` both ways — and each is a listener or a
 * publish below rather than a line in someone's JSX.
 *
 * What it deliberately does not own, unchanged from before: the list of file
 * formats. Adding a viewer touches `viewer/registry.ts` and one new component,
 * and never this file.
 *
 * `viewMode` stays local: Code vs. Build steps (docs/KAAVA-UX-REWORK.md §8)
 * has nothing behind the second option yet.
 */
import { useCallback, useEffect, useState } from "react";
import { on, publish, reportPainted, subscribe, OPENED_EVENT } from "@openkaava/bridge";
import NoticeBar from "./NoticeBar";
import { useMenuCommands } from "./commands";
import { useDelete } from "./useDelete";
import SendToAgent from "./SendToAgent";
import TabStrip from "./tabs/TabStrip";
import { useOpenFiles } from "./tabs/useOpenFiles";
import Viewer from "./viewer/Viewer";
import PreviewToggle from "./preview/PreviewToggle";
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

  /**
   * Code vs. Build steps, per view rather than per tab: nothing builds the
   * diagram yet, so there is no state worth carrying from one open file to
   * the next. Falls back to Code whenever the active file changes, rather
   * than leaving a placeholder view stuck on screen for a file it was never
   * chosen for — see docs/KAAVA-UX-REWORK.md §8.
   */
  const [viewMode, setViewMode] = useState<"code" | "build-steps">("code");
  useEffect(() => setViewMode("code"), [files.activePath]);

  return (
    <div className="viewerapp">
      {error && <p className="app__error viewerapp__error">{error}</p>}

      <TabStrip
        tabs={files.tabs}
        activePath={files.activePath}
        dirty={files.dirty}
        rootPath={root?.path ?? null}
        onActivate={files.activate}
        onClose={files.close}
        // A rename started from a tab has no idea which folder it happened in,
        // so the Explorer is told to re-read whatever it has open. Heavier than
        // re-listing one directory, and the right trade for a path this app
        // takes rarely: the alternative is teaching this app to work out a
        // parent directory, which is the one thing a frontend must not do.
        onRenamed={(from, to) => {
          files.rename(from, to);
          publish(TREE_CHANGE, { kind: "renamed", from, to });
        }}
        onDelete={del.ask}
        trailing={
          active && (
            <>
              <PreviewToggle />
              <div
                className="k-tabs k-tabs--segmented viewerapp__mode"
                role="tablist"
                aria-label="Code or build steps"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "code"}
                  className="k-tab"
                  onClick={() => setViewMode("code")}
                >
                  Code
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "build-steps"}
                  className="k-tab"
                  onClick={() => setViewMode("build-steps")}
                  title="Not wired up yet. Planned: a step diagram for scripts like build_bed.py — frame, legs, materials, export, render — each step commentable like a Blender mesh part. See docs/KAAVA-UX-REWORK.md §8."
                >
                  Build steps
                  <span className="viewerapp__later">LATER</span>
                </button>
              </div>
            </>
          )
        }
      />

      {/* The delete confirmation, under the strip where every other question in
          this app appears. Escape answers it the same way Cancel does. */}
      {del.notice && <NoticeBar notice={del.notice} onEscape={del.cancel} />}

      {active && viewMode === "code" && (
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
      )}

      {active && viewMode === "build-steps" && (
        <p className="app__note viewerapp__buildsteps">
          Build steps isn&rsquo;t built yet. The plan is a step diagram for scripts like{" "}
          <code>build_bed.py</code> — frame, legs, materials, export, render — each step commentable
          the way a Blender mesh part is. See <code>docs/KAAVA-UX-REWORK.md</code> §8.
        </p>
      )}

      {/* Send to agent lives at the bottom, out of the way of the file: a slim
          footer on the region's own surface, like the terminal's Context strip.
          It used to be a toolbar row of its own above the tabs. */}
      {active && (
        <div className="viewerapp__footer">
          <SendToAgent
            path={active.path}
            rootPath={root?.path ?? null}
            dirty={files.dirty.has(active.path)}
            missing={active.missing === true}
            onError={setError}
          />
        </div>
      )}

      {!active && <p className="app__note viewerapp__empty">Select a file to open it.</p>}
    </div>
  );
}
