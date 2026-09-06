/**
 * The Schematic engine's public surface. Wave 5 builds the Stack, Service and
 * Module Schematics by picking a config from `./presets`, calling
 * `openSchematic`, and rendering `SchematicCanvas` — nothing else here is
 * required reading to configure a tier.
 *
 * `docs/overnight-jobs/overnight-2/handoffs/w3-engine.md` is the prose version
 * of this file.
 */
import { defaultSeam } from "../graph";
import type { SchematifySeam } from "../graph";
import type { SchematicConfig } from "./config";
import { SchematicEngine } from "./engine";
import { buildDoc } from "./layout";

export type {
  ArrangementStrategy,
  ChromeConfig,
  ContainmentRendering,
  EdgeKind,
  EdgeKindRule,
  EdgeStyle,
  GridConfig,
  NodePolicy,
  NodeRole,
  Refusal,
  SchematicConfig,
  SchematicNodeKind,
  Size,
  ZoomConfig,
} from "./config";
export { ANNOTATION_KINDS, isAnnotationKind, refuse } from "./config";
export { MODULE_CONFIG, SERVICE_CONFIG, STACK_CONFIG, TIER_PRESETS } from "./presets";
export type { SchematicDoc, SchematicEdge, SchematicNode } from "./doc";
export type { Point, Rect } from "./geometry";
export type { DrawnEdge, DrawnNode, Frame, LegendChip, Minimap } from "./frame";
export { buildFrame } from "./frame";
export type { Callout, CoverageReadout } from "./anatomy";
export {
  SATISFIES_CALLOUT,
  coverageBody,
  coverageOf,
  facetContentFor,
  sharedNodeCallout,
} from "./anatomy";
export type { DrillableNode, DrillTarget } from "./navigation";
export { configFor, LANDING_PATH, nextDrillTarget } from "./navigation";
export type { Clipboard, EngineState, SemanticEffect, WriteLayer } from "./engine";
export { SchematicEngine } from "./engine";
export type { EdgeDraft } from "./rules";
export {
  COMMENT_REFUSAL,
  CYCLE_REFUSAL,
  GROUP_REFUSAL,
  validateEdge,
  validateReparent,
} from "./rules";
export { buildDoc, toGraph, toLayoutFile, toServiceGraph } from "./layout";
export type { Viewport, ViewportSize } from "./viewport";
export { toScreen, toWorld, zoomReadout } from "./viewport";

/**
 * Opens one Schematic: reads the graph and the layout file through the seam,
 * joins them, and hands back an engine. The 2 reads are the only reads this
 * app makes, and they go through the module a backend replaces.
 */
export async function openSchematic(
  config: SchematicConfig,
  seam: SchematifySeam = defaultSeam,
): Promise<SchematicEngine> {
  // Wave 5: which graph to load is no longer implicit. Every tier's own slug
  // is `config.layoutSlug` already — the same value that names the layout
  // file — so opening a Schematic still takes nothing beyond the config.
  const graph = await seam.loadGraph(config.tier, config.layoutSlug);
  const layout = await seam.readLayout(config.layoutSlug);
  return new SchematicEngine(config, buildDoc(graph, layout, config), seam);
}
