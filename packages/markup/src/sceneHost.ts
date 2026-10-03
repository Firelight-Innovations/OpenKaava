/**
 * Adapts the scene viewer's handle to a `MarkupHost`. The handle's methods map
 * one to one; what this adds is `describe()`, which is how an agent learns
 * which model and camera a piece of markup was made against.
 */
import type { CameraPose, MarkupHost, SceneViewHandle } from "./types";

export interface SceneHostInfo {
  /** Path of the glTF being viewed, as the project names it. */
  glb?: string;
  /** Anything else worth telling an agent (engine, scene name). Merged into `describe()`. */
  extra?: Record<string, unknown>;
  /** Device pixel ratio for `capture`. Defaults to the window's. */
  pixelRatio?: number;
}

export function sceneHost(handle: SceneViewHandle, info: SceneHostInfo = {}): MarkupHost {
  return {
    pick: (x, y) => handle.pick(x, y),
    project: (p) => handle.project(p),
    capture: () =>
      handle.capture({
        scale: info.pixelRatio ?? (typeof window === "undefined" ? 1 : window.devicePixelRatio),
      }),
    size: () => handle.viewportSize(),
    describe: () => {
      const camera: CameraPose = handle.getCamera();
      const out: Record<string, unknown> = { kind: "scene", camera, ...info.extra };
      if (info.glb !== undefined) out.glb = info.glb;
      return out;
    },
    setInteractive: (b) => handle.setInteractive(b),
    getCamera: () => handle.getCamera(),
    setCamera: (pose, opts) => handle.setCamera(pose, opts),
    onCameraChange: (cb) => handle.onCameraChange(cb),
  };
}
