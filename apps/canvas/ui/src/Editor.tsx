/**
 * The one file that imports Excalidraw. `App.tsx` loads this with `React.lazy`,
 * so the editor's roughly 3 MB of script and its stylesheet are fetched only
 * when a canvas is opened, not when the pane mounts and reports painted.
 */
import { themeNeedsPush } from "./themeSync";
import "./assetPath";
import "@excalidraw/excalidraw/index.css";
import "./native.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import About from "./About";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import LinkBadges, { type BadgeSink } from "./LinkBadges";
import HighlightOverlay, { type HighlightSink } from "./HighlightOverlay";
import type { Highlight, HighlightView } from "./commentHighlight";
import {
  CANVAS_LINK,
  childOf,
  hitLinkedFrame,
  linkBadges,
  viewportToScene,
  type BadgeView,
} from "./nesting";
import type { SceneElement, SceneFile } from "./scene";
import { SnapshotPainter } from "./snapshots";

export interface EditorProps {
  /** The canvas shown, whose sub-canvas frames get pictures of their children. */
  canvasId: string;
  /** What to open. Changing it does nothing: remount with a new `key`. */
  initial: SceneFile;
  theme: "dark" | "light";
  readOnly: boolean;
  onChange: (
    elements: readonly SceneElement[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) => void;
  onApi: (api: ExcalidrawImperativeAPI) => void;
  /** A frame with a child link was double-clicked. */
  onOpenChild: (id: string) => void;
  /** The title to show for a child canvas id on a frame's link badge. */
  titleOf: (canvasId: string) => string;
  /** A `kaava://diagram/<id>` link (an index row) was followed. */
  onOpenDiagram?: (id: string) => void;
  /** Outlines to draw over what a comment is about; an overlay, never scene elements. */
  highlights?: Highlight[];
}

const NO_HIGHLIGHTS: Highlight[] = [];

const DIAGRAM_LINK = "kaava://diagram/";

/**
 * Module-level on purpose. Excalidraw re-renders, and fires `onChange`, whenever
 * a prop is not referentially equal to last time; an inline object here made
 * every re-render of the app (a save-state change, say) reach Excalidraw as a
 * change, which the saver then treated as a fresh edit.
 */
const UI_OPTIONS = {
  canvasActions: {
    // The canvas is a file in the repository; opening or saving another
    // one from the menu would bypass the app's own save path.
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: true,
    export: false,
  },
} as const;

interface View {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
}

/** Where each canvas was last looked at this session, so a reload after a
 *  split, or coming back from a child, lands where the person left it. */
const views = new Map<string, View>();

export default function Editor({
  canvasId,
  initial,
  theme,
  readOnly,
  onChange,
  onApi,
  onOpenChild,
  titleOf,
  onOpenDiagram,
  highlights = NO_HIGHLIGHTS,
}: EditorProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [about, setAbout] = useState(false);
  const onOpenDiagramRef = useRef(onOpenDiagram);
  onOpenDiagramRef.current = onOpenDiagram;
  const onOpenChildRef = useRef(onOpenChild);
  onOpenChildRef.current = onOpenChild;
  // An index row's link names a diagram in this canvas; following it moves the
  // view instead of asking the browser to open a `kaava:` URL.
  const handleLink = useCallback(
    (element: { link?: string | null }, event: CustomEvent<{ nativeEvent: unknown }>) => {
      const link = element.link ?? "";
      if (link.startsWith(CANVAS_LINK)) {
        event.preventDefault();
        onOpenChildRef.current(link.slice(CANVAS_LINK.length));
        return;
      }
      if (!link.startsWith(DIAGRAM_LINK)) return;
      event.preventDefault();
      onOpenDiagramRef.current?.(decodeURIComponent(link.slice(DIAGRAM_LINK.length)));
    },
    [],
  );
  // Held in refs so the props handed to Excalidraw below stay the same objects
  // across renders, whatever the parent passes.
  const badgeSink = useRef<BadgeSink | null>(null);
  const highlightSink = useRef<HighlightSink | null>(null);
  const titleOfRef = useRef(titleOf);
  titleOfRef.current = titleOf;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  // The scene is restored once, on mount; later changes to it are ignored.
  const initialData = useMemo(
    () => {
      const view = views.get(canvasId);
      return {
        elements: initial.elements,
        appState: { ...initial.appState, ...view, theme },
        files: initial.files,
        scrollToContent: !view,
      } as never;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initial],
  );
  // Excalidraw owns its `appState.theme` once mounted; pushing the shell's
  // theme in explicitly keeps a switch live even if the prop alone is missed.
  useEffect(() => {
    apiRef.current?.updateScene({ appState: { theme } } as never);
  }, [theme]);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const handleApi = useCallback((next: ExcalidrawImperativeAPI) => {
    apiRef.current = next;
    setApi(next);
    onApiRef.current(next);
  }, []);
  // Pictures of the children in sub-canvas frames, kept current while open.
  const painterRef = useRef<SnapshotPainter | null>(null);
  useEffect(() => {
    if (!api) return;
    const painter = new SnapshotPainter(api, canvasId, () => themeRef.current, readOnly);
    painterRef.current = painter;
    painter.start();
    return () => {
      painter.stop();
      painterRef.current = null;
    };
  }, [api, canvasId, readOnly]);
  useEffect(() => {
    painterRef.current?.repaint();
  }, [theme]);
  const handleChange = useCallback(
    (elements: readonly unknown[], appState: AppState, files: BinaryFiles) => {
      // Excalidraw's own async init can land after the first theme push and
      // leave it on dark inside a light shell. Every change reports the theme
      // it is drawing with, so a mismatch is corrected here.
      if (themeNeedsPush(appState.theme, themeRef.current)) {
        apiRef.current?.updateScene({ appState: { theme: themeRef.current } } as never);
      }
      const { scrollX, scrollY, zoom } = appState;
      views.set(canvasIdRef.current, { scrollX, scrollY, zoom: { value: zoom.value } });
      // Scroll and zoom arrive here too, which is what keeps the badges on their frames.
      badgeSink.current?.(
        linkBadges(
          elements as readonly SceneElement[],
          appState as unknown as BadgeView,
          titleOfRef.current,
        ),
      );
      highlightSink.current?.(elements as readonly SceneElement[], {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: { value: appState.zoom.value },
        width: appState.width,
        height: appState.height,
      } satisfies HighlightView);
      onChangeRef.current(
        elements as readonly SceneElement[],
        appState as unknown as Record<string, unknown>,
        files,
      );
    },
    [],
  );

  // Captured before Excalidraw sees it: on a frame, its own double-click would
  // start a text edit. Only a frame that has a child link is taken over.
  const openLinkedFrame = (event: React.MouseEvent) => {
    const api = apiRef.current;
    if (!api) return;
    const point = viewportToScene(event.clientX, event.clientY, api.getAppState());
    const hit = hitLinkedFrame(api.getSceneElements() as unknown as SceneElement[], point);
    const child = hit ? childOf(hit) : null;
    if (!child) return;
    event.stopPropagation();
    event.preventDefault();
    onOpenChild(child);
  };

  return (
    <div className="cv__editor" onDoubleClickCapture={openLinkedFrame}>
      <Excalidraw
        // The scene is plain JSON that Excalidraw restores on load; its element
        // type is stricter than the file's, and the file is what is validated.
        initialData={initialData}
        excalidrawAPI={handleApi}
        theme={theme}
        viewModeEnabled={readOnly}
        UIOptions={UI_OPTIONS}
        onChange={handleChange}
        onLinkOpen={handleLink as never}
        aiEnabled={false}
      >
        {/* Passing a menu replaces Excalidraw's, which links to its site and
            socials; with any child given, its welcome screen is not drawn. */}
        <MainMenu>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
          <MainMenu.Separator />
          <MainMenu.Item onSelect={() => setAbout(true)}>About this editor</MainMenu.Item>
        </MainMenu>
      </Excalidraw>
      <LinkBadges sinkRef={badgeSink} onOpen={(id) => onOpenChildRef.current(id)} />
      <HighlightOverlay highlights={highlights} sinkRef={highlightSink} />
      {about && <About onClose={() => setAbout(false)} />}
    </div>
  );
}
