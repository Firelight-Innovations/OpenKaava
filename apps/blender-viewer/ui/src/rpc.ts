/**
 * The wire shape `blender-viewer/state` answers with — restated here for the
 * same reason `apps/godot-viewer/ui/src/rpc.ts` restates Godot's. `parts` and
 * `renders` are always `[]` today; see that file's note on why the shapes
 * below exist ahead of anything real producing them.
 */
import { invoke } from "@openkaava/bridge";

export interface BlenderPart {
  name: string;
  material: string;
}

export interface BlenderRender {
  id: string;
  /** A short label for the render, e.g. the camera or pass name. */
  label: string;
  /** Milliseconds since the Unix epoch. */
  createdAt: number;
}

export interface BlenderViewerState {
  /** The `.glb` path this pane is showing, or `null` before any export. */
  model: string | null;
  parts: BlenderPart[];
  renders: BlenderRender[];
}

export const getState = () => invoke<BlenderViewerState>("blender-viewer/state");
