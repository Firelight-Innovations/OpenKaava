import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportPainted } from "@openkaava/bridge";
import { AlertTriangle, FilePlus2, Lock } from "lucide-react";
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
import { Autosaver, type SaveState } from "./saver";
import { signature, slugify, toSaved, uniqueId, type SceneFile } from "./scene";
import "./App.css";

// The editor is the bulk of this app's weight; load it only once a canvas is open.
const Editor = lazy(() => import("./Editor"));

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

      <main className="cv__body">
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
              onApi={() => {}}
            />
          </Suspense>
        ) : (
          <div className="cv__empty">Loading...</div>
        )}
      </main>
    </div>
  );
}
