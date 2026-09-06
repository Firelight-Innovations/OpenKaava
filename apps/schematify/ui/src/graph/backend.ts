/**
 * This app's one and only door to Rust. Kept out of `./index.ts` on purpose:
 * that module is imported by a plain-Node unit test, and `@openkaava/bridge`'s
 * root export touches `window` at module load, which a Node test has none of.
 * `./index.ts`'s `defaultSeam` reaches everything below through a dynamic
 * `import("./backend")` for the same reason.
 *
 * Wraps the methods `src-tauri/src/apps/schematify.rs` answers, plus wave
 * 10c's five product-layer writes (`write-screen`, `write-flow`,
 * `write-brief`, `write-decision`, `supersede-decision`) and
 * `loadProductGraph`, which reads `schematify/load-graph`'s `screens`,
 * `flows`, `decisions` and `brief` fields — the ones `loadRealGraph` below
 * discards on its way to a `ServiceGraph`. `open-project` and `write-node`/
 * `write-edge` are not called from here — see `createBackendSeam`'s doc
 * comment and `docs/overnight-jobs/overnight-2/handoffs/wiring.md`. Per
 * `CLAUDE.md`, this file stays the only one in this app that contains
 * `invoke` — a new operation gets a new function here, never a new file.
 */
import { KaavaRpcError, invoke } from "@openkaava/bridge";
import type { RawDecision, RawFlow, RawProjectBrief, RawScreen } from "../product/types";
import type { Dashboard, RawRunsReport } from "./dashboard";
import { DENSE_SERVICE_GRAPH } from "./dense";
import type { LayoutFile } from "./layout";
import type { RawLintReport } from "./problems";
import {
  projectModuleGraph,
  projectServiceGraph,
  projectStackGraph,
  type RawGraph,
} from "./project";
import type { SchematicGraph, ServiceGraph, Tier } from "./types";

export interface SchematifyState {
  project: string | null;
  ready: boolean;
}

export const fetchState = () => invoke<SchematifyState>("schematify/state");

/** The host's own words for why a call failed, following
 *  `apps/design/ui/src/rpc.ts`: every refusal on the Rust side is written as
 *  a sentence for a person, so none is mapped to a category here. */
export function reasonForFailure(err: unknown): string {
  if (err instanceof KaavaRpcError) return err.message;
  return String(err);
}

/** Every `schematify/*` operation carries `actor` (PRD §14.5, SCH-API-003).
 *  This app has no agent-initiated gesture yet, so `"human"` is the only
 *  value sent — see the wiring handoff for the record of that choice. */
const ACTOR = "human";

/** What `loadGraph()` reads when called with no arguments at all, which is
 *  how most of this app's test suite calls it. **Not the landing view** —
 *  `App.tsx` opens the Stack Schematic and names every target it drills to,
 *  so nothing in the running app reaches this default. Kept because the
 *  fixture-era call sites still rely on it, and removing it would rewrite
 *  tests that are about something else. */
const DEFAULT_SERVICE_SLUG = "auth-service";

interface LoadGraphResponse {
  graph: RawGraph;
  report: { clean: boolean };
}

// `schematify/load-graph`, projected to whichever tier and slug the caller
// asked for. Previously ignored both, always returning the `auth-service`
// Service Schematic — the bug a Module-location Problems row's
// click-through ran into (wave 7b's handoff).
//
// All 3 tiers now have a real projector in `./project.ts`. `stack` was the
// last stand-in: it returned an empty graph regardless of what the project
// held, which made the Stack Schematic a dead end that could be walked to and
// never drilled out of. `slug` is unused at that tier — there is 1 Stack
// Schematic per project, so there is nothing to name.
async function loadRealGraph(
  tier: Tier = "service",
  slug: string = DEFAULT_SERVICE_SLUG,
): Promise<SchematicGraph> {
  const response = await invoke<LoadGraphResponse>("schematify/load-graph", { actor: ACTOR });
  if (tier === "stack") return projectStackGraph(response.graph);
  return tier === "module"
    ? projectModuleGraph(response.graph, slug)
    : projectServiceGraph(response.graph, slug);
}

/** `schematify/read-layout`. `null` is the first-run state, not a failure. */
function readRealLayout(slug: string): Promise<LayoutFile | null> {
  return invoke<LayoutFile | null>("schematify/read-layout", { actor: ACTOR, slug });
}

/** `schematify/write-layout`. Writes `layout/<slug>.json` and nothing else —
 *  PRD §6.2's enforcement point, and the one write this wave makes real. */
async function writeRealLayout(slug: string, file: LayoutFile): Promise<void> {
  await invoke("schematify/write-layout", { actor: ACTOR, slug, layout: file });
}

// --- The product layer (PRD §12.17, §12.18) — wave 10c --------------------

/** What `schematify/load-graph` carries that `loadRealGraph` above discards
 *  on its way to a `ServiceGraph`: the product layer's own 4 collections,
 *  plus the node id set `../product/index.ts`'s `screenBackingModuleCount`
 *  needs to tell a live backing reference from a dangling one. */
export interface ProductGraph {
  nodeIds: ReadonlySet<string>;
  screens: RawScreen[];
  flows: RawFlow[];
  decisions: RawDecision[];
  brief: RawProjectBrief | null;
}

/** `schematify/load-graph`, read for the Outline's `Product` and
 *  `Decisions` sections rather than for a Schematic — a second call rather
 *  than a shared cache with `loadRealGraph`, since the 2 views are mounted
 *  independently and neither PRD §12.1 nor §12.17 says one has to wait on
 *  the other. */
async function loadRealProductGraph(): Promise<ProductGraph> {
  const response = await invoke<LoadGraphResponse>("schematify/load-graph", { actor: ACTOR });
  return {
    nodeIds: new Set(response.graph.nodes.map((node) => node.id)),
    screens: response.graph.screens ?? [],
    flows: response.graph.flows ?? [],
    decisions: response.graph.decisions ?? [],
    brief: response.graph.brief ?? null,
  };
}

/** `schematify/write-screen`. Upserts one screen (PRD §5.7) — a screen
 *  carries no append-only rule, unlike a decision row below. */
async function writeRealScreen(screen: RawScreen): Promise<void> {
  await invoke("schematify/write-screen", { actor: ACTOR, screen });
}

/** `schematify/write-flow`. Upserts one flow (PRD §5.8). */
async function writeRealFlow(flow: RawFlow): Promise<void> {
  await invoke("schematify/write-flow", { actor: ACTOR, flow });
}

/** `schematify/write-brief`. Overwrites `brief.json` (PRD §5.12) — the one
 *  semantic file with no id of its own. */
async function writeRealBrief(brief: RawProjectBrief): Promise<void> {
  await invoke("schematify/write-brief", { actor: ACTOR, brief });
}

/** `schematify/write-decision`. Creates exactly one new, standing decision
 *  row (PRD §5.9) — the Rust side refuses a second write to the same id, so
 *  this function makes no promise this app cannot keep: a caller reusing an
 *  id to "edit" a row gets the same refusal back that a hand-crafted RPC
 *  call would. */
async function writeRealDecision(decision: RawDecision): Promise<void> {
  await invoke("schematify/write-decision", { actor: ACTOR, decision });
}

/** `schematify/supersede-decision`. The one write that can move a decision
 *  to `SUPERSEDED` (PRD §5.9) — `priorId` names the row being replaced,
 *  `decision` is the new row's own content. The server decides the new
 *  row's `supersedes`/`superseded_by`, never this function's caller. */
async function supersedeRealDecision(priorId: string, decision: RawDecision): Promise<void> {
  await invoke("schematify/supersede-decision", { actor: ACTOR, priorId, decision });
}

/** The product layer's own seam, parallel to `SchematifySeamLike` above but
 *  independent of it — `ProductView`/`ScreenRegistry`/`FlowEditor`/
 *  `DecisionLog` (`../product/`) read and write through this, never
 *  `invoke` directly, keeping this file the one door to Rust. */
export interface ProductSeam {
  loadProduct(): Promise<ProductGraph>;
  writeScreen(screen: RawScreen): Promise<void>;
  writeFlow(flow: RawFlow): Promise<void>;
  writeBrief(brief: RawProjectBrief): Promise<void>;
  writeDecision(decision: RawDecision): Promise<void>;
  supersedeDecision(priorId: string, decision: RawDecision): Promise<void>;
}

export const productSeam: ProductSeam = {
  loadProduct: loadRealProductGraph,
  writeScreen: writeRealScreen,
  writeFlow: writeRealFlow,
  writeBrief: writeRealBrief,
  writeDecision: writeRealDecision,
  supersedeDecision: supersedeRealDecision,
};

/** `schematify/lint`. Wave 7a's own arm (`src-tauri/src/apps/schematify.rs`),
 *  widened this wave to carry `Location.slug` and `Finding.rule_name` — the
 *  2 fields the Problems panel needs that a Rust-only caller (a test, a
 *  future CLI) had no reason to want. Lints the whole project on every call,
 *  same as the Rust side: PRD §0.4 makes the finding count computed at read
 *  time, never stored, so there is nothing to invalidate. */
export function fetchLintReport(): Promise<RawLintReport> {
  return invoke<RawLintReport>("schematify/lint", { actor: ACTOR });
}

/** `schematify/module-dashboard` (wave 9d's own arm, PRD §12.13). `module`
 *  accepts either a node id or a slug — see the Rust function's own doc
 *  comment for why: the Module Schematic's own stand-in engine
 *  (`./module.ts`) has no real backend uuid to hand this call yet. */
export function fetchModuleDashboard(module: string): Promise<Dashboard> {
  return invoke<Dashboard>("schematify/module-dashboard", { actor: ACTOR, module });
}

/** `schematify/runs` (wave 9d's own arm, PRD §12.2 S-14). Project-wide,
 *  independent of which tier is open — same "whole project, not one tier"
 *  scope `fetchLintReport` already draws for the Problems panel. */
export function fetchRuns(): Promise<RawRunsReport> {
  return invoke<RawRunsReport>("schematify/runs", { actor: ACTOR });
}

/** `schematify/ingest-run` (wave 9d's own arm): the Tauri wiring for wave
 *  9b's `schematify_core::ingest_run_file`. `module` is the node whose CI
 *  workflow produced the run; `path` is wherever CI dropped the
 *  `kaava-bench-v1` artifact, outside `.kaava/`. */
export function ingestRun(module: string, path: string): Promise<{ ingested: boolean }> {
  return invoke<{ ingested: boolean }>("schematify/ingest-run", { actor: ACTOR, module, path });
}

/**
 * The seam the running application uses once a real project is open.
 *
 * `writeSemantic`/`removeSemantic` stay in-memory, not wired to
 * `schematify/write-node`/`write-edge`. `engine/engine.ts`'s own
 * `nodeJson`/`edgeJson` (reparent, duplicate, edge creation) send a
 * deliberately partial node or edge — no `lifecycle`, `authored_by` or
 * `created`, fields the real schema requires — because that engine "writes
 * only what a duplicate or a reparent can honestly know"; inventing them
 * here would be guessing, not wiring. A node drag persists for real
 * (`writeLayout`, above); a reparent, duplicate, or dragged edge persists
 * only for the session. Full record: `docs/overnight-jobs/overnight-2/
 * handoffs/wiring.md`.
 *
 * That deferral is no longer silent, though: `SchematicEngine.semanticWrites`
 * tracks every path this `Map` has touched, and the status bar's 5th cell
 * (`statusCell5`, `./index.ts`) reads it every render, so a session-only
 * write now says so on screen instead of looking saved.
 */
export function createBackendSeam(): SchematifySeamLike {
  const semantic = new Map<string, unknown>();
  return {
    loadGraph: loadRealGraph,
    loadDenseGraph: () => Promise.resolve(DENSE_SERVICE_GRAPH),
    readLayout: readRealLayout,
    writeLayout: writeRealLayout,
    writeSemantic: (path: string, json: unknown) => {
      semantic.set(path, json);
      return Promise.resolve();
    },
    removeSemantic: (path: string) => {
      semantic.delete(path);
      return Promise.resolve();
    },
  };
}

/** What `createBackendSeam` returns — `./index.ts`'s `SchematifySeam`
 *  restated rather than imported, following `apps/files/ui/src/rpc.ts`'s
 *  convention. `loadGraph`'s 2 params were the one place this had drifted:
 *  `(): …` let `loadRealGraph` silently ignore its real callers' arguments,
 *  since JavaScript never enforces arity. */
interface SchematifySeamLike {
  loadGraph(tier?: Tier, slug?: string): Promise<ServiceGraph>;
  loadDenseGraph(): Promise<ServiceGraph>;
  readLayout(slug: string): Promise<LayoutFile | null>;
  writeLayout(slug: string, file: LayoutFile): Promise<void>;
  writeSemantic(path: string, json: unknown): Promise<void>;
  removeSemantic(path: string): Promise<void>;
}
