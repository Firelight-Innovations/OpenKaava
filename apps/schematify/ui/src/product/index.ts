/**
 * Pure derivations over the product layer (PRD §5.7, §5.8, §5.9, §5.12,
 * §12.17, §12.18) — nothing here touches `@veistra/bridge`, so this module
 * unit-tests under plain Node, the same split `../graph/index.ts` and
 * `../graph/backend.ts` already draw for the design graph. Every count is
 * computed from whatever is passed in, never cached (PRD §0.4).
 */
import type {
  RawDecision,
  RawFlow,
  RawFlowStep,
  RawProjectBrief,
  RawScreen,
  RawSuccessMetric,
} from "./types";

export type {
  DecisionStatus,
  RawDecision,
  RawFlow,
  RawFlowStep,
  RawProjectBrief,
  RawScreen,
  RawSuccessMetric,
} from "./types";

/** The id half of a `schematify://<kind>/<id>` reference, or `null` for
 *  anything that does not parse as one — a dangling or malformed reference
 *  draws as unresolved rather than throwing. The id segment is not
 *  validated as a UUID shape here: `../graph/project.ts`'s own `RawNode`
 *  fixtures use short hand-picked ids throughout (`"svc"`, `"m1"`), and this
 *  function reads the same wire format they do. */
export function uriId(uri: string): string | null {
  const match = /^schematify:\/\/[a-z]+\/(.+)$/i.exec(uri);
  return match ? match[1] : null;
}

/** `schematify://screen/<id>`, the form §3.4 stores for a screen reference. */
export function screenUri(screen: RawScreen): string {
  return `schematify://screen/${screen.id}`;
}

/** `schematify://decision/<id>`, the form §3.3 stores for a decision
 *  reference — the *drawn* form is the structured slug, resolved by
 *  `decisionDisplaySlug` below. */
export function decisionUri(decision: RawDecision): string {
  return `schematify://decision/${decision.id}`;
}

/** PRD §3.3: "The Inspector `DECISIONS` field resolves that reference and
 *  draws the slug behind the `schematify://decision/` scheme." A decision
 *  log row already draws its own slug directly — this is for a caller
 *  resolving a *reference* to one, elsewhere on the graph. */
export function decisionDisplaySlug(decision: RawDecision): string {
  return decision.slug;
}

/** PRD §12.17: "state count" — a screen's own `states` array, counted at
 *  draw time rather than cached. */
export function screenStateCount(screen: RawScreen): number {
  return screen.states.length;
}

/** PRD §12.17: "backing module count" — how many of `backed_by`'s
 *  references resolve to a node this project actually holds. A reference
 *  that names a node no longer in the graph is not counted, the same
 *  "resolve or don't count it" rule `../graph/project.ts` applies to a
 *  dependency edge whose endpoint fell out of the projection. */
export function screenBackingModuleCount(screen: RawScreen, nodeIds: ReadonlySet<string>): number {
  let count = 0;
  for (const ref of screen.backed_by) {
    const id = uriId(ref);
    if (id && nodeIds.has(id)) count += 1;
  }
  return count;
}

/** PRD §12.17: "design-link state" — whether a screen carries a
 *  `design_ref` at all. The value itself (a URL into Claude Design) is drawn
 *  separately; this is the closed 2-value state a registry row's own column
 *  reads. */
export type DesignLinkState = "linked" | "none";

export function screenDesignLinkState(screen: RawScreen): DesignLinkState {
  return screen.design_ref ? "linked" : "none";
}

/** One flow step, with its screen reference resolved to a title (or the raw
 *  reference, unresolved, when the screen it names does not exist — a
 *  dangling reference draws honestly rather than disappearing). */
export interface ResolvedFlowStep {
  step: RawFlowStep;
  index: number;
  screenTitle: string | null;
  screenSlug: string | null;
}

/** PRD §12.17: "The Flow editor holds an ordered step list." Resolves each
 *  step's screen reference against `screens` so a caller can draw a title
 *  rather than a bare URI. */
export function resolveFlowSteps(flow: RawFlow, screens: readonly RawScreen[]): ResolvedFlowStep[] {
  const byId = new Map(screens.map((screen) => [screen.id, screen]));
  return flow.steps.map((step, index) => {
    const id = uriId(step.screen);
    const screen = id ? byId.get(id) : undefined;
    return {
      step,
      index,
      screenTitle: screen?.title ?? null,
      screenSlug: screen?.slug ?? null,
    };
  });
}

/** Decisions in the order the log draws them: active rows first (the ones
 *  that still stand), each group newest date first. `[P]`: no wireframe
 *  draws this surface (WIREFRAME-EXTRACT.md §8.1 lists S-22 as undrawn), and
 *  PRD §12.18 states only that the log is "filtered by status," not ordered
 *  — recorded in the wave 10c handoff. */
export function sortDecisions(decisions: readonly RawDecision[]): RawDecision[] {
  return [...decisions].sort((a, b) => {
    if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
    return b.date.localeCompare(a.date);
  });
}

/** PRD §12.18: "The log draws as a table filtered by `status`." `"ALL"` is
 *  this app's own catch-all option, not a `DecisionStatus` value. */
export type DecisionStatusFilter = "ALL" | "ACTIVE" | "SUPERSEDED";

export function filterDecisions(
  decisions: readonly RawDecision[],
  filter: DecisionStatusFilter,
): RawDecision[] {
  if (filter === "ALL") return [...decisions];
  return decisions.filter((decision) => decision.status === filter);
}

/** Every field `success_metrics` needs a unit for (PRD §5.12: "A
 *  `success_metric` field rejects a value with no unit.") — a client-side
 *  echo of the same rule the crate's closed schema enforces on write, so a
 *  form can refuse before round-tripping to Rust. */
export function isValidSuccessMetric(metric: RawSuccessMetric): boolean {
  return metric.name.trim().length > 0 && metric.unit.trim().length > 0;
}

/** A brief with nothing authored yet — PRD §5.12's two required fields both
 *  empty. `schematify/load-graph` reports `brief: null` for a project that
 *  has never written one; this is what a form opens on instead of `null`. */
export function emptyBrief(): RawProjectBrief {
  return {
    product_name: "",
    problem: "",
    users: [],
    goals: [],
    non_goals: [],
    constraints: [],
    success_metrics: [],
  };
}
