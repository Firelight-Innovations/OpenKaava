/**
 * The wire shape `play/state` answers with — restated here for the same
 * reason `apps/godot-viewer/ui/src/rpc.ts` restates Godot's.
 *
 * `build` is always `null` today: `src-tauri/src/apps/play.rs::state()` has no
 * debug build to report because nothing runs a build step against this
 * project yet. There is no RPC in this build to actually start, pause or stop
 * a run — `play/state` only reports what exists, so the transport controls
 * stay honestly disabled outside "Preview with sample data" until that
 * exists.
 */
import { invoke } from "@openkaava/bridge";

export interface PlayBuild {
  /** What ran, e.g. `res://scenes/hospital_wing.tscn`. */
  scenePath: string;
}

export interface PlayState {
  running: boolean;
  build: PlayBuild | null;
}

export const getState = () => invoke<PlayState>("play/state");
