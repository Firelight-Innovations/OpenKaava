/**
 * The vocabulary shared by every module in this package. Nothing here imports
 * Excalidraw or React, so the host adapters, the session model and the export
 * format can all be tested without a DOM.
 */

export type Vec3 = [number, number, number];

/** A camera, in the shape the scene viewer reports it. */
export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** Vertical field of view, degrees. */
  fov: number;
}

export interface PickHit {
  /** Path of the node under the point, as the scene viewer names it. */
  nodePath: string;
  worldPoint: Vec3;
}

export interface Projected {
  /** Host viewport pixels, top-left origin: the same space as the markup scene. */
  x: number;
  y: number;
  /** False when the point is behind the camera or outside the frustum. */
  visible: boolean;
}

export interface ViewSize {
  width: number;
  height: number;
}

/**
 * What the markup layer needs from whatever it sits over. Everything except
 * `capture`, `size` and `describe` is optional: an image has no geometry to
 * pick, a plain screenshot has no camera. The layer degrades to plain ink.
 */
export interface MarkupHost {
  /** The node and world point under a viewport pixel, or null over empty space. */
  pick?(x: number, y: number): PickHit | null;
  /** Where a world point lands in the viewport right now. */
  project?(p: Vec3): Projected;
  /** The background frame, without any ink. */
  capture(): Promise<Blob>;
  /** The viewport in CSS pixels. Markup scene coordinates are 1:1 with this. */
  size(): ViewSize;
  /** What this frame is, for agents: `{ kind: "scene", glb, camera }` or `{ kind: "image", path }`. */
  describe(): Record<string, unknown>;

  /** Called on entering markup mode with `false`, and on leaving with `true`. */
  setInteractive?(interactive: boolean): void;
  /** The camera now. Absent on hosts that have none, which are then never "moved away". */
  getCamera?(): CameraPose;
  /** Fly the camera back to a saved pose (the "Return" chip). */
  setCamera?(pose: CameraPose, opts?: { animate?: boolean }): void;
  /** Subscribe to camera movement; returns the unsubscribe. */
  onCameraChange?(cb: (pose: CameraPose) => void): () => void;
}

/**
 * The contract `@kaava/scene-view` implements for its handle, mirrored here
 * rather than imported: importing it, even as a type, would make this package
 * typecheck three.js and the viewer's CSS. It is not left to drift. The Godot
 * viewer passes a real `SceneViewHandle` to `sceneHost`, so a change to either
 * side fails `tsc` there. Keep `capture`'s options identical to scene-view's.
 */
export interface SceneViewHandle {
  getCamera(): CameraPose;
  setCamera(pose: CameraPose, opts?: { animate?: boolean }): void;
  setInteractive(interactive: boolean): void;
  pick(x: number, y: number): PickHit | null;
  project(p: Vec3): Projected;
  capture(opts?: { scale?: number }): Promise<Blob>;
  viewportSize(): ViewSize;
  onCameraChange(cb: (pose: CameraPose) => void): () => void;
}

/**
 * The slice of an Excalidraw element this package reads and writes. Excalidraw's
 * own types are strict and version-shaped; the markup JSON has to survive a
 * round trip through files written by other versions, so the code here sees
 * plain data and hands it to Excalidraw with a cast at the edge.
 */
export interface MarkupElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  locked?: boolean;
  groupIds?: readonly string[];
  containerId?: string | null;
  text?: string;
  points?: readonly (readonly [number, number])[];
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  customData?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A node the head of an arrow, or the centre of a box, landed on. */
export interface MarkupTarget {
  nodePath: string;
  worldPoint: Vec3;
  at: "head" | "centre";
}

export interface PinData {
  kind: "pin";
  n: number;
  note: string;
  nodePath?: string;
  worldPoint?: Vec3;
}
