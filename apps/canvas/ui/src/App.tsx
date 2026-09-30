import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportPainted } from "@openkaava/bridge";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AlertTriangle, ChevronRight, ExternalLink, FilePlus2, Link2Off, Lock } from "lucide-react";
import AssetList from "./AssetList";
import SpecPanel from "./SpecPanel";
import { selectedElement, specOf, withSpec, type SpecCard } from "./spec";
import {
  createCanvas,
  getState,
  isCorrupt,
  isExists,
  listCanvases,
  messageOf,
  readCanvas,
  staleWrite,
  statCanvas,
  writeCanvas,
  type CanvasDoc,
  type CanvasState,
  type CanvasSummary,
} from "./rpc";
import { ancestry, childId, childOf, selectedFrame, withChild } from "./nesting";
import { Autosaver, type SaveState } from "./saver";
import { signature, slugify, toSaved, uniqueId, type SceneElement, type SceneFile } from "./scene";
import "./App.css";

// The editor is the bulk of this app's weight; load it only once a canvas is open.
const Editor = lazy(() => import("./Editor"));

type View = "canvas" | "assets";

const SAVE_DELAY_MS = 700;
const POLL_MS = 2000;
const LAST_KEY = "canvas.last";

/** Best-effort: private windows and blocked storage throw. */
function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
function writeLast(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // Remembering the last canvas is a convenience.
  }
}

/** The shell's theme, which `onThemeChanged` writes to `<html data-theme>`. */
function useTheme(): "dark" | "light" {
  const read = (): "dark" | "light" =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const STATUS_TEXT: Record<SaveState, string> = {
  saved: "Saved",
  dirty: "Unsaved changes",
  saving: "Saving...",
  conflict: "Changed on disk",
  error: "Could not save",
};

export default function App() {
  const theme = useTheme();
  const [state, setState] = useState<CanvasState | null>(null);
  const [list, setList] = useState<CanvasSummary[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  /** Bumped to remount the editor with a freshly loaded scene. */
  const [loadKey, setLoadKey] = useState(0);
  const [loadError, setLoadError] = useState<{ message: string; corrupt: boolean } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveDetail, setSaveDetail] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [frame, setFrame] = useState<{ id: string; name: string; child: string | null } | null>(
    null,
  );
  const [childName, setChildName] = useState("");
  const [view, setView] = useState<View>("canvas");
  /** Bumped when a card is saved, so the asset list reads disk again. */
  const [assetsKey, setAssetsKey] = useState(0);
  const [pick, setPick] = useState<{ id: string; spec: Record<string, unknown> | null } | null>(
    null,
  );
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const saverRef = useRef<Autosaver | null>(null);
  const docRef = useRef<CanvasDoc | null>(null);
  docRef.current = doc;
  const readOnly = state?.readOnly ?? false;

  const refreshList = useCallback(async () => {
    try {
      const next = await listCanvases();
      setList(next);
      return next;
    } catch (err) {
      setLoadError({ message: messageOf(err), corrupt: false });
      setList((prev) => prev ?? []);
      return null;
    }
  }, []);

  // First contact: the environment's state and the canvases in it.
  useEffect(() => {
    void (async () => {
      try {
        setState(await getState());
      } catch (err) {
        setLoadError({ message: messageOf(err), corrupt: false });
      }
      const rows = await refreshList();
      if (rows && rows.length > 0) {
        const remembered = readLast();
        const pick =
          rows.find((r) => r.id === remembered && !r.error) ??
          rows.find((r) => !r.parent && !r.error) ??
          rows.find((r) => !r.error) ??
          rows[0]!;
        setCurrent(pick.id);
      }
      reportPainted();
    })();
  }, [refreshList]);

  // Load the chosen canvas and start a saver whose base is what was just read.
  const load = useCallback(async (id: string) => {
    saverRef.current?.dispose();
    saverRef.current = null;
    setLoadError(null);
    try {
      const next = await readCanvas(id);
      const saver = new Autosaver({
        delay: SAVE_DELAY_MS,
        write: async (scene, base) => (await writeCanvas(id, scene, base)).mtime,
        isStale: (err) => staleWrite(err) !== null,
        onState: (s, detail) => {
          setSaveState(s);
          setSaveDetail(detail);
        },
      });
      const s = next.scene;
      saver.setBase(next.mtime, signature(toSaved(s.elements, s.appState, s.files, s.kaava)));
      saverRef.current = saver;
      setDoc(next);
      setFrame(null);
      setPick(null);
      setNotice(null);
      setLoadKey((k) => k + 1);
      writeLast(id);
    } catch (err) {
      setDoc(null);
      setLoadError({ message: messageOf(err), corrupt: isCorrupt(err) });
    }
  }, []);

  useEffect(() => {
    if (current) void load(current);
  }, [current, load]);

  // Leaving a canvas, or the window, must not lose the last edit.
  useEffect(() => {
    const flush = () => void saverRef.current?.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // Notice edits made outside this pane: a `git pull`, or an agent writing the
  // file. Unchanged since our own last write means nothing to do; changed with
  // no unsaved work means reload; changed with unsaved work is left to the
  // saver, whose next write is refused as stale and raises the conflict banner.
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const saver = saverRef.current;
      if (!saver) return;
      void statCanvas(current)
        .then(({ mtime }) => {
          if (saverRef.current !== saver || mtime === saver.mtime) return;
          if (saver.hasUnsaved) return;
          void refreshList();
          void load(current);
        })
        .catch(() => {
          // A failed stat is retried on the next tick.
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [current, load, refreshList]);

  const onEditorChange = useCallback(
    (
      elements: Parameters<typeof toSaved>[0],
      appState: Record<string, unknown>,
      files: Record<string, unknown>,
    ) => {
      const picked = selectedFrame(
        elements as readonly SceneElement[],
        appState.selectedElementIds as Record<string, unknown> | undefined,
      );
      const next = picked
        ? { id: picked.id, name: String(picked.name ?? ""), child: childOf(picked) }
        : null;
      setFrame((prev) =>
        prev?.id === next?.id && prev?.child === next?.child && prev?.name === next?.name
          ? prev
          : next,
      );
      const one = selectedElement(
        elements as readonly SceneElement[],
        appState.selectedElementIds as Record<string, unknown> | undefined,
      );
      const spec = one ? specOf(one) : null;
      setPick((prev) =>
        prev?.id === one?.id && JSON.stringify(prev?.spec) === JSON.stringify(spec)
          ? prev
          : one
            ? { id: one.id, spec }
            : null,
      );
      const saver = saverRef.current;
      const open = docRef.current;
      if (!saver || !open || readOnly) return;
      const scene = toSaved(elements, appState, files, open.scene.kaava);
      saver.schedule(scene, signature(scene));
    },
    [readOnly],
  );

  const switchTo = useCallback(async (id: string) => {
    await saverRef.current?.flush();
    setCurrent(id);
  }, []);

  /** Open a linked canvas, if it exists; a link to one that is not there
   *  (deleted, or not pulled yet) says so and leaves the drawing where it is. */
  const openChild = useCallback(
    async (id: string) => {
      const rows = (await refreshList()) ?? list ?? [];
      if (!rows.some((r) => r.id === id)) {
        setNotice(
          `The linked canvas "${id}" does not exist in this checkout. Pull, or unlink the frame.`,
        );
        return;
      }
      setNotice(null);
      await switchTo(id);
    },
    [list, refreshList, switchTo],
  );

  /** Replace one element in the live scene and write it now, so the link is on
   *  disk before the view moves to the child. */
  const patchElement = useCallback(async (id: string, edit: (el: SceneElement) => SceneElement) => {
    const api = apiRef.current;
    const saver = saverRef.current;
    const open = docRef.current;
    if (!api || !saver || !open) return;
    const elements = (api.getSceneElementsIncludingDeleted() as unknown as SceneElement[]).map(
      (el) => (el.id === id ? edit(el) : el),
    );
    api.updateScene({ elements: elements as never });
    const scene = toSaved(
      elements,
      api.getAppState() as unknown as Record<string, unknown>,
      api.getFiles() as unknown as Record<string, unknown>,
      open.scene.kaava,
    );
    saver.schedule(scene, signature(scene));
    await saver.flush();
  }, []);

  const createChild = useCallback(async () => {
    const open = docRef.current;
    if (!frame || !open) return;
    const title = (childName.trim() || frame.name || "Child canvas").trim();
    const taken = new Set((list ?? []).map((r) => r.id));
    const id = uniqueId(childId(open.id, slugify(title) || "canvas"), taken);
    try {
      await createCanvas(id, title, open.id);
      await patchElement(frame.id, (el) => withChild(el, id));
      setChildName("");
      await refreshList();
      await switchTo(id);
    } catch (err) {
      setNotice(messageOf(err));
    }
  }, [childName, frame, list, patchElement, refreshList, switchTo]);

  const unlinkChild = useCallback(async () => {
    if (!frame) return;
    await patchElement(frame.id, (el) => withChild(el, null));
  }, [frame, patchElement]);

  const saveCard = useCallback(
    async (card: SpecCard) => {
      if (!pick) return;
      await patchElement(pick.id, (el) => withSpec(el, card));
      setPick({ id: pick.id, spec: { ...card } });
      setAssetsKey((k) => k + 1);
    },
    [patchElement, pick],
  );

  const removeCard = useCallback(async () => {
    if (!pick) return;
    await patchElement(pick.id, (el) => withSpec(el, null));
    setPick({ id: pick.id, spec: null });
    setAssetsKey((k) => k + 1);
  }, [patchElement, pick]);

  const showAssets = useCallback(async () => {
    await saverRef.current?.flush();
    setAssetsKey((k) => k + 1);
    setView("assets");
  }, []);

  const openFromList = useCallback(
    async (id: string) => {
      setView("canvas");
      if (id !== current) await switchTo(id);
    },
    [current, switchTo],
  );

  const chain = useMemo(() => (current ? ancestry(list ?? [], current) : []), [current, list]);

  const takenIds = useMemo(() => new Set((list ?? []).map((r) => r.id)), [list]);

  const create = useCallback(async () => {
    const title = draftName.trim();
    if (!title) return;
    const id = uniqueId(slugify(title), takenIds);
    setCreateError(null);
    try {
      await saverRef.current?.flush();
      await createCanvas(id, title);
      await refreshList();
      setCreating(false);
      setDraftName("");
      setCurrent(id);
    } catch (err) {
      setCreateError(isExists(err) ? "A canvas with that name already exists." : messageOf(err));
    }
  }, [draftName, refreshList, takenIds]);

  const reloadFromDisk = useCallback(() => {
    if (current) void load(current);
  }, [current, load]);

  const keepMine = useCallback(async () => {
    if (!current) return;
    try {
      const { mtime } = await statCanvas(current);
      await saverRef.current?.overwrite(mtime);
    } catch (err) {
      setSaveDetail(messageOf(err));
    }
  }, [current]);

  const empty = list !== null && list.length === 0;
  const createForm = (
    <form
      className="cv__create"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <input
        className="cv__input"
        autoFocus
        placeholder="Canvas name, e.g. Hospital wing"
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        aria-label="Canvas name"
      />
      <code className="cv__path">
        {state?.dir ?? "canvas"}/{uniqueId(slugify(draftName), takenIds)}.json
      </code>
      <button type="submit" className="k-btn k-btn--primary k-btn--sm" disabled={!draftName.trim()}>
        Create
      </button>
      {!empty && (
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--sm"
          onClick={() => {
            setCreating(false);
            setCreateError(null);
          }}
        >
          Cancel
        </button>
      )}
      {createError && (
        <span className="cv__error" role="alert">
          {createError}
        </span>
      )}
    </form>
  );

  return (
    <div className="app cv">
      <header className="cv__header">
        <select
          className="cv__select"
          aria-label="Canvas"
          value={current ?? ""}
          disabled={!list || list.length === 0}
          onChange={(e) => void switchTo(e.target.value)}
        >
          {(list ?? []).map((row) => (
            <option key={row.id} value={row.id}>
              {row.error ? `${row.title} (unreadable)` : row.title}
            </option>
          ))}
          {empty && <option value="">No canvases yet</option>}
        </select>
        <div className="cv__tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={view === "canvas"}
            className={`cv__tab${view === "canvas" ? " is-on" : ""}`}
            onClick={() => setView("canvas")}
          >
            Canvas
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "assets"}
            className={`cv__tab${view === "assets" ? " is-on" : ""}`}
            onClick={() => void showAssets()}
          >
            Asset list
          </button>
        </div>
        {chain.length > 1 && (
          <nav className="cv__crumbs" aria-label="Canvas path">
            {chain.map((row, i) => (
              <span key={row.id} className="cv__crumb">
                {i > 0 && <ChevronRight size={12} aria-hidden />}
                {i === chain.length - 1 ? (
                  <span aria-current="page">{row.title}</span>
                ) : (
                  <button
                    type="button"
                    className="cv__crumb-link"
                    onClick={() => void switchTo(row.id)}
                  >
                    {row.title}
                  </button>
                )}
              </span>
            ))}
          </nav>
        )}
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          onClick={() => setCreating((c) => !c)}
          disabled={readOnly || !state?.hasEnvironment}
          title={readOnly ? "Main is read-only. Open a worktree to draw." : "New canvas"}
        >
          <FilePlus2 size={14} aria-hidden /> New canvas
        </button>
        {doc && <code className="cv__path">{doc.path}</code>}
        <span className="cv__spacer" />
        {readOnly ? (
          <span className="k-badge k-badge--idle">
            <Lock size={12} aria-hidden /> Read-only
          </span>
        ) : (
          doc && (
            <span
              className={`cv__status cv__status--${saveState}`}
              role="status"
              title={saveDetail}
            >
              {STATUS_TEXT[saveState]}
            </span>
          )
        )}
      </header>

      {creating && !empty && createForm}

      {readOnly && (
        <p className="cv__notice">
          This is the main checkout, which is read-only here. You can look at canvases; drawing
          needs a worktree.
        </p>
      )}

      {saveState === "conflict" && (
        <div className="cv__notice cv__notice--warn" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>
            This canvas changed on disk (a pull, or another writer) while you were editing.
          </span>
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            onClick={reloadFromDisk}
          >
            Load the disk version
          </button>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            onClick={() => void keepMine()}
          >
            Keep mine
          </button>
        </div>
      )}
      {saveState === "error" && (
        <div className="cv__notice cv__notice--warn" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>Could not save: {saveDetail}. Your next change will try again.</span>
        </div>
      )}

      {notice && (
        <div className="cv__notice cv__notice--warn" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>{notice}</span>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            onClick={() => setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {view === "assets" && (
        <AssetList refreshKey={assetsKey} onOpen={(id) => void openFromList(id)} />
      )}

      <main className="cv__body" hidden={view !== "canvas"}>
        {doc && frame && (frame.child || !readOnly) && (
          <aside className="cv__frame" aria-label="Frame link">
            {frame.child ? (
              <>
                <span className="cv__frame-label">
                  Child canvas <code>{frame.child}</code>
                </span>
                <button
                  type="button"
                  className="k-btn k-btn--primary k-btn--sm"
                  onClick={() => void openChild(frame.child!)}
                >
                  <ExternalLink size={14} aria-hidden /> Open
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    className="k-btn k-btn--ghost k-btn--sm"
                    onClick={() => void unlinkChild()}
                  >
                    <Link2Off size={14} aria-hidden /> Unlink
                  </button>
                )}
              </>
            ) : (
              <form
                className="cv__frame-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createChild();
                }}
              >
                <input
                  className="cv__input"
                  aria-label="Child canvas name"
                  placeholder={frame.name || "Child canvas name"}
                  value={childName}
                  onChange={(e) => setChildName(e.target.value)}
                />
                <button type="submit" className="k-btn k-btn--secondary k-btn--sm">
                  Create child canvas
                </button>
              </form>
            )}
          </aside>
        )}
        {doc && pick && (pick.spec || !readOnly) && (
          <SpecPanel
            key={`${doc.id}:${loadKey}:${pick.id}`}
            stored={pick.spec}
            readOnly={readOnly}
            onSave={(card) => void saveCard(card)}
            onRemove={() => void removeCard()}
          />
        )}
        {loadError ? (
          <div className="cv__empty" role="alert">
            <AlertTriangle size={20} aria-hidden />
            <p>{loadError.message}</p>
            {loadError.corrupt && (
              <p className="cv__hint">
                The file was not touched. Fix or restore it in git, or pick another canvas.
              </p>
            )}
          </div>
        ) : empty ? (
          <div className="cv__empty">
            <p>
              {readOnly
                ? "There are no canvases in this checkout, and main is read-only."
                : "No canvases in this environment yet."}
            </p>
            {!readOnly && state?.hasEnvironment && createForm}
            {!state?.hasEnvironment && state && <p className="cv__hint">Open a project first.</p>}
          </div>
        ) : doc ? (
          <Suspense fallback={<div className="cv__empty">Loading the editor...</div>}>
            <Editor
              key={`${doc.id}:${loadKey}`}
              initial={doc.scene as SceneFile}
              theme={theme}
              readOnly={readOnly}
              onChange={onEditorChange}
              onApi={(api) => {
                apiRef.current = api;
              }}
              onOpenChild={(id) => void openChild(id)}
            />
          </Suspense>
        ) : (
          <div className="cv__empty">Loading...</div>
        )}
      </main>
    </div>
  );
}
