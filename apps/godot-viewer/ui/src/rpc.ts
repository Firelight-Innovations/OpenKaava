/**
 * The wire shape `godot-viewer/state` answers with — restated here rather than
 * imported from `src-tauri/src/apps/godot_viewer.rs`, for the same reason
 * `apps/shared/comments.ts` restates the comment shapes: an app's only coupling
 * to its host is `@openkaava/bridge` and the shape of what crosses it.
 *
 * `nodes` is always `[]` today — `src-tauri/src/apps/godot_viewer.rs::state()`
 * has nothing to walk yet, because nothing runs `godot --headless` on this
 * project. The `Node` shape below is what that walk will eventually produce;
 * declaring it now is what lets the tree component and the "Preview with
 * sample data" fixture exist before the Rust side has anything real to send.
 */
import { invoke } from "@openkaava/bridge";

export interface GodotNode {
  /** The scene-tree path this node answers to, e.g. `Player/Flashlight`. */
  path: string;
  name: string;
  /** A Godot class name, e.g. `Node3D`, `MeshInstance3D`, `Camera3D`. */
  type: string;
  children: GodotNode[];
}

export interface GodotViewerState {
  /** Milliseconds since the Unix epoch, or `null` before any headless run. */
  renderedAt: number | null;
  scenePath: string | null;
  nodes: GodotNode[];
}

export const getState = () => invoke<GodotViewerState>("godot-viewer/state");
