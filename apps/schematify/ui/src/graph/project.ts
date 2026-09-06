/**
 * Projects the whole-project graph `schematify/load-graph` returns (every
 * node, every edge, every kind, per PRD §6.1 and §14.5) down to the one
 * `ServiceGraph` this app's shell can currently draw — a single service's
 * containment subtree.
 *
 * This narrowing is not something `crates/schematify-core` or the Rust
 * dispatch owns. `ServiceGraph` (`./types.ts`) is Wave 2's own placeholder,
 * built before any tier switch existed — its own header says as much: "PRD
 * §16.1 draws no 'module' label on the wire, but the value exists so a real
 * loader has somewhere to put it later." This file is that real loader's
 * other half: where the real graph's shape and the shell's narrower shape
 * meet, until Wave 5 builds a tier-aware read and this file's job moves
 * there (`docs/overnight-jobs/overnight-2/handoffs/w3-engine.md` assumption
 * 16 names the same seam on the engine's side of the join).
 */
import type { RawDecision, RawFlow, RawProjectBrief, RawScreen } from "../product/types";
import { staleCaption, type RawStaleness } from "./staleness";
import type {
  GraphEdge,
  GraphNode,
  Layer,
  Lifecycle,
  NodeKind,
  SchematicGraph,
  ServiceGraph,
} from "./types";

/**
 * One node exactly as `schematify_core::Node` serializes it: the envelope
 * flattened with whatever fields its kind adds
 * (`src-tauri/src/apps/schematify.rs`'s `load_graph`). The crate's field
 * names are the Rust struct's own — snake_case, no `rename_all` on the
 * envelope itself — so `authored_by` and `superseded_by` reach here
 * unchanged. Only the fields this projection reads are declared; the rest of
 * each kind's open field map is not consumed here.
 */
export interface RawNode {
  id: string;
  slug: string;
  kind: string;
  title: string;
  lifecycle: string;
  layer?: string;
  parent?: string | null;
  /** PRD §7.4: set by Wave 10's staleness cascade, carried only while
   *  `lifecycle` is `"stale"`. `crates/schematify-core/src/node.rs`'s own
   *  doc comment on `NodeEnvelope.stale` states the same rule. */
  stale?: RawStaleness;
  [extra: string]: unknown;
}

/** One edge exactly as `schematify_core::Edge` serializes it. */
export interface RawEdge {
  id: string;
  kind: string;
  source: string;
  target: string;
}

/** One entry of `schematify_core::LibraryRegistry`, exactly as `load_graph`
 *  serializes it — read by [`projectModuleGraph`] to resolve an
 *  `external-dep` facet's `registry_ref` to a version and a license, neither
 *  of which the facet node itself carries (PRD §5.9: a use points at the
 *  registry, it does not restate the registry's own fields). */
export interface RawLibraryEntry {
  id: string;
  name: string;
  version: string;
  license: string;
}

/** The `graph` half of `schematify/load-graph`'s response. `rules` is not
 *  declared — no view any wave has built yet reads it. `libraries` is read
 *  by [`projectModuleGraph`] alone. `screens`, `flows`, `decisions` and
 *  `brief` are declared as optional so a caller built against an older,
 *  narrower fixture object (every test file that predates wave 10c) keeps
 *  compiling unchanged; the product layer (`../product/`) is what actually
 *  reads them. */
export interface RawGraph {
  nodes: RawNode[];
  edges: RawEdge[];
  libraries?: { libraries: RawLibraryEntry[] };
  screens?: RawScreen[];
  flows?: RawFlow[];
  decisions?: RawDecision[];
  brief?: RawProjectBrief | null;
}

/** The 3 dependency-family edge kinds `./types.ts`'s `GraphEdge` can hold.
 *  `contains` is never a member — containment is `GraphNode.parentId` — and
 *  `covers`, `satisfies`, `documents` have no drawing this app builds yet. */
const FRONTEND_EDGE_KINDS: ReadonlySet<string> = new Set([
  "depends_on",
  "implements",
  "references_ui",
]);

/**
 * core's `Layer` is `#[serde(rename_all = "lowercase")]` over the same 5
 * words `./types.ts`'s `Layer` names, and `Lifecycle` is the same rule over
 * the same 8 words — both wire formats already match this app's vocabulary
 * byte for byte, so no rename happens here.
 */
function asLayer(value: string | undefined): Layer | undefined {
  return value as Layer | undefined;
}

function asLifecycle(value: string): Lifecycle {
  return value as Lifecycle;
}

/**
 * The 3 raw kinds this projection *draws* on a Service Schematic: `module`
 * (PRD tier 2), `group`, and `comment` — the 2 annotation-tier kinds PRD
 * §11.3 and §12.4 both draw on the canvas. `service` is never a member — it
 * is the root the whole graph is drawn under, carried separately as
 * `serviceSlug`/`serviceTitle`.
 *
 * Every other kind is a tier-3 facet the Module Schematic draws, not the
 * Service one — collapsing them to `"module"` instead of excluding them was
 * the bug that inflated a 12-module real service into 70 nodes on first
 * contact with real data; see the wiring handoff.
 *
 * A `group` or `comment` is drawn but not counted — see
 * `ANNOTATION_NODE_KINDS` in `./types.ts`, which `countNodes` reads for the
 * status-bar figure, and `MODULE_ONLY_EDGE_ENDPOINT_KINDS` below, which
 * keeps both out of the edge list the same way. Drawn and counted are 2
 * different questions; both annotation kinds answer the 2nd "no" while
 * still answering the 1st "yes".
 */
const SERVICE_SCHEMATIC_KINDS: ReadonlySet<string> = new Set(["module", "group", "comment"]);

/**
 * The 1 raw kind an edge may connect to on a Service Schematic: `module`.
 * PRD §11.3's annotation tier — `group` and `comment` alike — carries no
 * semantic edge, per the same ruling `SERVICE_SCHEMATIC_KINDS` above
 * encodes: "an annotation-tier box is never a node and never an edge
 * endpoint" (WIREFRAME-EXTRACT.md's Resolutions section). Either kind can be
 * drawn while still never appearing as an edge's `from`/`to`.
 */
const MODULE_ONLY_EDGE_ENDPOINT_KINDS: ReadonlySet<string> = new Set(["module"]);

function asNodeKind(rawKind: "module" | "group" | "comment"): NodeKind {
  return rawKind;
}

/**
 * A `comment`'s position on the canvas: `../engine/engine.ts`'s own
 * `addComment` doc says it plainly — "anchored to a node by `parentId` or
 * floating free" — so `CommentFields.anchor` (a node id, or absent) is what
 * this projection has to put in `GraphNode.parentId` for a comment, not the
 * envelope's own containment `parent` the way every other kind uses it.
 * `parent` still decides which tier's subtree the comment belongs to at all
 * (`isDescendantOf` reads it below, kind notwithstanding); `anchor` only
 * decides where a comment that IS included draws relative to another node.
 */
function commentParentId(node: RawNode): string | null {
  return typeof node.anchor === "string" ? node.anchor : null;
}

/** `comment`: the note text and its author, straight off `CommentFields` —
 *  see `./types.ts`'s `GraphNode.body`/`author` for why they keep those
 *  names rather than `docBody`-style ones. */
function commentFields(node: RawNode): Pick<GraphNode, "body" | "author"> {
  return {
    body: typeof node.body === "string" ? node.body : undefined,
    author: typeof node.author === "string" ? node.author : undefined,
  };
}

/**
 * Whether `node` sits inside `rootId`'s containment subtree, walking
 * `parent` up to the root. Guards against a containment cycle the same way
 * `./index.ts`'s `computeDepth` does — a real project is read off a
 * filesystem a person can hand-edit, so a cycle is a real possibility here,
 * not a hypothetical one a fixture could rule out. Shared by
 * [`projectServiceGraph`] (root = a service) and [`projectModuleGraph`]
 * (root = a module) — the walk itself knows nothing about which tier called
 * it.
 */
function isDescendantOf(
  node: RawNode,
  rootId: string,
  byId: ReadonlyMap<string, RawNode>,
): boolean {
  const visiting = new Set<string>();
  let current: RawNode | undefined = node;
  while (current) {
    if (current.parent === rootId) return true;
    if (!current.parent || visiting.has(current.id)) return false;
    visiting.add(current.id);
    current = byId.get(current.parent);
  }
  return false;
}

/** PRD §7.4's `badge`/`staleReason` pair, shared by [`projectServiceGraph`]
 *  (a module box drawn `STALE`) and [`projectModuleGraph`] (the module root
 *  itself, drawn the same way). `stale.source` is a node id — resolved
 *  against `byId`, the containment map the caller already built — so
 *  `staleCaption` has a slug to draw rather than a UUID. */
function staleFields(
  node: RawNode,
  byId: ReadonlyMap<string, RawNode>,
  nowMs: number,
): Pick<GraphNode, "badge" | "staleReason"> {
  if (node.lifecycle !== "stale") return {};
  return {
    badge: "STALE",
    staleReason: staleCaption(node.stale, byId.get(node.stale?.source ?? "")?.slug, nowMs),
  };
}

/**
 * Builds one service's `ServiceGraph` out of the whole project graph.
 *
 * Throws when no top-level `service` node carries `serviceSlug` — a rejected
 * `openSchematic` is already a handled case (`App.tsx`, Wave 2 review round
 * 2 finding 3: a rejection is caught, shown as `.kv-shell__error`, and still
 * reports the frame painted), so this is a caught rejection, not a crash.
 */
export function projectServiceGraph(raw: RawGraph, serviceSlug: string): ServiceGraph {
  const serviceNode = raw.nodes.find(
    (node) => node.kind === "service" && node.slug === serviceSlug,
  );
  if (!serviceNode) {
    throw new Error(`no service named "${serviceSlug}" in this project`);
  }

  // `byId` stays the full node set — a containment walk has to be able to
  // pass through every node on the way up, kind notwithstanding. Only the
  // *output* is limited to `SERVICE_SCHEMATIC_KINDS`.
  const byId = new Map(raw.nodes.map((node) => [node.id, node]));
  const included = raw.nodes.filter(
    (node) =>
      node.id !== serviceNode.id &&
      SERVICE_SCHEMATIC_KINDS.has(node.kind) &&
      isDescendantOf(node, serviceNode.id, byId),
  );

  // Read once per call rather than once per node — PRD §0.4's "computed at
  // draw time" rule is about not storing the elapsed time on disk, not about
  // recomputing `Date.now()` for every node in one draw.
  const nowMs = Date.now();

  const nodes: GraphNode[] = included.map((node) => ({
    id: node.id,
    slug: node.slug,
    title: node.title,
    kind: asNodeKind(node.kind as "module" | "group" | "comment"),
    layer: asLayer(node.layer),
    lifecycle: asLifecycle(node.lifecycle),
    parentId:
      node.kind === "comment"
        ? commentParentId(node)
        : node.parent === serviceNode.id
          ? null
          : (node.parent ?? null),
    // No structural source for PRD §12.1's ENTRY badge exists in
    // `crates/schematify-core` yet — `ServiceFields.entry_point` is prose
    // ("how the service starts"), not a flag on a module. STALE is
    // derivable; see the wiring handoff.
    ...staleFields(node, byId, nowMs),
    ...(node.kind === "comment" ? commentFields(node) : {}),
  }));

  // A group can be drawn (above) while never becoming an edge endpoint —
  // `edgeEndpointIds` is module ids only, narrower than `included`, so a
  // `depends_on` naming a group's id is dropped here rather than drawn as
  // though a box could originate or receive a dependency.
  const edgeEndpointIds = new Set(
    included.filter((node) => MODULE_ONLY_EDGE_ENDPOINT_KINDS.has(node.kind)).map((n) => n.id),
  );
  const edges: GraphEdge[] = raw.edges
    .filter(
      (edge) =>
        FRONTEND_EDGE_KINDS.has(edge.kind) &&
        edgeEndpointIds.has(edge.source) &&
        edgeEndpointIds.has(edge.target),
    )
    .map((edge) => ({
      id: edge.id,
      kind: edge.kind as GraphEdge["kind"],
      from: edge.source,
      to: edge.target,
    }));

  return {
    tier: "service",
    serviceSlug: serviceNode.slug,
    serviceTitle: serviceNode.title,
    nodes,
    edges,
  };
}

// --- Module Schematic (PRD §12.11, tier 3) ---------------------------------

/** PRD §12.11's 5 facet kinds, plus the 2 annotation-tier kinds PRD §11.3
 *  draws on every tier (`group`, `comment`) — every `NodeKind` a Module
 *  Schematic draws that is not the module root itself. Omitting the latter
 *  2 here was the same bug `SERVICE_SCHEMATIC_KINDS` above had: a project's
 *  module-scoped comment or group never reached this tier at all. */
const MODULE_FACET_KINDS: ReadonlySet<string> = new Set([
  "contract-method",
  "test-case",
  "budget",
  "doc-block",
  "external-dep",
  "group",
  "comment",
]);

/** The 3 tier-3 edge kinds PRD §11.1 closes the vocabulary to. Unlike the
 *  Service Schematic's `MODULE_ONLY_EDGE_ENDPOINT_KINDS`, every included
 *  node (root and facet alike) is a legal endpoint here — a `covers` edge
 *  runs test case to contract method, never through the root. */
const MODULE_EDGE_KINDS: ReadonlySet<string> = new Set(["covers", "satisfies", "documents"]);

function asFacetKind(rawKind: string): NodeKind {
  return rawKind as NodeKind;
}

/** A `test-case` facet's `status` (`declared`/`linked`/`passing`/`failing`,
 *  `schematify_core::node::TestStatus`), narrowed to the 2 words PRD §12.11
 *  actually draws a status word for — a case that is merely `declared` or
 *  `linked` draws none, the same as `./module.ts`'s stand-in fixture never
 *  set the field for those states. */
function asTestStatus(value: unknown): "passing" | "failing" | undefined {
  return value === "passing" || value === "failing" ? value : undefined;
}

/** A `budget` facet's `tier` (`schematify_core::node::BudgetTier`), narrowed
 *  the same way `asTestStatus` narrows a test status: `"target"` draws no
 *  badge at all, matching `BudgetTier::badge()`'s own `None` for that tier
 *  on the Rust side. */
function asBudgetTier(value: unknown): "hard" | "soft" | undefined {
  return value === "hard" || value === "soft" ? value : undefined;
}

/** `< 3 ms`, from a budget facet's `op`/`value`/`unit` — the 3 fields
 *  `schematify_core::node::BudgetFields` always carries, so this never
 *  returns `undefined` the way `budgetProbeCommand` and `budgetValueText`
 *  (unmodeled — see `projectModuleGraph`'s own header) can. */
function budgetThresholdText(node: RawNode): string | undefined {
  const { op, value, unit } = node;
  if (typeof op !== "string" || typeof value !== "number" || typeof unit !== "string") {
    return undefined;
  }
  return `${op} ${value} ${unit}`;
}

function budgetProbeCommand(node: RawNode): string | undefined {
  const probe = node.probe;
  if (probe === null || typeof probe !== "object") return undefined;
  const command = (probe as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

/** One facet's kind-specific fields (PRD §12.11), the tier-3 counterpart of
 *  `projectServiceGraph`'s inline node map — split into its own function
 *  because a `switch` over 6 kinds inline would out-grow what that map
 *  reads comfortably. A contract method's covers count is deliberately not
 *  one of these fields: wave 6 removed `GraphNode.coversCount` as a PRD
 *  §0.4 breach (a stored count that could drift from the edges) and
 *  replaced it with `engine/anatomy.ts`'s `coversCountFor(id, edges)`,
 *  computed at draw time from the `covers` edges this function's caller
 *  already returns — a caller wanting the number reads it from there, not
 *  from a 2nd count this file would otherwise be computing independently. */
function facetFields(
  node: RawNode,
  libraries: ReadonlyMap<string, RawLibraryEntry>,
): Partial<GraphNode> {
  switch (node.kind) {
    case "contract-method":
      return {
        signature: typeof node.signature === "string" ? node.signature : undefined,
        returns: typeof node.returns === "string" ? node.returns : undefined,
        exported: node.exported === true,
      };
    case "test-case":
      return { testStatus: asTestStatus(node.status) };
    case "budget":
      return {
        budgetTier: asBudgetTier(node.tier),
        budgetThresholdText: budgetThresholdText(node),
        budgetProbe: budgetProbeCommand(node),
        // `schematify_core::node::BudgetFields` has no "last measured
        // value" field at all — only a threshold and an optional sign-off —
        // so this stays `undefined` (PRD §12.12: "draws `—`") rather than
        // guessing at a number the schema does not hold.
        budgetValueText: undefined,
      };
    case "doc-block":
      return {
        docAudience: typeof node.audience === "string" ? node.audience : undefined,
        docBody: typeof node.body === "string" ? node.body : undefined,
      };
    case "comment":
      return commentFields(node);
    case "external-dep": {
      const entry =
        typeof node.registry_ref === "string" ? libraries.get(node.registry_ref) : undefined;
      return {
        depVersion: entry?.version,
        depLicense: entry?.license,
        depRegistryOk: entry !== undefined,
      };
    }
    default:
      return {};
  }
}

/**
 * Builds one module's `SchematicGraph` out of the whole project graph — the
 * tier-3 counterpart of `projectServiceGraph`. The module root is drawn as
 * its own node (`parentId: null`, unlike a service's root, which is never in
 * `nodes` at all — PRD §12.11 fans facets out from a drawn root box, while a
 * Service Schematic's root is the canvas itself), with every facet whose
 * containment chain resolves back to it.
 *
 * Throws when no `module` node carries `moduleSlug`, the same contract
 * `projectServiceGraph` makes — a caught rejection in `App.tsx`, not a crash.
 */
export function projectModuleGraph(raw: RawGraph, moduleSlug: string): SchematicGraph {
  const moduleNode = raw.nodes.find((node) => node.kind === "module" && node.slug === moduleSlug);
  if (!moduleNode) {
    throw new Error(`no module named "${moduleSlug}" in this project`);
  }

  const byId = new Map(raw.nodes.map((node) => [node.id, node]));
  const facets = raw.nodes.filter(
    (node) => MODULE_FACET_KINDS.has(node.kind) && isDescendantOf(node, moduleNode.id, byId),
  );
  const included = [moduleNode, ...facets];
  const includedIds = new Set(included.map((node) => node.id));

  const libraries = new Map(
    (raw.libraries?.libraries ?? []).map((entry) => [entry.id, entry] as const),
  );

  const nowMs = Date.now();

  const nodes: GraphNode[] = included.map((node) => {
    const isRoot = node.id === moduleNode.id;
    return {
      id: node.id,
      slug: node.slug,
      title: node.title,
      kind: asFacetKind(node.kind),
      layer: isRoot ? asLayer(node.layer) : undefined,
      lifecycle: asLifecycle(node.lifecycle),
      // A facet's real parent is already the module's own id — module.ts's
      // stand-in fixture set it exactly this way — so unlike the service
      // tier's root-becomes-null rewrite, only the root itself is `null`.
      // A comment is the one exception: see `commentParentId` — its drawn
      // position comes from `anchor`, never from this containment `parent`.
      parentId: isRoot
        ? null
        : node.kind === "comment"
          ? commentParentId(node)
          : (node.parent ?? null),
      description: isRoot && typeof node.description === "string" ? node.description : undefined,
      screenRef: isRoot ? firstScreenRef(node.ui_refs) : undefined,
      ...staleFields(node, byId, nowMs),
      ...(isRoot ? {} : facetFields(node, libraries)),
    };
  });

  const edges: GraphEdge[] = raw.edges
    .filter(
      (edge) =>
        MODULE_EDGE_KINDS.has(edge.kind) &&
        includedIds.has(edge.source) &&
        includedIds.has(edge.target),
    )
    .map((edge) => ({
      id: edge.id,
      kind: edge.kind as GraphEdge["kind"],
      from: edge.source,
      to: edge.target,
    }));

  return {
    tier: "module",
    serviceSlug: moduleNode.slug,
    serviceTitle: moduleNode.title,
    nodes,
    edges,
  };
}

/** A module's `ui_refs` (PRD §12.5's tier-3 screen-reference path), taken as
 *  its first entry — `GraphNode.screenRef` is a single string, and no
 *  wireframe or fixture draws a module with more than 1. */
function firstScreenRef(uiRefs: unknown): string | undefined {
  if (!Array.isArray(uiRefs) || uiRefs.length === 0) return undefined;
  const first: unknown = uiRefs[0];
  return typeof first === "string" ? first : undefined;
}

// --- Stack Schematic (PRD §12.9, tier 1) -----------------------------------

/** The kinds a Stack Schematic draws: `service`, plus the 2 annotation-tier
 *  kinds PRD §11.3 draws on every tier. `module` is never a member — a module
 *  belongs to its own service's Schematic, and folding tier 2 up onto tier 1
 *  would repeat the mistake `SERVICE_SCHEMATIC_KINDS` above records for
 *  tier 3. */
const STACK_SCHEMATIC_KINDS: ReadonlySet<string> = new Set(["service", "group", "comment"]);

/** The 1 raw kind an edge may connect to on a Stack Schematic — the tier-1
 *  counterpart of `MODULE_ONLY_EDGE_ENDPOINT_KINDS`. A `depends_on` between 2
 *  modules is tier 2's line; redrawing it here would state a
 *  service-to-service dependency the graph does not actually hold. */
const SERVICE_ONLY_EDGE_ENDPOINT_KINDS: ReadonlySet<string> = new Set(["service"]);

/** Just `service`, for the ancestor walk that decides which service owns a
 *  module or a contract method. */
const SERVICE_KIND: ReadonlySet<string> = new Set(["service"]);

/** The kinds that, found as an ancestor, put an annotation node on a tier
 *  deeper than this one: a group inside a service arranges that service's
 *  modules, and one inside a module arranges its facets. Neither is tier 1's
 *  to draw. */
const DEEPER_TIER_OWNER_KINDS: ReadonlySet<string> = new Set(["service", "module"]);

/**
 * The nearest containment ancestor of `node` whose kind is in `kinds`, or
 * `undefined` when the walk reaches the root without finding one.
 * Cycle-guarded exactly as `isDescendantOf` is, and for the same reason: a
 * real project is read off a filesystem a person can hand-edit, so a `parent`
 * chain that loops is a real possibility rather than a hypothetical one.
 */
function nearestAncestor(
  node: RawNode,
  byId: ReadonlyMap<string, RawNode>,
  kinds: ReadonlySet<string>,
): RawNode | undefined {
  const visiting = new Set<string>([node.id]);
  let current = node.parent ? byId.get(node.parent) : undefined;
  while (current && !visiting.has(current.id)) {
    if (kinds.has(current.kind)) return current;
    visiting.add(current.id);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return undefined;
}

function asStackKind(rawKind: "service" | "group" | "comment"): NodeKind {
  return rawKind;
}

/**
 * The Stack Schematic's own slug. It matches `engine/presets.ts`'s
 * `STACK_CONFIG.layoutSlug`, which is what `layout/<slug>.json` is keyed on and
 * what `engine/layout.ts`'s `toGraph` puts back into `serviceSlug` once the
 * document exists — so this is the identity of the tier-1 layout file, not a
 * name for any node. Restated here rather than imported: `engine/` already
 * imports `graph/`, and importing back would close a cycle.
 */
const STACK_LAYOUT_SLUG = "stack";

/**
 * Builds the whole project's Stack Schematic — tier 1, every service the graph
 * holds, drawn with the dependency edges that run between them.
 *
 * Unlike its tier-2 and tier-3 counterparts this takes no slug and cannot
 * throw: there is exactly 1 Stack Schematic per project, so there is no name to
 * fail to resolve. A project with no services projects to an empty graph, which
 * is the honest answer and the state PRD §12.20's first-run view draws.
 *
 * Three fields `./stack.ts`'s hand-typed fixture carries stay unset here,
 * because the real graph states none of them: `health` (PRD §12.8's roll-up is
 * over contained modules, and this tier draws none), `badge: "ENTRY"` (the same
 * absence `projectServiceGraph` above records), and `sharedAtLca` (linter rule
 * L10's job — a second implementation in TypeScript is a second answer that can
 * disagree with the first). Each has a reader that already degrades: no wedge,
 * no badge, and `engine/frame.ts`'s `buildSharedNodeCallout` returning `null`.
 */
export function projectStackGraph(raw: RawGraph): SchematicGraph {
  const byId = new Map(raw.nodes.map((node) => [node.id, node]));

  // A service is included at any containment depth — PRD §16.1's `ledger-store`
  // sits inside `session-service`, and nesting is what `parentId` draws. An
  // annotation is included only when nothing deeper already owns it.
  const included = raw.nodes.filter((node) => {
    if (!STACK_SCHEMATIC_KINDS.has(node.kind)) return false;
    if (node.kind === "service") return true;
    return nearestAncestor(node, byId, DEEPER_TIER_OWNER_KINDS) === undefined;
  });
  const includedIds = new Set(included.map((node) => node.id));

  // Both counts in 1 pass over every node rather than a subtree walk per
  // service: a module belongs to its *nearest* service ancestor, so a service
  // containing another service reports its own modules and not its child's as
  // well. `exportsCount` counts exported contract methods, which is the size of
  // the service's public surface — a property of the service rather than of the
  // modules it happens to hold.
  const modulesByService = new Map<string, number>();
  const exportsByService = new Map<string, number>();
  for (const node of raw.nodes) {
    const counting =
      node.kind === "module"
        ? modulesByService
        : node.kind === "contract-method" && node.exported === true
          ? exportsByService
          : undefined;
    if (!counting) continue;
    const owner = nearestAncestor(node, byId, SERVICE_KIND);
    if (!owner) continue;
    counting.set(owner.id, (counting.get(owner.id) ?? 0) + 1);
  }

  const nowMs = Date.now();

  const nodes: GraphNode[] = included.map((node) => ({
    id: node.id,
    slug: node.slug,
    title: node.title,
    kind: asStackKind(node.kind as "service" | "group" | "comment"),
    layer: asLayer(node.layer),
    lifecycle: asLifecycle(node.lifecycle),
    // A parent outside this projection — a service somehow nested under a
    // module — drops to `null` rather than being drawn as a dangling reference
    // the arranger would then have to interpret.
    parentId:
      node.kind === "comment"
        ? commentParentId(node)
        : node.parent && includedIds.has(node.parent)
          ? node.parent
          : null,
    ...(node.kind === "service"
      ? {
          modulesCount: modulesByService.get(node.id) ?? 0,
          exportsCount: exportsByService.get(node.id) ?? 0,
        }
      : {}),
    ...staleFields(node, byId, nowMs),
    ...(node.kind === "comment" ? commentFields(node) : {}),
  }));

  const edgeEndpointIds = new Set(
    included.filter((node) => SERVICE_ONLY_EDGE_ENDPOINT_KINDS.has(node.kind)).map((n) => n.id),
  );
  const edges: GraphEdge[] = raw.edges
    .filter(
      (edge) =>
        FRONTEND_EDGE_KINDS.has(edge.kind) &&
        edgeEndpointIds.has(edge.source) &&
        edgeEndpointIds.has(edge.target),
    )
    .map((edge) => ({
      id: edge.id,
      kind: edge.kind as GraphEdge["kind"],
      from: edge.source,
      to: edge.target,
    }));

  return {
    tier: "stack",
    serviceSlug: STACK_LAYOUT_SLUG,
    // The project's own name when `brief.json` states one (PRD §12.17): the
    // stack has no root node to take a title from the way tiers 2 and 3 do.
    serviceTitle: raw.brief?.product_name ?? STACK_LAYOUT_SLUG,
    nodes,
    edges,
  };
}
