import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportPainted } from "@openkaava/bridge";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AlertTriangle, ChevronRight, ExternalLink, FilePlus2, Link2Off, Lock } from "lucide-react";
import { SendButton, SendFooter } from "../../../shared/SendFooter";
import {
  dragContext,
  exportSelectionPng,
  putSelectionImage,
  putSpecCard,
  selectedCount,
  selectionElements,
} from "./sendToAgent";
import AssetList from "./AssetList";
import SpecPanel from "./SpecPanel";
import Sidebar, { type SideTab } from "./Sidebar";
import CommentsPanel, { type CommentTarget } from "./CommentsPanel";
import { setEditorHooks } from "./agentBridge";
import {
  framesIn,
  frameForKey,
  regionTarget,
  selectionTarget,
  type Box,
  type FrameRow,
} from "./review";
import { selectedElement, specOf, withSpec, type SpecCard } from "./spec";
import {
  createCanvas,
  getState,
  isCorrupt,
  isExists,
  listCanvases,
  listRefs,
  messageOf,
  readCanvas,
  staleWrite,
  statCanvas,
  writeCanvas,
  type CanvasDoc,
  type CanvasState,
  type CanvasComment,
  type CanvasSummary,
  type RefRow,
} from "./rpc";
import { ancestry, childId, childOf, selectedFrame, viewportToScene, withChild } from "./nesting";
import { Autosaver, type SaveState } from "./saver";
import { signature, slugify, toSaved, uniqueId, type SceneElement, type SceneFile } from "./scene";
import "./App.css";

// The editor is the bulk of this app's weight; load it only once a canvas is open.
const Editor = lazy(() => import("./Editor"));

type View = "canvas" | "assets";

const SAVE_DELAY_MS = 700;
const POLL_MS = 2000;
const LAST_KEY = "canvas.last";
const SIDE_KEY = "canvas.side";

function readSide(): { tab: SideTab; collapsed: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDE_KEY) ?? "null") as {
      tab?: unknown;
      collapsed?: unknown;
    } | null;
    const tab = raw?.tab;
    return {
      tab: tab === "diagrams" || tab === "comments" ? tab : "inspector",
      collapsed: raw?.collapsed === true,
    };
  } catch {
    return { tab: "inspector", collapsed: false };
  }
}
function writeSide(side: { tab: SideTab; collapsed: boolean }): void {
  try {
    localStorage.setItem(SIDE_KEY, JSON.stringify(side));
  } catch {
    // The panel layout is a convenience.
  }
}

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
  const [sendSlot, setSendSlot] = useState<HTMLElement | null>(null);
  const [frame, setFrame] = useState<{ id: string; name: string; child: string | null } | null>(
    null,
  );
  const [childName, setChildName] = useState("");
  const [view, setView] = useState<View>("canvas");
  /** How many elements are selected: what "Send selection" would send. */
  const [selectedN, setSelectedN] = useState(0);
  const [sentSelection, setSentSelection] = useState(false);
  /** Bumped when a card is saved, so the asset list reads disk again. */
  const [assetsKey, setAssetsKey] = useState(0);
  const [pick, setPick] = useState<{ id: string; spec: Record<string, unknown> | null } | null>(
    null,
  );
  const [side, setSide] = useState(readSide);
  const [frames, setFrames] = useState<FrameRow[]>([]);
  const [refs, setRefs] = useState<RefRow[]>([]);
  const [openComments, setOpenComments] = useState(0);
  const [commentsKey, setCommentsKey] = useState(0);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  /** The area picker: null when off, else the drag so far in stage pixels. */
  const [picking, setPicking] = useState<
    { from: [number, number]; to: [number, number] } | "idle" | null
  >(null);
  /** The editor's last report, for the agent hooks and the comment targets. */
  const liveRef = useRef<{
    elements: readonly SceneElement[];
    selected: Record<string, unknown> | undefined;
  }>({ elements: [], selected: undefined });
  const stageRef = useRef<HTMLDivElement | null>(null);
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
      setFrames(framesIn(s.elements));
      setCommentTarget(null);
      setTargetError(null);
      setPicking(null);
      setFrame(null);
      setPick(null);
      setSelectedN(0);
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
      liveRef.current = {
        elements: elements as readonly SceneElement[],
        selected: appState.selectedElementIds as Record<string, unknown> | undefined,
      };
      const rows = framesIn(elements as readonly SceneElement[]);
      setFrames((prev) => (JSON.stringify(prev) === JSON.stringify(rows) ? prev : rows));
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
      setSelectedN(
        selectedCount(appState.selectedElementIds as Record<string, unknown> | undefined),
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

  /** The selection rendered as a PNG and put in the agent's context. */
  const putSelection = useCallback(async () => {
    const api = apiRef.current;
    const open = docRef.current;
    if (!api || !open) throw new Error("no canvas is open");
    const state = api.getAppState() as unknown as Record<string, unknown>;
    const elements = selectionElements(
      api.getSceneElementsIncludingDeleted() as unknown as SceneElement[],
      state.selectedElementIds as Record<string, unknown> | undefined,
    );
    if (elements.length === 0) throw new Error("nothing is selected");
    const png = await exportSelectionPng({
      elements,
      appState: state,
      files: api.getFiles() as unknown as Record<string, unknown>,
      dark: theme === "dark",
    });
    return putSelectionImage(png, open.scene.kaava?.title || open.id, elements.length);
  }, [theme]);

  const sendSelection = useCallback(() => {
    setNotice(null);
    putSelection().then(
      () => {
        setSentSelection(true);
        setTimeout(() => setSentSelection(false), 1800);
      },
      (err: unknown) => setNotice(`Couldn't send the selection to the agent: ${messageOf(err)}`),
    );
  }, [putSelection]);

  const putCard = useCallback(
    (name: string, json: string) => putSpecCard(name, docRef.current?.path ?? "", json),
    [],
  );

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

  const setSideTab = useCallback((tab: SideTab) => {
    setSide((s) => {
      const next = { ...s, tab };
      writeSide(next);
      return next;
    });
  }, []);
  const setSideCollapsed = useCallback((collapsed: boolean) => {
    setSide((s) => {
      const next = { ...s, collapsed };
      writeSide(next);
      return next;
    });
  }, []);

  // What the panels list besides the drawing: stored reference images, and
  // how many comments are open (for the tab's badge).
  useEffect(() => {
    if (!doc) return;
    let stale = false;
    listRefs(doc.id).then(
      (r) => !stale && setRefs(r.refs),
      () => !stale && setRefs([]),
    );
    setCommentsKey((k) => k + 1);
    return () => {
      stale = true;
    };
  }, [doc]);

  /** Scroll the editor to some elements and select them. */
  const reveal = useCallback((ids: string[], fit: string[] = ids) => {
    const api = apiRef.current;
    if (!api) return;
    const all = api.getSceneElements() as unknown as SceneElement[];
    const targets = all.filter((e) => fit.includes(e.id));
    if (ids.length) {
      api.updateScene({
        appState: { selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])) } as never,
      });
    }
    if (targets.length)
      api.scrollToContent(targets as never, { fitToContent: true, animate: true });
  }, []);

  const goToFrame = useCallback((elementId: string) => reveal([elementId]), [reveal]);

  const openDiagram = useCallback(
    (id: string) => {
      const api = apiRef.current;
      const el = api ? frameForKey(api.getSceneElements() as unknown as SceneElement[], id) : null;
      if (el) reveal([el.id]);
      else setNotice(`There is no diagram "${id}" on this canvas.`);
    },
    [reveal],
  );

  const frameTitle = useCallback(
    (key: string) => {
      const row = frames.find((f) => f.diagramId === key || f.elementId === key);
      return row?.title ?? key;
    },
    [frames],
  );

  const commentOnSelection = useCallback(() => {
    const got = selectionTarget(liveRef.current.elements, liveRef.current.selected);
    if ("error" in got) {
      setTargetError(got.error);
      setCommentTarget(null);
    } else {
      setTargetError(null);
      setCommentTarget(got);
    }
  }, []);

  const showComment = useCallback(
    (c: CanvasComment) => {
      const api = apiRef.current;
      if (!api) return;
      const all = api.getSceneElements() as unknown as SceneElement[];
      const frameEl = frameForKey(all, c.frameId);
      const present = c.elementIds.filter((id) => all.some((e) => e.id === id));
      if (present.length) reveal(present);
      else if (frameEl) reveal([], [frameEl.id]);
      else setNotice(`The frame this comment is on ("${c.frameId}") is no longer on the canvas.`);
    },
    [reveal],
  );

  const flushNow = useCallback(async () => {
    await saverRef.current?.flush();
  }, []);

  /** The dragged box, from stage pixels to a frame and a frame-relative region. */
  const finishPick = useCallback((from: [number, number], to: [number, number]) => {
    const api = apiRef.current;
    const stage = stageRef.current;
    setPicking(null);
    if (!api || !stage) return;
    const view = api.getAppState() as unknown as Parameters<typeof viewportToScene>[2];
    const rect = stage.getBoundingClientRect();
    const a = viewportToScene(rect.left + from[0], rect.top + from[1], view);
    const b = viewportToScene(rect.left + to[0], rect.top + to[1], view);
    const drag: Box = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    const got = regionTarget(liveRef.current.elements, drag);
    if ("error" in got) {
      setTargetError(got.error);
      setCommentTarget(null);
    } else {
      setTargetError(null);
      setCommentTarget(got);
    }
  }, []);

  // Escape leaves the area picker.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicking(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  // What Rust's canvas methods and the agent server's `context` tool ask the
  // open editor: which canvas, flush now, and what is selected.
  useEffect(() => {
    setEditorHooks({
      currentId: () => docRef.current?.id ?? null,
      flush: async () => {
        const saver = saverRef.current;
        if (!saver) return { saved: false, mtime: null };
        await saver.flush();
        return { saved: !saver.hasUnsaved, mtime: saver.mtime ?? null };
      },
      selection: () => {
        const { elements, selected } = liveRef.current;
        const ids = Object.keys(selected ?? {}).filter((k) => selected?.[k]);
        const got = selectionTarget(elements, selected);
        const frameEl = "error" in got ? null : elements.find((e) => e.id === got.frameId);
        const diagram = frameEl ? (framesIn([frameEl])[0]?.diagramId ?? frameEl.id) : null;
        return { elementIds: ids, diagram };
      },
    });
    return () => setEditorHooks(null);
  }, []);

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
        <div className="cv__stage" ref={stageRef}>
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
                onOpenDiagram={openDiagram}
              />
            </Suspense>
          ) : (
            <div className="cv__empty">Loading...</div>
          )}
          {picking && (
            <div
              className="cv__pick"
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const p: [number, number] = [e.clientX - r.left, e.clientY - r.top];
                e.currentTarget.setPointerCapture(e.pointerId);
                setPicking({ from: p, to: p });
              }}
              onPointerMove={(e) => {
                if (picking === "idle") return;
                const r = e.currentTarget.getBoundingClientRect();
                setPicking({ from: picking.from, to: [e.clientX - r.left, e.clientY - r.top] });
              }}
              onPointerUp={() => {
                if (picking !== "idle") finishPick(picking.from, picking.to);
              }}
            >
              <span className="cv__pick-hint">
                Drag a box around what the comment is about. Esc cancels.
              </span>
              {picking !== "idle" && (
                <span
                  className="cv__pick-box"
                  style={{
                    left: Math.min(picking.from[0], picking.to[0]),
                    top: Math.min(picking.from[1], picking.to[1]),
                    width: Math.abs(picking.to[0] - picking.from[0]),
                    height: Math.abs(picking.to[1] - picking.from[1]),
                  }}
                />
              )}
            </div>
          )}
        </div>
        {doc && !loadError && (
          <Sidebar
            tab={side.tab}
            onTab={setSideTab}
            collapsed={side.collapsed}
            onCollapsed={setSideCollapsed}
            openComments={openComments}
          >
            {side.tab === "diagrams" && (
              <section className="cv__side-section" aria-label="Diagrams">
                {frames.length === 0 ? (
                  <p className="cv__hint">
                    No diagrams yet. Press F and drag around a drawing to make it one, or ask an
                    agent to draw one.
                  </p>
                ) : (
                  <ul className="cv__list">
                    {frames.map((f) => (
                      <li key={f.elementId}>
                        <button
                          type="button"
                          className="cv__list-item"
                          onClick={() => goToFrame(f.elementId)}
                        >
                          <span>{f.title}</span>
                          <span className="cv__meta">
                            {[f.level, f.diagramId ?? "unnamed frame"].filter(Boolean).join(" · ")}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            {side.tab === "comments" && (
              <CommentsPanel
                canvasId={doc.id}
                readOnly={readOnly}
                refreshKey={commentsKey}
                target={commentTarget}
                targetError={targetError}
                canUseSelection={selectedN > 0}
                onUseSelection={commentOnSelection}
                onPickArea={() => {
                  setTargetError(null);
                  setPicking("idle");
                }}
                onClearTarget={() => {
                  setCommentTarget(null);
                  setTargetError(null);
                }}
                frameTitle={frameTitle}
                flush={flushNow}
                onShow={showComment}
                onCounts={setOpenComments}
              />
            )}
            {side.tab === "inspector" && (
              <>
                {frame && (frame.child || !readOnly) && (
                  <section className="cv__frame cv__side-section" aria-label="Frame link">
                    <h3>Frame</h3>
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
                  </section>
                )}
                {pick && (pick.spec || !readOnly) && (
                  <SpecPanel
                    key={`${doc.id}:${loadKey}:${pick.id}`}
                    stored={pick.spec}
                    readOnly={readOnly}
                    onSave={(card) => void saveCard(card)}
                    onRemove={() => void removeCard()}
                    putCard={putCard}
                    onSendError={setNotice}
                    sendSlot={sendSlot}
                    refs={refs.map((r) => ({ name: r.name, path: r.path }))}
                  />
                )}
                {!frame && !pick && (
                  <p className="cv__hint">
                    Select a frame to link a child canvas, or any element to give it a spec card.
                  </p>
                )}
                <section className="cv__side-section" aria-label="Reference images">
                  <h3>Reference images</h3>
                  {refs.length === 0 ? (
                    <p className="cv__hint">
                      None stored. Drop or insert an image on the canvas and it is saved beside the
                      file, not inside it.
                    </p>
                  ) : (
                    <ul className="cv__list">
                      {refs.map((r) => (
                        <li key={r.ref}>
                          <button
                            type="button"
                            className="cv__list-item"
                            title={r.path}
                            onClick={() => {
                              const api = apiRef.current;
                              const placed = api
                                ? (api.getSceneElements() as unknown as SceneElement[]).filter(
                                    (e) => e.type === "image" && e.fileId === r.fileId,
                                  )
                                : [];
                              if (placed.length) reveal(placed.map((e) => e.id));
                            }}
                          >
                            <span>{r.name}</span>
                            <span className="cv__meta">
                              {r.fileId ? "placed · show" : "not placed"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </Sidebar>
        )}
      </main>

      {/* Send to agent sits below the whole body, drawing and side panel alike,
          so it takes its own height instead of covering the canvas. The spec
          card's Send card button portals into the empty slot after Send
          selection: the card's draft lives in the side panel. */}
      {doc && view === "canvas" && (
        <SendFooter>
          <SendButton
            label="Send selection"
            sent={sentSelection}
            disabled={selectedN === 0}
            title="Add the selection, as an image, to the agent's context. Drag to a terminal to send it."
            onPointerDown={selectedN > 0 ? dragContext(() => putSelection()) : undefined}
            onClick={sendSelection}
          />
          <span className="cv__send-slot" ref={setSendSlot} />
        </SendFooter>
      )}
    </div>
  );
}
