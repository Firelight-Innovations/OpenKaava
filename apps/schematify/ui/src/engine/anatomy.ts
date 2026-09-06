/**
 * Node anatomy (PRD §12.6, §12.7, §12.8) — Wave 4. Every function here is
 * pure and takes plain data, so it is what `frame.test.ts`-style tests exert
 * directly and what `frame.ts` calls to fill in `DrawnNode`. Nothing in this
 * file touches the DOM; `SchematicCanvas.tsx` only maps what is computed here
 * onto markup, per that file's own "the renderer decides nothing" rule.
 *
 * PRD §12.7's badge, count, and caption text is drawn verbatim from
 * WIREFRAME-EXTRACT.md §1.1 and §2.2 — every literal string below is copied
 * from there, not composed loosely, so a test can compare literally.
 */
import { plural } from "../graph";
import type { FacetCounts, HealthStatus, Layer, Lifecycle, Tier } from "../graph";
import { descendantsOf } from "./doc";
import type { DocIndex, SchematicNode } from "./doc";
import type { Rect } from "./geometry";
import type { Size } from "./config";

/** The fields `badgesFor`, `countStringsFor` and `captionFor` read. A
 *  structural subset of `SchematicNode` rather than the type itself, so a
 *  unit test can hand these functions a bare object without building a whole
 *  document — the FRONTEND/EXTERNAL badge test (PRD §17 Wave 4's own
 *  acceptance condition) is exactly that: a node no fixture holds. */
export interface AnatomyNode {
  slug: string;
  kind: string;
  role?: "entry-point" | "schematic-root";
  layer?: Layer;
  lifecycle?: Lifecycle;
  authoredBy?: "human" | "agent";
  description?: string;
  facets?: FacetCounts;
  libraries?: readonly string[];
  exportsCount?: number;
  modulesCount?: number;
  dependentsCount?: number;
  sharedAtLca?: boolean;
  schemasResolved?: boolean;
  deprecatedSuccessor?: string;
  staleReason?: string;
  health?: HealthStatus;
  exported?: boolean;
  budgetTier?: "hard" | "soft";

  // --- PRD §12.11 facet content (Wave 5), tier 3 only -----------------------

  signature?: string;
  returns?: string;
  budgetThresholdText?: string;
  budgetProbe?: string;
  budgetValueText?: string;
  testStatus?: "passing" | "failing";
  docAudience?: string;
  docBody?: string;
  depVersion?: string;
  depLicense?: string;
  depRegistryOk?: boolean;
  screenRef?: string;
}

const LAYER_BADGE: Record<Layer, string> = {
  edge: "EDGE",
  backend: "BACKEND",
  data: "DATA",
  frontend: "FRONTEND",
  external: "EXTERNAL",
};

/**
 * The closed badge set (PRD §12.6's table). Order matches the table's own
 * reading order. `tier` decides `ENTRY` vs `ENTRY POINT` (PRD §12.6: one
 * badge names the Stack Schematic's entry service, the other the Service
 * Schematic's entry point) and whether a layer badge draws at all — PRD
 * §12.6's closing line extends the layer badge to "both tiers" (stack and
 * service), never tier 3.
 *
 * `◇ AGENT` (lifecycle `assigned`) and `◇ AGENT DRAFT` (`authored_by`
 * `agent`) are 2 separate rows of the PRD table with 2 separate conditions,
 * but WIREFRAME-EXTRACT.md §1.1's Rate Limiter — `assigned` and agent-
 * authored at once — draws only the more specific `◇ AGENT DRAFT`, not both
 * diamonds side by side. `[P]`: read as "AGENT DRAFT supersedes the plain
 * AGENT badge when both conditions hold," recorded in the Wave 4 handoff.
 */
export function badgesFor(node: AnatomyNode, tier: Tier): string[] {
  const badges: string[] = [];
  if (node.role === "entry-point") {
    badges.push(tier === "stack" ? "📌 ENTRY" : "📌 ENTRY POINT");
  }
  if (node.sharedAtLca) badges.push("SHARED · AT LCA");
  if (node.layer && tier !== "module") badges.push(LAYER_BADGE[node.layer]);
  if (node.authoredBy === "agent") {
    badges.push("◇ AGENT DRAFT");
  } else if (node.lifecycle === "assigned") {
    badges.push("◇ AGENT");
  }
  if (node.role === "schematic-root" && tier === "module") {
    badges.push("MODULE ROOT · CANNOT BE DELETED");
  }
  if (node.kind === "contract-method" && node.exported) badges.push("EXPORTED");
  if (node.kind === "budget" && node.budgetTier) {
    badges.push(node.budgetTier === "hard" ? "HARD" : "SOFT");
  }
  return badges;
}

/**
 * The facet-count row's chips, tier 2 only (PRD §12.6): `⬤ 3 meth`,
 * `⬤ 5 test`, `⬤ 2 budg`, one entry per facet type the node actually
 * carries — JWKS Cache draws 2 chips, not 3 with a `0 budg`, so an absent
 * count draws no chip at all rather than a zero one.
 */
export function facetChipsFor(facets: FacetCounts | undefined): string[] {
  if (!facets) return [];
  const chips: string[] = [];
  if (facets.methods !== undefined) chips.push(`⬤ ${facets.methods} meth`);
  if (facets.tests !== undefined) chips.push(`⬤ ${facets.tests} test`);
  if (facets.budgets !== undefined) chips.push(`⬤ ${facets.budgets} budg`);
  return chips;
}

/**
 * Every other count string PRD §12.6 lists, in the node's own reading order.
 * `contains N`, `collapsed · N children` and `N edges aggregated` are
 * `frame.ts`'s own business (they need the document index, not just the
 * node), so they are not duplicated here.
 */
export function countStringsFor(node: AnatomyNode): string[] {
  const out: string[] = [];
  if (node.exportsCount !== undefined) out.push(plural(node.exportsCount, "export"));
  if (node.modulesCount !== undefined) out.push(plural(node.modulesCount, "module"));
  if (node.dependentsCount !== undefined) out.push(plural(node.dependentsCount, "dependent"));
  if (node.schemasResolved) out.push("schemas ✓");
  return out;
}

/** One caption, drawn where a state carries a reason (PRD §12.6). At most 1
 *  — the table's own priority order, highest first: `stale` outranks every
 *  other state, since staleness is a linter-relevant contract breach and not
 *  merely a lifecycle position. */
export interface Caption {
  primary: string;
  secondary?: string;
}

export function captionFor(node: AnatomyNode): Caption | undefined {
  if (node.lifecycle === "stale") {
    return { primary: "⚠ STALE — upstream contract changed", secondary: node.staleReason };
  }
  if (node.authoredBy === "agent") {
    return { primary: "Pre-filled by agent. Not reviewed." };
  }
  if (node.lifecycle === "deprecated" && node.deprecatedSuccessor) {
    return { primary: `${node.slug} → ${node.deprecatedSuccessor}` };
  }
  if (node.lifecycle === "reviewed") {
    return { primary: "reviewed · awaiting accept" };
  }
  if (node.lifecycle === "draft") {
    if (node.kind === "service" && (node.exportsCount ?? 0) === 0) {
      return { primary: "draft · 0 exports authored" };
    }
    if (node.health === undefined || node.health === "no-data") {
      return { primary: "draft · no run data" };
    }
  }
  return undefined;
}

// --- lifecycle rendering (PRD §12.7) ----------------------------------------

/**
 * How one lifecycle state draws, entirely in shape rather than colour: a
 * `--kv-*` token still names the colour a state happens to use, but every
 * field a sighted-with-colour-removed reader needs is a discrete geometric
 * choice — border style and weight, whether the header dot is a ring or a
 * disc, which (if any) glyph sits in the header, how wide the bottom-edge
 * fill runs, whether a diagonal stripe overlays the card, the card's own
 * opacity, and whether the title is struck through.
 */
export interface LifecycleTreatment {
  borderStyle: "solid" | "dashed";
  borderWidthPx: 1 | 1.5;
  /** A `--kv-*` token. Colour, never the only cue — WIREFRAME-EXTRACT.md
   *  §8.2 rules the per-state dot fill "a redundant cue," and this token is
   *  that same redundancy applied to the border. Deliberately excluded from
   *  `lifecycleSignature`, which proves the 8 states apart without it. */
  borderToken: string;
  dotFill: "hollow" | "filled";
  /** A `--kv-*` token for the dot, same redundant-cue status as
   *  `borderToken`. */
  dotToken: string;
  /** `reviewed` draws its dot at 55% (WIREFRAME-EXTRACT.md §2.2); every
   *  other state is fully opaque. */
  dotOpacityPct: 55 | 100;
  headerGlyph: "" | "◇" | "◐" | "✓" | "⚠";
  /** 0 draws no bottom-edge fill at all. */
  bottomFillPct: 0 | 64 | 100;
  /** A `--kv-*` token, or `""` when `bottomFillPct` is 0. */
  bottomFillToken: string;
  overlayStripe: boolean;
  opacityPct: 100 | 40;
  titleStruck: boolean;
  /** The wireframe's own reference-sheet caption (WIREFRAME-EXTRACT.md
   *  §2.2), e.g. `draft — dashed, muted fill`. */
  legendCaption: string;
}

/** The 8 states (PRD §7.1, §12.7), each drawn from
 *  WIREFRAME-EXTRACT.md §2.2's example-card table. */
export const LIFECYCLE_TREATMENTS: Record<Lifecycle, LifecycleTreatment> = {
  draft: {
    borderStyle: "dashed",
    borderWidthPx: 1,
    borderToken: "--kv-line-draft",
    dotFill: "hollow",
    dotToken: "--kv-text-faint",
    dotOpacityPct: 100,
    headerGlyph: "",
    bottomFillPct: 0,
    bottomFillToken: "",
    overlayStripe: false,
    opacityPct: 100,
    titleStruck: false,
    legendCaption: "draft — dashed, muted fill",
  },
  specified: {
    borderStyle: "solid",
    borderWidthPx: 1,
    borderToken: "--kv-line",
    dotFill: "filled",
    dotToken: "--kv-text-secondary",
    dotOpacityPct: 100,
    headerGlyph: "",
    bottomFillPct: 0,
    bottomFillToken: "",
    overlayStripe: false,
    opacityPct: 100,
    titleStruck: false,
    legendCaption: "specified — solid, neutral",
  },
  assigned: {
    borderStyle: "solid",
    borderWidthPx: 1,
    borderToken: "--kv-line",
    dotFill: "filled",
    dotToken: "--kv-text-secondary",
    dotOpacityPct: 100,
    // No inline glyph: WIREFRAME-EXTRACT.md §1.1's Rate Limiter draws exactly
    // 1 diamond, and `badgesFor` already guarantees one (`◇ AGENT` or
    // `◇ AGENT DRAFT`) for every assigned node — see `hasGuaranteedBadge`.
    // Drawing "◇" here too would be a 2nd, redundant diamond.
    headerGlyph: "",
    bottomFillPct: 0,
    bottomFillToken: "",
    overlayStripe: false,
    opacityPct: 100,
    titleStruck: false,
    legendCaption: "assigned — agent glyph",
  },
  implemented: {
    borderStyle: "solid",
    borderWidthPx: 1,
    borderToken: "--kv-line",
    dotFill: "filled",
    dotToken: "--kv-warn",
    dotOpacityPct: 100,
    headerGlyph: "",
    bottomFillPct: 64,
    bottomFillToken: "--kv-accent",
    overlayStripe: false,
    opacityPct: 100,
    titleStruck: false,
    legendCaption: "implemented — filled edge",
  },
  reviewed: {
    borderStyle: "solid",
    borderWidthPx: 1,
    borderToken: "--kv-line",
    dotFill: "filled",
    dotToken: "--kv-ok",
    dotOpacityPct: 55,
    headerGlyph: "◐",
    bottomFillPct: 100,
    bottomFillToken: "--kv-line-draft",
    overlayStripe: false,
    opacityPct: 100,
    titleStruck: false,
    legendCaption: "reviewed — half check",
  },
  accepted: {
    borderStyle: "solid",
    borderWidthPx: 1.5,
    borderToken: "--kv-ok",
    dotFill: "filled",
    dotToken: "--kv-ok",
    dotOpacityPct: 100,
    headerGlyph: "✓",
    bottomFillPct: 100,
    bottomFillToken: "--kv-ok",
    overlayStripe: false,
    opacityPct: 100,
    titleStruck: false,
    legendCaption: "accepted — full check, saturated",
  },
  stale: {
    borderStyle: "solid",
    borderWidthPx: 1.5,
    borderToken: "--kv-ok",
    dotFill: "filled",
    dotToken: "--kv-ok",
    dotOpacityPct: 100,
    headerGlyph: "⚠",
    bottomFillPct: 100,
    bottomFillToken: "--kv-warn",
    overlayStripe: true,
    opacityPct: 100,
    titleStruck: false,
    legendCaption: "stale — accepted + stripe",
  },
  deprecated: {
    borderStyle: "solid",
    borderWidthPx: 1,
    borderToken: "--kv-line",
    dotFill: "filled",
    dotToken: "--kv-text-faint",
    dotOpacityPct: 100,
    headerGlyph: "",
    bottomFillPct: 0,
    bottomFillToken: "",
    overlayStripe: false,
    opacityPct: 40,
    titleStruck: true,
    legendCaption: "deprecated — 40%, struck",
  },
};

/** A colour-blind fingerprint of a treatment: every field but the token
 *  names (a token names a colour, and the whole point of this function is to
 *  prove the states differ without one). Two states are indistinguishable
 *  with colour removed exactly when this string collides. */
export function lifecycleSignature(t: LifecycleTreatment): string {
  return [
    t.borderStyle,
    t.borderWidthPx,
    t.dotFill,
    t.headerGlyph,
    t.bottomFillPct,
    t.overlayStripe,
    t.opacityPct,
    t.titleStruck,
  ].join("|");
}

/**
 * True only for `assigned` — the one state whose distinguishing mark from
 * `specified` is not a field on its own `LifecycleTreatment` at all, but a
 * badge `badgesFor` guarantees: every assigned node draws `◇ AGENT`, or
 * `◇ AGENT DRAFT` in place of it when also agent-authored (that function's
 * own precedence rule), so the header draws no separate glyph of its own —
 * see the `assigned` row's comment above. `lifecycleSignature` alone cannot
 * tell `assigned` and `specified` apart any more, since every other field the
 * 2 states carry is now identical; a distinctness test combines this flag
 * with the signature rather than dropping the guarantee silently.
 */
export function hasGuaranteedBadge(state: Lifecycle): boolean {
  return state === "assigned";
}

// --- health rendering (PRD §12.8) -------------------------------------------

/** Which of the 4 wedge treatments a health value draws. `passing` and
 *  `undefined` both draw none — most nodes carry no health field at all, and
 *  that reads the same as an explicit `passing`. */
export function healthWedgeFor(health: HealthStatus | undefined): HealthStatus {
  return health ?? "passing";
}

const HEALTH_RANK: Record<HealthStatus, number> = {
  passing: 0,
  "no-data": 1,
  "soft-fail": 2,
  "hard-fail": 3,
};

const HEALTH_ROLLUP_WORDS: Record<Exclude<HealthStatus, "passing">, string> = {
  "no-data": "no run data",
  "soft-fail": "soft budget trending",
  "hard-fail": "hard budget failing",
};

/**
 * A service node's health, rolled up as the worst status of any contained
 * module, stated in words (PRD §12.8: "The node face states that status in
 * words and draws a wedge.") `[P]`: the exact wording
 * (`worst contained: N <words> trending`) generalises WIREFRAME-EXTRACT.md
 * §1.1's one drawn example (`worst contained: 1 soft budget trending`,
 * Auth Service on the Stack Schematic) to the other 2 non-passing statuses,
 * since no source gives their wording. Recorded in the Wave 4 handoff. Not
 * reachable through this wave's Service Schematic fixture — no node in it is
 * `service`-kind — so this is tested directly against a synthetic document
 * for Wave 5 to call once the Stack Schematic exists.
 */
export function healthRollupFor(serviceNode: SchematicNode, index: DocIndex): Caption | undefined {
  let worst: HealthStatus = "passing";
  let count = 0;
  for (const node of descendantsOf(index, serviceNode.id)) {
    if (node.kind !== "module") continue;
    const health = node.health ?? "passing";
    if (HEALTH_RANK[health] > HEALTH_RANK[worst]) {
      worst = health;
      count = 1;
    } else if (health === worst && worst !== "passing") {
      count += 1;
    }
  }
  if (worst === "passing") return undefined;
  return { primary: `worst contained: ${count} ${HEALTH_ROLLUP_WORDS[worst]}` };
}

// --- the 3 zoom tiers (PRD §12.7) -------------------------------------------

export type ZoomTier = "full" | "mid" | "geometry";

/**
 * `full` draws everything; `mid` drops the description, the facet row and
 * the library row (title, slug and state survive); `geometry` drops text
 * entirely, leaving border weight, the bottom-edge fill, the overlay stripe
 * and the health wedge (PRD §12.7, WIREFRAME-EXTRACT.md §2.4).
 *
 * `[P]`: the wireframe's 3 reference points (100%, 55%, 22%) are an exhibit
 * on screen 1b, not stated as literal runtime thresholds, and reading them
 * that literally would drop the facet row at the Service Schematic's own
 * default 68% zoom (SERVICE_CONFIG.zoom.initial) — contradicting
 * WIREFRAME-EXTRACT.md §1.1, which draws facet counts on that exact screen at
 * that exact zoom. The boundaries below instead sit at the 2 reference
 * points themselves (`> 0.55` is `full`, so 68% and 100% both qualify;
 * `> 0.22` is `mid`; the rest is `geometry`, so the acceptance condition's
 * own value, 22%, lands there) — the reference points bound tiers rather
 * than naming exact breakpoints. Recorded in the Wave 4 handoff as the
 * surface a human should confirm.
 */
export function zoomTierFor(zoom: number): ZoomTier {
  if (zoom > 0.55) return "full";
  if (zoom > 0.22) return "mid";
  return "geometry";
}

// --- the screen reference (PRD §12.5), wave 10c -----------------------------

/**
 * The Service Schematic's own form of a `references_ui` reference: a
 * labelled chip, `◈ SCREEN` above `screen/<slug>` — PRD §12.5, renamed from
 * the wireframe's own `◈ JOURNEYMAN`. A `kind: "screen"` node draws as this
 * chip and nothing else (`SchematicCanvas.tsx`'s `NodeBox`): "a screen
 * reference is a reference and never an editor," so it carries no lifecycle
 * treatment, no ports, no badges.
 */
export const SCREEN_CHIP_LABEL = "◈ SCREEN";

/**
 * The id half of a `schematify://screen/<id>` reference, or `null` for
 * anything that does not parse as one. Used for the module root's own
 * screen-reference path (`frame.ts`'s `screenReferenceId`, PRD §12.11) —
 * the plain-text form, as opposed to the chip above, which already carries
 * its own id as a real node. Restated rather than imported from
 * `../product/index.ts`'s `uriId`: `engine/` stays self-contained, the same
 * layering `product/` already respects by depending on `engine/ids` and
 * never the reverse.
 */
export function screenReferenceId(uri: string): string | null {
  const match = /^schematify:\/\/screen\/(.+)$/i.exec(uri);
  return match ? match[1] : null;
}

// --- header geometry: the health wedge never reaches the node menu ---------

/** The wireframe's own corner triangle (WIREFRAME-EXTRACT.md §1.3: "14px
 *  corner triangle"). */
export const HEALTH_WEDGE_SIZE = 14;
/** The `[⋯]` node-menu control's own square hit area. No wireframe measures
 *  it; `[P]`, sized to sit comfortably inside the 34px+ header row every
 *  node kind draws. */
export const NODE_MENU_SIZE = 12;
/** The gap kept between the wedge's own corner and the node menu, so the 2
 *  top-right occupants WIREFRAME-EXTRACT.md §2.4 names never touch even at
 *  the smallest node width this app draws. */
export const NODE_MENU_INSET = 4;

export interface HeaderOccupants {
  wedge: Rect | null;
  menu: Rect;
}

/**
 * Where the health wedge and the node menu sit, in the node's own local
 * coordinates (top-left `0,0`). The wedge is pinned to the exact top-right
 * corner (PRD §12.6: "the upper corner opposite the ports... holds that
 * corner alone"); the menu sits inside the header row, shifted left of the
 * wedge by its own width plus `NODE_MENU_INSET` so the 2 can never overlap —
 * `anatomy.test.ts` proves that geometrically across every node width this
 * app draws rather than trusting the arithmetic here.
 */
export function headerOccupants(box: Size, hasWedge: boolean): HeaderOccupants {
  const wedge: Rect | null = hasWedge
    ? {
        x: box.width - HEALTH_WEDGE_SIZE,
        y: 0,
        width: HEALTH_WEDGE_SIZE,
        height: HEALTH_WEDGE_SIZE,
      }
    : null;
  const clearance = hasWedge ? HEALTH_WEDGE_SIZE + NODE_MENU_INSET : NODE_MENU_INSET;
  const menu: Rect = {
    x: box.width - clearance - NODE_MENU_SIZE,
    y: NODE_MENU_INSET,
    width: NODE_MENU_SIZE,
    height: NODE_MENU_SIZE,
  };
  return { wedge, menu };
}

// --- content-derived sizing (PRD §12.6; config.ts: "Wave 4 sizes a node
// from its content") ---------------------------------------------------------

/** Which optional rows a node's content adds beyond the header and slug
 *  every node draws. */
export interface NodeContent {
  hasDescription?: boolean;
  hasFacets?: boolean;
  hasLibraries?: boolean;
  hasCaption?: boolean;
}

/** Fixed per-row growth, in world px. `[P]`: no wireframe states these as
 *  independent constants (WIREFRAME-EXTRACT.md §1.2 gives 1 finished box size
 *  per drawn node, not a row-height ladder to derive one from), so this is an
 *  engineering estimate sized to fit the content each row actually draws.
 *  Recorded in the Wave 4 handoff. */
const ROW_GROWTH = { description: 24, facets: 16, libraries: 14, caption: 16 } as const;

/** Grows a kind's base box to fit whichever optional rows this node's
 *  content adds. A node with no description, no facets, no libraries and no
 *  caption keeps exactly the base size — the same box Wave 3 drew. */
export function contentBox(base: Size, content: NodeContent): Size {
  let height = base.height;
  if (content.hasDescription) height += ROW_GROWTH.description;
  if (content.hasFacets) height += ROW_GROWTH.facets;
  if (content.hasLibraries) height += ROW_GROWTH.libraries;
  if (content.hasCaption) height += ROW_GROWTH.caption;
  return { width: base.width, height };
}

// --- facet card content (PRD §12.11), tier 3 only ---------------------------

/**
 * The content lines one facet card draws, in the node's own reading order —
 * PRD §12.11's per-kind sentence, quoted almost verbatim. A kind this
 * function does not recognise (a module, a service, an annotation node) draws
 * none, which is correct: only the 5 facet kinds have card content at all.
 *
 * `contract-method`'s covers line takes its count as a parameter — computed
 * by the caller from real `covers` edges (`coversCountFor`, below), never
 * stored on the node (PRD §0.4). `0` is what a method with no such edge
 * passes; that reads identically to omitting the argument.
 */
export function facetContentFor(node: AnatomyNode, coversCount = 0): string[] {
  switch (node.kind) {
    case "contract-method": {
      const call = `${node.signature ?? "()"} → ${node.returns ?? "void"}`;
      const covers =
        coversCount > 0
          ? `✓ ${coversCount} covers · matched in code`
          : "▲ no covers edge from any test case";
      return [call, covers];
    }
    case "budget": {
      const lines: string[] = [];
      if (node.budgetThresholdText) lines.push(`${node.slug} ${node.budgetThresholdText}`);
      if (node.budgetProbe) lines.push(`probe: ${node.budgetProbe}`);
      lines.push(node.budgetValueText ?? "—");
      return lines;
    }
    case "test-case":
      return node.testStatus ? [node.testStatus] : [];
    case "doc-block": {
      const lines: string[] = [];
      if (node.docAudience) lines.push(`audience: ${node.docAudience}`);
      if (node.docBody) lines.push(node.docBody);
      return lines;
    }
    case "external-dep": {
      const name = node.depVersion ? `${node.slug}@${node.depVersion}` : node.slug;
      if (!node.depLicense) return [name];
      return [name, `${node.depLicense} · registry ${node.depRegistryOk ? "✓" : "✗"}`];
    }
    default:
      return [];
  }
}

// --- the coverage readout and the SATISFIES callout (PRD §12.11) -----------

export interface Callout {
  heading: string;
  body: string;
}

/** Both numbers PRD §17 Wave 5's own acceptance condition names: "the
 *  coverage readout computes `7 of 8` on the fixture." Both are computed
 *  here, every frame, from whatever contract-methods the module actually
 *  holds — never stored (PRD §0.4).
 *
 *  **The formula.** A method with at least 1 covers edge contributes its own
 *  count to both `present` and `expected` — fully satisfied, no gap. A
 *  method with 0 contributes `0` to `present` and `1` to `expected`: PRD
 *  §11.1's own sentence, "a test-case joined by covers to a contract-method
 *  yields coverage of design," reads a covers-less method as owing at least
 *  1 covering edge, so it counts as exactly 1 missing slot rather than 0
 *  (which would make it invisible to the ratio) or its sibling methods'
 *  count (which no source suggests). Against PRD §16.1's own numbers
 *  (`verify_signature` 4, `refresh_keys` 3, `skew_window` 0) this gives
 *  `present = 4 + 3 + 0 = 7` and `expected = 4 + 3 + 1 = 8` — the wireframe's
 *  drawn `7 of 8` exactly, reached by computation rather than transcription.
 *  `[P]`, since no source states the formula itself; recorded in the Wave 5
 *  handoff as the one number a human should re-derive independently. */
export interface CoverageReadout {
  present: number;
  expected: number;
  /** Slugs of every contract-method with 0 covers edges, in document order —
   *  what the body sentence names. */
  uncovered: readonly string[];
}

/** A structural edge subset — `kind`/`to` are all a covers count needs, the
 *  same narrowing `AnatomyNode` itself already applies to a node. */
export interface CoversEdge {
  kind: string;
  to: string;
}

/** How many `covers` edges target `contractMethodId` — computed here, at
 *  draw time, from the document's real edges (PRD §0.4). Wave 5 stored this
 *  as a `coversCount` field directly on the node; Wave 6 replaces that with
 *  this function, so the fixture now has to earn the count with a real
 *  edge per test case rather than asserting it. */
export function coversCountFor(contractMethodId: string, edges: readonly CoversEdge[]): number {
  return edges.filter((edge) => edge.kind === "covers" && edge.to === contractMethodId).length;
}

export function coverageOf(
  contractMethods: readonly { id: string; slug: string }[],
  edges: readonly CoversEdge[],
): CoverageReadout {
  let present = 0;
  let expected = 0;
  const uncovered: string[] = [];
  for (const method of contractMethods) {
    const count = coversCountFor(method.id, edges);
    present += count;
    expected += count > 0 ? count : 1;
    if (count === 0) uncovered.push(method.slug);
  }
  return { present, expected, uncovered };
}

/** PRD §12.11's exact body sentence, generalised from its 1 drawn example
 *  (`skew_window has none — the number line coverage never reports.`) to
 *  however many (0, 1, or several) methods carry 0 covers edges. `[P]`,
 *  recorded in the Wave 5 handoff. */
export function coverageBody(readout: CoverageReadout): string {
  const lead = `${readout.present} of ${readout.expected} covers edges present.`;
  if (readout.uncovered.length === 0) return lead;
  return `${lead} ${readout.uncovered.join(", ")} ${readout.uncovered.length === 1 ? "has" : "have"} none — the number line coverage never reports.`;
}

/** PRD §11.1, quoted exactly — a fixed explanation of the tier's closed edge
 *  vocabulary, not a computed value, so it needs no formula and no per-module
 *  input. */
export const SATISFIES_CALLOUT: Callout = {
  heading: "SATISFIES",
  body: "A dep can satisfy a budget. Edge types at tier 3 are closed: covers, satisfies, documents.",
};

// --- the shared-node callout (PRD §4.3), stack tier ------------------------

const DEPENDENT_WORDS: Record<number, string> = {
  1: "One",
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
};

/** PRD §4.3's callout, generalised off its 1 drawn example (`event-bus`,
 *  4 dependents) to any shared node's own dependent count and slug. The
 *  heading names the *slug*, not the title — PRD §4.3's own literal text is
 *  `WHY EVENT-BUS SITS HERE`, the hyphenated slug form, not `EVENT BUS`.
 *  Reduces to that exact string when `slug` is `event-bus` and
 *  `dependentsCount` is 4. `[P]`: the numeral-to-word table and the heading
 *  template are this wave's own generalisation, not a second wireframe
 *  example to copy from; recorded in the Wave 5 handoff. */
export function sharedNodeCallout(slug: string, dependentsCount: number): Callout {
  const word = DEPENDENT_WORDS[dependentsCount] ?? String(dependentsCount);
  return {
    heading: `WHY ${slug.toUpperCase()} SITS HERE`,
    body: `${word} consumers, so its containment parent is their lowest common ancestor — the stack root — not any one of them. Same rule at tier 2.`,
  };
}

/** Reads the content flags straight off an `AnatomyNode`, so a caller does
 *  not have to duplicate the "what counts as content" rules `contentBox`
 *  itself does not know. Takes the full `AnatomyNode` shape (rather than
 *  just the 3 fields it inspects directly) because `hasCaption` reruns
 *  `captionFor`'s own priority rule, which reads lifecycle, health and
 *  authorship too. */
export function contentOf(node: AnatomyNode): NodeContent {
  return {
    hasDescription: Boolean(node.description),
    hasFacets: Boolean(
      node.facets &&
      (node.facets.methods !== undefined ||
        node.facets.tests !== undefined ||
        node.facets.budgets !== undefined),
    ),
    hasLibraries: Boolean(node.libraries && node.libraries.length > 0),
    hasCaption: Boolean(captionFor(node)),
  };
}
