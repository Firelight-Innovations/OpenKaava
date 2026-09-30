/**
 * The one file that imports Excalidraw. `App.tsx` loads this with `React.lazy`,
 * so the editor's roughly 3 MB of script and its stylesheet are fetched only
 * when a canvas is opened, not when the pane mounts and reports painted.
 */
import "./assetPath";
import "@excalidraw/excalidraw/index.css";
import { useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { childOf, hitLinkedFrame, viewportToScene } from "./nesting";
import type { SceneElement, SceneFile } from "./scene";

export interface EditorProps {
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
}

export default function Editor({
  initial,
  theme,
  readOnly,
  onChange,
  onApi,
  onOpenChild,
}: EditorProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

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
        initialData={
          {
            elements: initial.elements,
            appState: { ...initial.appState, theme },
            files: initial.files,
            scrollToContent: true,
          } as never
        }
        excalidrawAPI={(api) => {
          apiRef.current = api;
          onApi(api);
        }}
        theme={theme}
        viewModeEnabled={readOnly}
        UIOptions={{
          canvasActions: {
            // The canvas is a file in the repository; opening or saving another
            // one from the menu would bypass the app's own save path.
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: true,
            export: false,
          },
        }}
        onChange={(elements: readonly unknown[], appState: AppState, files: BinaryFiles) =>
          onChange(
            elements as readonly SceneElement[],
            appState as unknown as Record<string, unknown>,
            files,
          )
        }
      />
    </div>
  );
}
