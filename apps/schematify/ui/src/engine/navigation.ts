/**
 * Click-to-drill (PRD §17 Wave 5). Pure and DOM-free: the *decision* of
 * where a click leads lives here, unit-tested, and `SchematicCanvas.tsx`
 * only turns a click into a call to it. Breadcrumb walk-up depends on
 * navigation history, not document state, so it stays as `App.tsx`'s own
 * small piece of React state instead.
 */
import type { Tier } from "../graph";
import type { SchematicConfig } from "./config";
import { TIER_PRESETS } from "./presets";

export interface DrillTarget {
  tier: Tier;
  slug: string;
  /** So a breadcrumb segment has a title without a 2nd graph lookup. */
  title: string;
}

/** A structural subset, the same style `anatomy.ts`'s `AnatomyNode` uses. */
export interface DrillableNode {
  kind: string;
  slug: string;
  title: string;
}

/**
 * Where a click on `node` navigates to, given the tier it was clicked on, or
 * `null` when this kind drills nowhere at this tier. Only 2 rows exist
 * because only 2 are named: PRD §17 Wave 5 gives "a click on a service"
 * (stack tier) and "a click on a module" (service tier). A module clicked at
 * its own Module Schematic is deliberately not a 3rd row — the root is
 * already open, so re-opening it would be a no-op dressed as navigation.
 */
export function nextDrillTarget(tier: Tier, node: DrillableNode): DrillTarget | null {
  if (tier === "stack" && node.kind === "service") {
    return { tier: "service", slug: node.slug, title: node.title };
  }
  if (tier === "service" && node.kind === "module") {
    return { tier: "module", slug: node.slug, title: node.title };
  }
  return null;
}

/**
 * The configuration to open for a drill target. `TIER_PRESETS` is 1 static
 * value per tier, but a Service or Module Schematic is 1 per instance, so
 * `layoutSlug` is overridden per target. The Stack Schematic has exactly 1
 * instance and never needs the override.
 */
export function configFor(target: DrillTarget): SchematicConfig {
  const preset = TIER_PRESETS[target.tier];
  if (target.tier === "stack") return preset;
  return { ...preset, layoutSlug: target.slug };
}

/** Where the app opens, and the breadcrumb's first entry: the highest tier —
 *  the only one nameable without already knowing what the project holds. That
 *  rule, and the defect that produced it, are pinned in `navigation.test.ts`.
 *  The slug is `STACK_CONFIG`'s own, which `configFor` above ignores here. */
export const LANDING_PATH: readonly DrillTarget[] = [
  { tier: "stack", slug: TIER_PRESETS.stack.layoutSlug, title: "Stack" },
];
