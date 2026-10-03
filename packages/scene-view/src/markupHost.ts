/**
 * The contract between `<SceneView>` and whatever draws markup over it.
 *
 * Markup is not built here. `@kaava/markup` (Excalidraw-based, shared with the
 * Canvas app) mounts in SceneView's `children` slot and reaches the 3D side
 * only through this handle, so every drawing tool lives in one place.
 *
 * Everything crossing the boundary is plain data. Viewport coordinates are CSS
 * pixels from the viewport element's top-left corner, never window client
 * coordinates: the viewer sits in an iframe, and element-relative is the one
 * frame both sides agree on.
 */

export type Vec3 = [number, number, number];

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** Vertical field of view in degrees, as glTF and three both use it. */
  fov: number;
}

export interface PickHit {
  /** Node names from the top-level node down, joined by "/": "Main/Chair/Leg3". */
  nodePath: string;
  worldPoint: Vec3;
}

export interface ViewportPoint {
  x: number;
  y: number;
  /** In front of the camera and inside the frustum. Not an occlusion test. */
  visible: boolean;
}

export interface SceneViewHandle {
  getCamera(): CameraPose;
  /** `animate` eases to the pose; it is ignored under `prefers-reduced-motion`. */
  setCamera(pose: CameraPose, opts?: { animate?: boolean }): void;
  /** False freezes the camera and stops click selection, for markup mode. */
  setInteractive(enabled: boolean): void;
  /** Ray-casts through a viewport point. `null` when nothing is hit. */
  pick(x: number, y: number): PickHit | null;
  /** World point to viewport pixels, so a pin follows its geometry as the camera moves. */
  project(worldPoint: Vec3): ViewportPoint;
  /** PNG of the 3D frame only. `scale` is output pixels per CSS pixel; default is the device ratio. */
  capture(opts?: { scale?: number }): Promise<Blob>;
  viewportSize(): { width: number; height: number };
  /** Fires when the camera comes to rest, and after `setCamera`. Returns an unsubscribe. */
  onCameraChange(cb: (pose: CameraPose) => void): () => void;
}
