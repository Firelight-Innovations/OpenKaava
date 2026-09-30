/**
 * A transparent Excalidraw over any content, with a locked view and a
 * restricted set of tools. Loaded with `React.lazy` by the consumer: this file
 * and its stylesheet pull in Excalidraw, roughly 3 MB of script.
 *
 * Two rules from `apps/canvas/ui/src/Editor.tsx` carry over. Every prop handed
 * to Excalidraw is referentially stable (module constants, `useCallback` over
 * refs), because Excalidraw fires `onChange` whenever it receives a fresh prop.
 * And the flow is one way: Excalidraw's `onChange` writes into the session
 * store, and the store writes back into Excalidraw only on an explicit event
 * (entering or leaving markup, a camera move, Clear), never from `onChange`,
 * so there is no loop to break.
 */
import "./assetPath";
import "@excalidraw/excalidraw/index.css";
import "./MarkupLayer.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { live } from "./elements";
import { renderMarkupPng } from "./exportInk";
import { buildMarkupJson } from "./format";
import type { MarkupJson } from "./format";
import { readPalette } from "./palette";
import type { InkPalette } from "./palette";
import { nextPinNumber, pinGroupId, pinSkeleton, setPinNote } from "./pins";
import { poseMatches, MarkupSessions } from "./session";
import { annotateTargets } from "./targets";
import type { CameraPose, MarkupElement, MarkupHost } from "./types";
import { MarkupToolbar } from "./MarkupToolbar";
import type { MarkupTool } from "./MarkupToolbar";

export interface MarkupExport {
  png: Blob;
  json: MarkupJson;
}

export interface MarkupController {
  /** What is on screen now, as a PNG over the host's frame and as the markup JSON. */
  exportMarkup(): Promise<MarkupExport>;
  undo(): void;
  redo(): void;
  /** Erases the active session's ink and pins. Pin numbers stay retired. */
  clear(): void;
}

export interface MarkupLayerProps {
  host: MarkupHost;
  /** The app's theme. It styles the toolbar and picks the ink palette; ink itself is theme-independent. */
  theme: "dark" | "light";
  /** Markup mode. Off, the layer shows pins and in-view ink and lets every pointer event through. */
  active: boolean;
  /** The Done button, or the camera moving away from the session being drawn. */
  onActiveChange?: (active: boolean) => void;
  onController?: (controller: MarkupController | null) => void;
}

const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: false,
    toggleTheme: false,
  },
  tools: { image: false },
} as const;

/** Excalidraw's own chrome is hidden by CSS; this keeps the top-right slot empty too. */
const renderNothing = () => null;

/** A view that cannot move: scene coordinates are host pixels. */
const LOCKED_VIEW = { scrollX: 0, scrollY: 0, zoom: { value: 1 } } as const;

/** Latest value in a ref, written after render so callbacks see it without changing identity. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

function keyEventFor(key: string, shift: boolean): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: true,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
}

export default function MarkupLayer({
  host,
  theme,
  active,
  onActiveChange,
  onController,
}: MarkupLayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const sessionsRef = useRef(new MarkupSessions());
  const lockedRef = useRef<Set<string>>(new Set());
  const sigRef = useRef("");
  const [apiReady, setApiReady] = useState(false);
  const [tool, setTool] = useState<MarkupTool>("selection");
  const [inkColor, setInkColor] = useState<string | null>(null);
  const [pending, setPending] = useState<{ n: number; x: number; y: number } | null>(null);
  const [returnTo, setReturnTo] = useState<CameraPose | null>(null);
  const [palette, setPalette] = useState<InkPalette>(() => readPalette(document.documentElement));

  const hostRef = useLatest(host);
  const activeRef = useLatest(active);
  const paletteRef = useLatest(palette);
  const inkRef = useLatest(inkColor);
  const onActiveChangeRef = useLatest(onActiveChange);

  // Resolved again when the theme flips, and once more a frame later: the app
  // may set its theme attribute in an effect that runs after this one.
  useEffect(() => {
    const root = document.documentElement;
    setPalette(readPalette(root));
    const frame = requestAnimationFrame(() => setPalette(readPalette(root)));
    return () => cancelAnimationFrame(frame);
  }, [theme]);

  const initialData = useMemo(
    () =>
      ({
        elements: [],
        appState: {
          ...LOCKED_VIEW,
          viewBackgroundColor: "transparent",
          currentItemStrokeColor: palette.ink,
          currentItemBackgroundColor: "transparent",
          currentItemStrokeWidth: 2,
          currentItemFontSize: 20,
          gridModeEnabled: false,
          openSidebar: null,
        },
      }) as never,
    // The scene is restored once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** Pushes the store's view of the current camera into Excalidraw. */
  const refresh = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const h = hostRef.current;
    const sessions = sessionsRef.current;
    const camera = h.getCamera?.() ?? null;
    const composed = sessions.compose(camera, h.project);
    lockedRef.current = composed.lockedIds;
    sigRef.current = "";
    api.updateScene({
      elements: composed.elements as never,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setReturnTo(activeRef.current ? null : (composed.returnTo?.pose ?? null));
  }, [hostRef, activeRef]);

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    setApiReady(true);
  }, []);

  const handleChange = useCallback(
    (
      elements: readonly unknown[],
      appState: { activeTool: { type: string; customType: string | null } },
    ) => {
      const t = appState.activeTool;
      setTool((t.type === "custom" ? (t.customType ?? "selection") : t.type) as MarkupTool);
      if (!activeRef.current) return;
      const mine = (elements as readonly MarkupElement[]).filter(
        (e) => !lockedRef.current.has(e.id),
      );
      const sig = mine.map((e) => `${e.id}:${e.version ?? 0}`).join("|");
      if (sig === sigRef.current) return;
      sigRef.current = sig;
      sessionsRef.current.setActiveElements(mine);
    },
    [activeRef],
  );

  /** Keeps the view locked even if a gesture Excalidraw handles itself gets past the guards below. */
  const handleScroll = useCallback((x: number, y: number, zoom: { value: number }) => {
    if (x === 0 && y === 0 && zoom.value === 1) return;
    apiRef.current?.updateScene({ appState: LOCKED_VIEW as never });
  }, []);

  const placePin = useCallback(
    (x: number, y: number) => {
      const api = apiRef.current;
      if (!api) return;
      const sessions = sessionsRef.current;
      const all = api.getSceneElementsIncludingDeleted() as unknown as MarkupElement[];
      const n = nextPinNumber(all, sessions.pinHighWater);
      sessions.pinHighWater = n;
      const hit = hostRef.current.pick?.(x, y) ?? null;
      const p = paletteRef.current;
      const created = convertToExcalidrawElements([
        pinSkeleton({
          n,
          x,
          y,
          nodePath: hit?.nodePath,
          worldPoint: hit?.worldPoint,
          colors: { fill: p.pinFill, stroke: p.pinStroke, text: p.pinText },
        }) as never,
      ]).map((el) =>
        el.groupIds.length > 0 ? el : ({ ...el, groupIds: [pinGroupId(n)] } as typeof el),
      );
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...created],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setPending({ n, x, y });
    },
    [hostRef, paletteRef],
  );

  const commitNote = useCallback((n: number, note: string) => {
    setPending(null);
    const api = apiRef.current;
    if (!api || note === "") return;
    const all = api.getSceneElementsIncludingDeleted() as unknown as MarkupElement[];
    api.updateScene({
      elements: setPinNote(all, n, note) as never,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, []);

  const handlePointerDown = useCallback(
    (
      activeTool: { type: string; customType: string | null },
      state: { origin: { x: number; y: number } },
    ) => {
      if (activeTool.type === "custom" && activeTool.customType === "pin") {
        placePin(state.origin.x, state.origin.y);
      }
    },
    [placePin],
  );

  // Entering and leaving markup mode.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const sessions = sessionsRef.current;
    const h = hostRef.current;
    if (active) {
      sessions.enter(h.getCamera?.() ?? null);
      h.setInteractive?.(false);
      refresh();
      api.history.clear();
      api.updateScene({
        appState: { currentItemStrokeColor: inkRef.current ?? paletteRef.current.ink } as never,
      });
      return () => {
        const current = sessions.active;
        if (current) sessions.setActiveElements(annotateTargets(current.elements, h.pick));
        sessions.leave();
        h.setInteractive?.(true);
        setPending(null);
        // `active` is already false by the time this runs, so refresh() shows the returned-to state.
        refresh();
      };
    }
    refresh();
    return undefined;
  }, [active, apiReady, refresh, hostRef, inkRef, paletteRef]);

  // Following the camera: pins move, ink hides or returns.
  useEffect(() => {
    if (!apiReady) return;
    return host.onCameraChange?.((pose) => {
      const session = sessionsRef.current.active;
      if (activeRef.current && session?.pose && !poseMatches(session.pose, pose)) {
        onActiveChangeRef.current?.(false);
      }
      refresh();
    });
  }, [host, apiReady, refresh, activeRef, onActiveChangeRef]);

  // Locking the view. Wheel, middle-button and space-drag would pan or zoom the
  // plane; these run in the capture phase, before Excalidraw hears of them.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointer = (e: PointerEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest("textarea, input");
      if (typing) return;
      const zoomKey = (e.ctrlKey || e.metaKey) && ["+", "-", "=", "0", "_"].includes(e.key);
      const fitKey = e.shiftKey && ["1", "2", "3", "!", "@", "#"].includes(e.key);
      if (e.key === " " || zoomKey || fitKey) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    el.addEventListener("pointerdown", onPointer, { capture: true });
    el.addEventListener("keydown", onKey, { capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
      el.removeEventListener("pointerdown", onPointer, { capture: true });
      el.removeEventListener("keydown", onKey, { capture: true });
    };
  }, []);

  const controller = useMemo<MarkupController>(() => {
    const press = (key: string, shift: boolean) => {
      const target = rootRef.current?.querySelector<HTMLElement>(".excalidraw");
      target?.focus();
      target?.dispatchEvent(keyEventFor(key, shift));
    };
    return {
      undo: () => press("z", false),
      redo: () => press("z", true),
      clear: () => {
        sessionsRef.current.clearActive();
        refresh();
      },
      exportMarkup: async () => {
        const api = apiRef.current;
        if (!api) throw new Error("markup layer is not mounted");
        const h = hostRef.current;
        const sessions = sessionsRef.current;
        const camera = h.getCamera?.() ?? null;
        for (const s of sessions.sessions) {
          const inView = !s.pose || !camera || poseMatches(s.pose, camera);
          if (inView) s.elements = annotateTargets(s.elements, h.pick);
        }
        const composed = sessions.compose(camera, h.project);
        const elements = live(composed.elements).map((el) =>
          composed.lockedIds.has(el.id) ? { ...el, locked: false } : el,
        );
        const json = buildMarkupJson({ host: h, elements, camera });
        const png = await renderMarkupPng({
          host: h,
          elements,
          files: api.getFiles(),
          dpr: window.devicePixelRatio || 1,
        });
        refresh();
        return { png, json };
      },
    };
  }, [refresh, hostRef]);

  useEffect(() => {
    onController?.(controller);
    return () => onController?.(null);
  }, [controller, onController]);

  const chooseTool = useCallback((next: MarkupTool) => {
    const api = apiRef.current;
    if (!api) return;
    if (next === "pin") api.setActiveTool({ type: "custom", customType: "pin" });
    else api.setActiveTool({ type: next });
  }, []);

  const chooseColor = useCallback((color: string) => {
    setInkColor(color);
    apiRef.current?.updateScene({ appState: { currentItemStrokeColor: color } as never });
  }, []);

  const showChip = !active && returnTo !== null;

  return (
    <div
      ref={rootRef}
      className={`kaava-markup${active ? " kaava-markup--active" : ""}`}
      data-theme={theme}
      onContextMenuCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={handleApi}
        // Always light: dark mode inverts every canvas colour, which would make
        // token colours read wrongly over a render. Ink is theme-independent.
        theme="light"
        viewModeEnabled={!active}
        UIOptions={UI_OPTIONS}
        renderTopRightUI={renderNothing}
        onChange={handleChange as never}
        onPointerDown={handlePointerDown as never}
        onScrollChange={handleScroll}
        handleKeyboardGlobally={false}
        detectScroll={false}
        aiEnabled={false}
      />
      {active && (
        <MarkupToolbar
          tool={tool}
          swatches={palette.swatches}
          color={inkColor ?? palette.ink}
          onTool={chooseTool}
          onColor={chooseColor}
          onUndo={controller.undo}
          onRedo={controller.redo}
          onClear={controller.clear}
          onDone={() => onActiveChange?.(false)}
        />
      )}
      {active && pending && (
        <input
          className="kaava-markup__note"
          style={{ left: pending.x + 22, top: pending.y - 14 }}
          autoFocus
          aria-label={`Note for pin ${pending.n}`}
          placeholder="Note for the agent"
          onKeyDown={(e) => {
            if (e.key === "Enter") commitNote(pending.n, e.currentTarget.value.trim());
            if (e.key === "Escape") commitNote(pending.n, "");
            e.stopPropagation();
          }}
          onBlur={(e) => commitNote(pending.n, e.currentTarget.value.trim())}
        />
      )}
      {showChip && returnTo && (
        <div className="kaava-markup__chip" role="status">
          <span>Markup at saved view</span>
          <button
            type="button"
            onClick={() => hostRef.current.setCamera?.(returnTo, { animate: true })}
          >
            Return
          </button>
        </div>
      )}
    </div>
  );
}
