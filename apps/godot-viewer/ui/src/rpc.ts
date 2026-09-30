/**
 * The wire shapes `godot-viewer/*` answers with, restated from
 * `src-tauri/src/godot/scene.rs` and `rpc.rs` rather than imported, for the
 * same reason `apps/shared/comments.ts` restates the comment shapes: an app's
 * only coupling to its host is `@openkaava/bridge` and what crosses it.
 *
 * `godot-viewer/state` reads the cache; nothing runs Godot until
 * `godot-viewer/refresh` is called, and that runs in the background while the
 * pane polls `state` and watches `job`.
 */
import { invoke } from "@openkaava/bridge";

export interface GodotNode {
  /** The scene-tree path this node answers to, e.g. `World/Player/Flashlight`. */
  path: string;
  name: string;
  /** A Godot class name, e.g. `Node3D`, `MeshInstance3D`, `Camera3D`. */
  type: string;
  children: GodotNode[];
  /** The `res://` script attached to this node. */
  script?: string;
  /** The `res://` scene this node is an instance of. */
  instance?: string;
}

/** `headless`: Godot loaded the scene. `parsed`: read from the .tscn text. */
export type TreeSource = "headless" | "parsed";

export interface Job {
  running: boolean;
  /** What the refresh is doing, e.g. `importing`, `reading the scene`. */
  phase: string;
  error: string | null;
  scene: string;
  startedAt: number;
  /** The last lines Godot printed, kept so a failure can be explained. */
  output: string[];
}

export interface GodotViewerState {
  project: string;
  scenes: string[];
  scene: string | null;
  /** Milliseconds since the Unix epoch, or `null` before the first refresh. */
  renderedAt: number | null;
  scenePath: string | null;
  nodes: GodotNode[];
  source: TreeSource | null;
  godot: string | null;
  /** Why the tree was parsed instead of read from Godot, when it was. */
  note: string | null;
  /** When the cached frame was rendered, or `null` if there is none. */
  imageAt: number | null;
  job: Job | null;
  engineFound: boolean;
}

export const getState = (scene?: string, project?: string) =>
  invoke<GodotViewerState>("godot-viewer/state", { scene, project });

export const refresh = (scene: string | undefined, render: boolean, project?: string) =>
  invoke<{ started: boolean }>("godot-viewer/refresh", { scene, render, project });

/** Standard base64 PNG, or `null` when no frame is cached. */
export const getImage = (scene: string | undefined, project?: string) =>
  invoke<{ png: string | null }>("godot-viewer/image", { scene, project });
