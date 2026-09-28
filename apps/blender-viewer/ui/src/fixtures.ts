/**
 * Sample data for "Preview with sample data" — see
 * `apps/godot-viewer/ui/src/fixtures.ts` for why this exists and when it's
 * allowed to be shown.
 */
import type { BlenderViewerState } from "./rpc";

export const sampleState: BlenderViewerState = {
  model: "res://export/hospital_bed.glb",
  parts: [
    { name: "Frame", material: "steel_brushed" },
    { name: "Headboard", material: "oak_veneer" },
    { name: "Mattress", material: "fabric_white" },
    { name: "SideRail", material: "steel_brushed" },
  ],
  renders: [
    { id: "r1", label: "front", createdAt: Date.now() - 6 * 60_000 },
    { id: "r2", label: "three-quarter", createdAt: Date.now() - 6 * 60_000 },
    { id: "r3", label: "wire", createdAt: Date.now() - 6 * 60_000 },
  ],
};
