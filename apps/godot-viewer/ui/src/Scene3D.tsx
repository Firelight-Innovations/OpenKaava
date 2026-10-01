/**
 * The interactive 3D view: an orbitable three.js render of the exported glTF,
 * with an optional markup layer on top.
 *
 * This module is the only place `three` and Excalidraw are reached from, and
 * `App` loads it with `React.lazy`, so neither is in the viewer's first chunk.
 * Excalidraw is a second, nested lazy load: opening the 3D view costs three.js,
 * and only pressing "Mark up" costs Excalidraw.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import { SceneView } from "@kaava/scene-view";
import type { SceneViewHandle } from "@kaava/scene-view";
import { poseMatches, sceneHost } from "@kaava/markup";
import type { CameraPose } from "@kaava/markup";
import type { MarkupController, MarkupExport } from "@kaava/markup/layer";
import { projectRelative, type NodeLookup } from "./preview";

/** The layer exports a named component; `lazy` wants a default. */
const MarkupLayer = lazy(() =>
  import("@kaava/markup/layer").then((m) => ({ default: m.MarkupLayer })),
);

export interface Scene3DProps {
  glb: ArrayBuffer;
  lookup: NodeLookup;
  /** Absolute path of the glb; the markup JSON records it relative to `.kaava`. */
  glbPath: string;
  /** `res://...` of the scene being shown. */
  scenePath: string;
  godot: string | null;
  /** The selected node's scene path, shared with the tree beside this view. */
  selected: string | null;
  onSelect: (scenePath: string | null) => void;
  /** A finished markup: what the person drew, ready to send. */
  onMarkup: (result: MarkupExport) => void;
  /** Something this view could not do, in words for the person. */
  onNotice: (message: string) => void;
}

function useTheme(): "dark" | "light" {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState<"dark" | "light">(read);
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

export default function Scene3D(props: Scene3DProps) {
  const { glb, lookup, glbPath, scenePath, godot, selected, onSelect, onMarkup, onNotice } = props;
  const theme = useTheme();
  const [handle, setHandle] = useState<SceneViewHandle | null>(null);
  const [marking, setMarking] = useState(false);
  // Excalidraw is fetched the first time markup is opened, and kept after that so
  // pins from an earlier drawing keep following the camera.
  const [layerLoaded, setLayerLoaded] = useState(false);
  const controller = useRef<MarkupController | null>(null);
  const startedAt = useRef<CameraPose | null>(null);

  const host = useMemo(
    () =>
      handle
        ? sceneHost(handle, {
            glb: projectRelative(glbPath),
            extra: { engine: "godot", scene: scenePath, ...(godot ? { godot } : {}) },
          })
        : null,
    [handle, glbPath, scenePath, godot],
  );

  // The camera is locked for as long as the person is drawing: a pin or a stroke
  // is only right for the view it was made from. The layer does this too when it
  // loads; stating it here makes the lock a fact of this view, not of a lazy import.
  useEffect(() => {
    handle?.setInteractive(!marking);
  }, [handle, marking]);

  const begin = () => {
    startedAt.current = handle?.getCamera() ?? null;
    setLayerLoaded(true);
    setMarking(true);
  };

  // Done, or the camera leaving the view being drawn. Either way the layer has
  // already left markup mode; what is left is deciding whether to keep the result.
  const changeActive = useCallback(
    (next: boolean) => {
      setMarking(next);
      if (next) return;
      const from = startedAt.current;
      startedAt.current = null;
      const now = handle?.getCamera() ?? null;
      const layer = controller.current;
      if (!layer) return;
      if (from && now && !poseMatches(from, now)) {
        onNotice("The camera moved, so that markup stays at the view it was drawn from.");
        return;
      }
      layer
        .exportMarkup()
        .then((result) => {
          if (result.json.pins.length === 0 && result.json.annotations.length === 0) {
            onNotice("Nothing was drawn, so there is nothing to send.");
            return;
          }
          onMarkup(result);
        })
        .catch((e: unknown) => {
          onNotice(`Couldn't export the markup: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [handle, onMarkup, onNotice],
  );

  return (
    <div className="gv__3d">
      <div className="gv__3d-bar">
        <button
          type="button"
          className="gv__action"
          disabled={!handle || marking}
          onClick={begin}
          title="Draw on the view and pin notes to nodes, then send it to the agent"
        >
          <PenLine size={13} strokeWidth={1.5} aria-hidden="true" />
          Mark up
        </button>
        <span className="gv__hint-inline">
          {marking
            ? "Drawing. The camera is locked until you press Done."
            : "Drag to orbit, right-drag to pan, scroll to zoom. Double-click a node to focus it."}
        </span>
      </div>
      <div className="gv__3d-stage">
        <SceneView
          ref={setHandle}
          source={glb}
          selectedPath={lookup.toView(selected)}
          onSelect={(viewPath) => onSelect(lookup.toScene(viewPath))}
          onError={onNotice}
        >
          {host && layerLoaded && (
            <Suspense fallback={null}>
              <MarkupLayer
                host={host}
                theme={theme}
                active={marking}
                onActiveChange={changeActive}
                onController={(c) => {
                  controller.current = c;
                }}
              />
            </Suspense>
          )}
        </SceneView>
      </div>
    </div>
  );
}
