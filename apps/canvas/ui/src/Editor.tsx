/**
 * The one file that imports Excalidraw. `App.tsx` loads this with `React.lazy`,
 * so the editor's roughly 3 MB of script and its stylesheet are fetched only
 * when a canvas is opened, not when the pane mounts and reports painted.
 */
import "./assetPath";
import "@excalidraw/excalidraw/index.css";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
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
}

export default function Editor({ initial, theme, readOnly, onChange, onApi }: EditorProps) {
  return (
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
      excalidrawAPI={onApi}
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
  );
}
