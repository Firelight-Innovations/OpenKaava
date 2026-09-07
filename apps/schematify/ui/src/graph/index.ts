/**
 * The one narrow seam between the shell and the graph, ahead of a real loader.
 * PRD §17 Wave 2 needs the shell to "open" `fixtures/saas-backend/`, but
 * `crates/schematify-core`'s loader (PRD §6.4) is on a branch that has not
 * merged, and `00-AGENT-CONTEXT.md` forbids importing that crate.
 *
 * Deliberately pure: nothing here imports `@openkaava/bridge`, so this module
 * unit-tests under plain Node without a `window`. `./backend.ts` is this app's
 * other half, and its only door to Rust.
 *
 * The functions below `loadGraph` read no fixture themselves — they compute
 * from whatever `ServiceGraph` they are given, per PRD §0.4.
 *
 * Wave 3 widened the seam from a loader to a loader *and* a writer without
 * widening it to 2 modules: `SchematifySeam` at the foot of this file is every
 * read and every write the Schematic engine makes.
 */
import type { Dashboard, RawRunsReport } from "./dashboard";
import { DENSE_SERVICE_GRAPH } from "./dense";
import { AUTH_SERVICE_GRAPH } from "./fixture";
import { MODULE_GRAPH } from "./module";
import type { RawLintReport } from "./problems";
import { STACK_GRAPH } from "./stack";
import type { LayoutFile } from "./layout";
import { isAnnotationNodeKind } from "./types";
import type { GraphNode, SchematicGraph, ServiceGraph, Tier } from "./types";

export type {
  ContractMethodSummary,
  ExportRow,
  FacetCounts,
  GraphEdge,
  GraphNode,
  HealthStatus,
  Layer,
  LibraryDetail,
  Lifecycle,
  LifecycleAuditRow,
  NodeKind,
  OutlineBadge,
  SchematicGraph,
  ServiceGraph,
  TechStackRow,
  Tier,
} from "./types";
export { ANNOTATION_NODE_KINDS, isAnnotationNodeKind } from "./types";

export type { LayoutAnnotation, LayoutFile, LayoutNode, LayoutViewport } from "./layout";
export { emptyLayout, layoutPath } from "./layout";

export type {
  ClickThrough,
  Finding,
  Location,
  NavigationTarget,
  ProblemBadges,
  RawFinding,
  RawLintReport,
  Severity,
} from "./problems";
export {
  drillTargetForLocation,
  locationCell,
  problemBadges,
  projectFindings,
  resolveClickThrough,
  severityGlyph,
  severityWord,
  statusCell3,
  subjectId,
} from "./problems";

export type {
  AuditLogRow,
  BudgetHistoryRow,
  ContractHistoryRow,
  Dashboard,
  DashboardBudgetCounter,
  DashboardLinterCounter,
  DashboardModule,
  DashboardReconciliationCounter,
  DashboardRun,
  DashboardTestCounter,
  RawRunsReport,
  ReconciliationRow,
  RunsRow,
} from "./dashboard";
export {
  auditActorCell,
  auditTransition,
  budgetLatestValue,
  budgetsCounter,
  budgetsNote,
  budgetThreshold,
  contractHistory,
  formatRunAt,
  latestRunLine,
  linterCounter,
  linterNote,
  noProbeCaption,
  reconciliationCounter,
  reconciliationNote,
  relativeTime,
  runsPathLine,
  shortDate,
  signOffCaption,
  statusCell4,
  testsCounter,
  testsNote,
} from "./dashboard";

/** Every service-tier fixture this stand-in loader knows, keyed by slug.
 *  Wave 5 widens this from the 1 hardcoded service Wave 2/3 opened
 *  unconditionally to a lookup, so a drill-down from the Stack Schematic to a
 *  service this fixture has no content for still opens (empty) instead of
 *  throwing. Real content exists only for `auth-service`, the one the
 *  wireframe draws in full. */
const SERVICE_GRAPHS: Readonly<Record<string, SchematicGraph>> = {
  "auth-service": AUTH_SERVICE_GRAPH,
};

/** Every module-tier fixture this stand-in loader knows, keyed by slug. Real
 *  content exists only for `token-verifier`, the one WIREFRAME-EXTRACT.md §4
 *  draws. */
const MODULE_GRAPHS: Readonly<Record<string, SchematicGraph>> = {
  "token-verifier": MODULE_GRAPH,
};

/** What a slug this loader has no fixture for opens to: a Schematic with a
 *  root and nothing else, rather than a crash. A real loader's quarantine
 *  (PRD §6.4) is where an unknown slug gets handled properly; this stand-in
 *  only has to not throw. */
function emptyGraph(tier: Tier, slug: string): SchematicGraph {
  return { tier, serviceSlug: slug, serviceTitle: slug, nodes: [], edges: [] };
}

/**
 * Returns one Schematic's graph, by tier and slug: the hand-typed fixture in
 * `./stack.ts`, `./fixture.ts` or `./module.ts`, shaped exactly like the
 * eventual real answer and returned as a `Promise` so a later
 * `invoke("schematify/load-graph", { tier, slug })` call (through
 * `./backend.ts`) is a drop-in. **A later wiring wave replaces only this
 * function's body** — every caller reads the graph through this module and
 * never imports a fixture file directly, so nothing else changes when a real
 * loader lands.
 *
 * Both parameters default to Wave 2/3's original single fixture
 * (`service`/`auth-service`), so every call site written before Wave 5 —
 * `seam.loadGraph()` with no arguments, all across this app's test suite —
 * keeps reading exactly what it always has.
 */
export function loadGraph(
  tier: Tier = "service",
  slug: string = "auth-service",
): Promise<SchematicGraph> {
  if (tier === "stack") return Promise.resolve(STACK_GRAPH);
  if (tier === "module") return Promise.resolve(MODULE_GRAPHS[slug] ?? emptyGraph("module", slug));
  return Promise.resolve(SERVICE_GRAPHS[slug] ?? emptyGraph("service", slug));
}

/** The `.kaava/` storage root every tier's status-bar cell 1 names (PRD
 *  §6.1: "Decision SCH-ARC-003 changes the root to `.kaava/`. Wave 2 draws
 *  `.kaava/` in that cell."). */
export const KAAVA_ROOT = ".kaava/";

/** `1 service`, `2 services`. Every count string this app draws is built by
 *  interpolating a number in front of a noun, and each one was written with
 *  the noun already plural — correct for the fixtures, where every count
 *  happens to be above 1, and wrong the moment a real project has one of
 *  something. The Stack Schematic is where that first shows: several services
 *  in this repository hold exactly 1 module.
 *
 *  PRD §12.13 and §12.20 draw `1 module` and `1 service` in their own
 *  examples, so this agrees with the source rather than departing from it.
 *  Most nouns here take a bare `s`, so that is the default; `child` does not,
 *  and it passes its own plural rather than making this grow a rule table. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Node count, computed rather than cached on the graph — PRD §0.4.
 *  Excludes annotation-tier kinds (`isAnnotationNodeKind`): a `group` is
 *  drawn on the Schematic but is not a node for counting purposes, per the
 *  owner's ruling on the wave 2 acceptance count — "it arranges and it
 *  annotates, it does not mean". The stand-in fixture has no group node,
 *  so this changes no existing count; `project.ts`'s real projection does
 *  carry one, `token-pipeline`, and this is what keeps it undrawn from the
 *  status bar's arithmetic while still present in `graph.nodes` to draw. */
export function countNodes(graph: ServiceGraph): number {
  return graph.nodes.filter((node) => !isAnnotationNodeKind(node.kind)).length;
}

/** Edge count, computed rather than cached on the graph — PRD §0.4. */
export function countEdges(graph: SchematicGraph): number {
  return graph.edges.length;
}

/** How many `service`-kind nodes a Stack Schematic's graph holds (PRD §12.9).
 *  Computed rather than drawn, per WIREFRAME-EXTRACT.md Resolution 10.2's
 *  ruling on the wireframe's own undercounted `6 services` string. */
export function countServices(graph: SchematicGraph): number {
  return graph.nodes.filter((node) => node.kind === "service").length;
}

/** The Stack Schematic's own header line (PRD §12.9): `6 services · 7
 *  dependency edges`, both numbers computed. Wave 5. */
export function stackHeaderCounts(graph: SchematicGraph): string {
  return `${plural(countServices(graph), "service")} · ${plural(countEdges(graph), "dependency edge")}`;
}

/** Status bar cell 1: the storage root and the counts that suit the tier
 *  (PRD §12.1). The Stack Schematic counts services only, matching its own
 *  header (WIREFRAME-EXTRACT.md §5.1: `sdd/ · 6 services`, no edge count in
 *  that cell); the Service and Module Schematics count nodes and edges. */
export function statusCell1(graph: SchematicGraph): string {
  if (graph.tier === "stack") return `${KAAVA_ROOT} · ${plural(countServices(graph), "service")}`;
  return `${KAAVA_ROOT} · ${plural(countNodes(graph), "node")} · ${plural(countEdges(graph), "edge")}`;
}

/** Status bar cell 2: the layout file this Schematic's positions persist to
 *  (PRD §12.3), and its git status. Nothing writes a layout file yet this
 *  wave (that lands in Wave 3 behind `schematify_write_layout`), so "clean"
 *  is the only honest reading — there is no dirty state to report. */
export function statusCell2(graph: SchematicGraph, clean = true): string {
  return `layout/${graph.serviceSlug}.json ${clean ? "clean" : "modified"}`;
}

/**
 * Status bar cell 5: the honest half of the deliberate deferral
 * `graph/backend.ts`'s `createBackendSeam` doc comment and
 * `docs/overnight-jobs/overnight-2/handoffs/wiring.md` describe. A reparent,
 * a duplicate, or a dragged-in edge calls `seam.writeSemantic`/
 * `removeSemantic`, which stays an in-memory `Map` rather than a real
 * `nodes/`/`edges/` file — the engine's `semanticWrites` getter is exactly
 * the paths that map has touched this session. Blank once nothing has
 * touched it; once anything has, this cell says so in words rather than
 * leaving the gesture looking saved. `Set` rather than `.length` on the raw
 * array, because `semanticWrites` records one entry per write *event*
 * (including undo/redo replays of the same path), and what a person needs to
 * know is how many files are at risk, not how many times the engine wrote to
 * one.
 */
export function statusCell5(semanticWrites: readonly string[]): string {
  const affected = new Set(semanticWrites).size;
  if (affected === 0) return "";
  const noun = affected === 1 ? "change" : "changes";
  return `${affected} unsaved ${noun} — session only, lost on reload`;
}

/** Containment depth counting the service root itself as level 1, so a
 *  top-level module is level 2 and a module nested one level deeper is level
 *  3 — matching PRD §16.1's "Twelve module nodes, containment depth 3" for a
 *  service whose deepest nodes (`jwks-cache`, `session-codec`, …) sit exactly
 *  1 level under a top-level module.
 *
 *  Throws rather than looping forever if `parentId` describes a cycle — a
 *  hand-typed or malformed fixture should fail loudly here, not hang the
 *  tab. An unknown `parentId` (no node with that id) is treated as top-level
 *  rather than an error, since a real loader's quarantine (PRD §6.4) is the
 *  place a dangling reference gets handled, not this function. */
export function computeDepth(nodes: GraphNode[]): number {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();

  function levelOf(node: GraphNode, visiting: Set<string>): number {
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    if (visiting.has(node.id)) {
      throw new Error(`containment cycle at node ${node.id}`);
    }
    visiting.add(node.id);
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    const level = parent ? levelOf(parent, visiting) + 1 : 2;
    visiting.delete(node.id);
    memo.set(node.id, level);
    return level;
  }

  return nodes.reduce((max, node) => Math.max(max, levelOf(node, new Set())), 1);
}

/** The Outline footer string, e.g. `12 nodes · depth 3` (PRD §12.1). */
export function outlineFooter(graph: SchematicGraph): string {
  return `${plural(countNodes(graph), "node")} · depth ${computeDepth(graph.nodes)}`;
}

/** One flattened, indented row of the Outline tree, in the reading order
 *  `Outline.tsx` draws. */
export interface OutlineRow {
  node: GraphNode;
  /** 0 for a node directly under the service root. */
  depth: number;
  hasChildren: boolean;
  /** Present only on a collapsed parent — the count its trailing badge draws
   *  (PRD §12.1: "a bare child count on a collapsed parent"). */
  hiddenChildCount?: number;
}

/** Flattens `graph.nodes` into Outline rows: a node with children and no
 *  `collapsed: true` draws its children as their own rows right after it
 *  (recursively); a `collapsed: true` node draws no child rows at all and
 *  instead carries `hiddenChildCount`, the number of nodes underneath it. */
export function buildOutlineRows(graph: ServiceGraph): OutlineRow[] {
  const childrenOf = new Map<string | null, GraphNode[]>();
  for (const node of graph.nodes) {
    const bucket = childrenOf.get(node.parentId) ?? [];
    bucket.push(node);
    childrenOf.set(node.parentId, bucket);
  }

  function countDescendants(id: string): number {
    const kids = childrenOf.get(id) ?? [];
    return kids.reduce((sum, kid) => sum + 1 + countDescendants(kid.id), 0);
  }

  function walk(parentId: string | null, depth: number): OutlineRow[] {
    const kids = childrenOf.get(parentId) ?? [];
    return kids.flatMap((node) => {
      const kidsOfNode = childrenOf.get(node.id) ?? [];
      const hasChildren = kidsOfNode.length > 0;
      const row: OutlineRow = { node, depth, hasChildren };
      if (hasChildren && node.collapsed) {
        row.hiddenChildCount = countDescendants(node.id);
        return [row];
      }
      return [row, ...walk(node.id, depth + 1)];
    });
  }

  return walk(null, 0);
}

/**
 * Every read and every write the Schematic engine makes, in one interface.
 * PRD §17 Wave 3 persists positions "through `schematify_write_layout`", and
 * `docs/audits/schematify-baseline.md` §11 resolves that to a JSON-RPC method
 * on the app dispatch (`schematify/write-layout`) rather than a new Tauri
 * command — so the wiring wave replaces the 4 bodies in `defaultSeam` below
 * with 4 `invoke` calls and changes nothing else in this app.
 *
 * The split between `writeLayout` and `writeSemantic` is the enforcement
 * point for PRD §6.2's two-layer rule, not a convenience: a gesture that only
 * arranges the picture may call the first and may never call the second.
 */
export interface SchematifySeam {
  /** `schematify/load-graph`, with `{ tier, slug }` as its params. Both
   *  parameters are optional and default to Wave 2/3's original single
   *  fixture (`service`/`auth-service`), so the many call sites written
   *  before Wave 5 gave 3 tiers to open — `seam.loadGraph()` with no
   *  arguments, all across this app's test suite — keep reading exactly what
   *  they always have. */
  loadGraph(tier?: Tier, slug?: string): Promise<SchematicGraph>;
  /** The dense fixture PRD §16.2 names, the subject of the 16 ms frame
   *  budget. One method rather than a parameter on `loadGraph`, so a caller
   *  cannot ask for it by accident. */
  loadDenseGraph(): Promise<SchematicGraph>;
  /** `schematify/read-layout`. `null` when the Schematic has no layout file
   *  yet, which is the first-run state, not an error. */
  readLayout(slug: string): Promise<LayoutFile | null>;
  /** `schematify/write-layout`. Writes `layout/<slug>.json` and nothing
   *  else. */
  writeLayout(slug: string, file: LayoutFile): Promise<void>;
  /** Any write to the semantic layer — `nodes/`, `edges/` (PRD §6.1). Edge
   *  creation and duplication are the gestures in Wave 3 that reach it. */
  writeSemantic(path: string, json: unknown): Promise<void>;
  /** Removes a semantic file. Undoing an edge creation needs it, so it is
   *  part of the seam rather than a gap a later wave discovers. */
  removeSemantic(path: string): Promise<void>;
}

/**
 * The seam ahead of a backend. Layout and semantic writes are held in memory,
 * so a position survives a tier switch inside one session and does not survive
 * a reload — the same honesty as `loadGraph` returning a fixture. The maps are
 * exported so a test can assert exactly which layer a gesture wrote to.
 */
export function createMemorySeam(): SchematifySeam & {
  layouts: Map<string, LayoutFile>;
  semantic: Map<string, unknown>;
} {
  const layouts = new Map<string, LayoutFile>();
  const semantic = new Map<string, unknown>();
  return {
    layouts,
    semantic,
    loadGraph,
    loadDenseGraph: () => Promise.resolve(DENSE_SERVICE_GRAPH),
    readLayout: (slug) => Promise.resolve(layouts.get(slug) ?? null),
    writeLayout: (slug, file) => {
      layouts.set(slug, file);
      return Promise.resolve();
    },
    writeSemantic: (path, json) => {
      semantic.set(path, json);
      return Promise.resolve();
    },
    removeSemantic: (path) => {
      semantic.delete(path);
      return Promise.resolve();
    },
  };
}

/**
 * The seam the running application uses, backed by `./backend.ts` (the real
 * `schematify/*` methods) through a dynamic `import()` rather than a static
 * one — a static import here would pull `@openkaava/bridge`'s `window`
 * access into the plain-Node `index.test.ts` (see `w2-shell.md`'s fix for
 * the same failure). Memoized so `createBackendSeam`'s in-memory maps
 * persist across calls. `loadGraph()` and `createMemorySeam()` above are
 * untouched — every test that wants the fixture still gets it directly.
 */
let backendSeam: Promise<SchematifySeam> | null = null;
function getBackendSeam(): Promise<SchematifySeam> {
  backendSeam ??= import("./backend").then((m) => m.createBackendSeam());
  return backendSeam;
}

export const defaultSeam: SchematifySeam = {
  // Forwards both arguments — a 0-arg arrow here silently dropped whatever
  // tier and slug `App.tsx`'s click-through (or any other caller) actually
  // asked for, since JavaScript never enforces arity. The same defect
  // `backend.ts`'s own `loadRealGraph` had one layer down, fixed
  // separately; a 0-arg wrapper at *this* layer would have re-hidden that
  // fix from every real caller regardless.
  loadGraph: (tier, slug) => getBackendSeam().then((seam) => seam.loadGraph(tier, slug)),
  loadDenseGraph: () => getBackendSeam().then((seam) => seam.loadDenseGraph()),
  readLayout: (slug) => getBackendSeam().then((seam) => seam.readLayout(slug)),
  writeLayout: (slug, file) => getBackendSeam().then((seam) => seam.writeLayout(slug, file)),
  writeSemantic: (path, json) => getBackendSeam().then((seam) => seam.writeSemantic(path, json)),
  removeSemantic: (path) => getBackendSeam().then((seam) => seam.removeSemantic(path)),
};

/**
 * `schematify/lint`, through the same dynamic `import("./backend")` every
 * other real read in this file uses — not part of `SchematifySeam`, since
 * that interface is "every read and every write the Schematic engine makes"
 * (its own doc comment) and the Problems dock tab is not the engine: it
 * lints the whole project, independent of which tier's Schematic happens to
 * be open, and stays mounted across a tier switch the engine itself
 * discards and rebuilds.
 */
let lintModule: Promise<typeof import("./backend")> | null = null;
function getBackendModule(): Promise<typeof import("./backend")> {
  lintModule ??= import("./backend");
  return lintModule;
}
export function fetchLintReport(): Promise<RawLintReport> {
  return getBackendModule().then((m) => m.fetchLintReport());
}

/** `schematify/module-dashboard`, wave 9d's own read — see `fetchLintReport`
 *  above for why this lives outside `SchematifySeam`: the Module dashboard
 *  is a whole separate screen (PRD §12.13), not something the Schematic
 *  engine reads. */
export function fetchModuleDashboard(module: string): Promise<Dashboard> {
  return getBackendModule().then((m) => m.fetchModuleDashboard(module));
}

/** `schematify/runs`, wave 9d's own read, for the Runs dock tab (PRD §12.2
 *  S-14). Project-wide, same reasoning as `fetchLintReport`. */
export function fetchRuns(): Promise<RawRunsReport> {
  return getBackendModule().then((m) => m.fetchRuns());
}

/** `schematify/ingest-run`, wave 9d's own write — the one write in this file
 *  outside `SchematifySeam`, because it is not a Schematic engine gesture
 *  either: it is CI handing Schematify a file, the same "not the engine"
 *  reasoning as the 2 reads above. */
export function ingestRun(module: string, path: string): Promise<{ ingested: boolean }> {
  return getBackendModule().then((m) => m.ingestRun(module, path));
}
