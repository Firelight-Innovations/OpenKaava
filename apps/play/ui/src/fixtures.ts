/**
 * Sample data for "Preview with sample data" — see
 * `apps/godot-viewer/ui/src/fixtures.ts` for why this exists and when it's
 * allowed to be shown. This is also the only mode in which Play's transport
 * controls do anything: there is no backend call to actually start, pause or
 * stop a run (see rpc.ts), so outside preview they stay honestly disabled.
 */
import type { PlayState } from "./rpc";

export const sampleState: PlayState = {
  running: false,
  build: { scenePath: "res://scenes/hospital_wing.tscn" },
};
