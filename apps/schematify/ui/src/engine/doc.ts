/**
 * The Schematic document: what the engine holds while a Schematic is open.
 * Semantic nodes and edges come from the graph seam (`../graph`); annotation
 * nodes (groups and comments, PRD §11.3) and every position come from the
 * cosmetic layout file. The document is the join of the two, and is the only
 * thing the engine mutates.
 *
 * Containment is `parentId`, never an edge (PRD §4.1). A rect is absolute
 * world geometry rather than parent-relative, because routing, culling and
 * box-select all ask about absolute boxes far more often than a reparent asks
 * about a relative one.
 */
import type { EdgeKind, NodeRole, SchematicNodeKind } from "./config";
import { isAnnotationKind } from "./config";
import type {
  ContractMethodSummary,
  ExportRow,
  FacetCounts,
  HealthStatus,
  Layer,
  Lifecycle,
  LifecycleAuditRow,
  OutlineBadge,
  Tier,
} from "../graph";
import type { Rect } from "./geometry";

/** One box on the Schematic, semantic or annotation. */
export interface SchematicNode {
  id: string;
  slug: string;
  title: string;
  kind: SchematicNodeKind;
  /** `null` sits at the Schematic root. A group's members are its children,
   *  so a group nests inside another group by the same field (PRD §12.4). */
  parentId: string | null;
  rect: Rect;
  /** Drawn with a `▸`, its descendants hidden and their edges rolled up to
   *  this box's border (PRD §12.3). */
  collapsed: boolean;
  /** Comment only: the author name the box draws under its heading. */
  author?: string;
  /** Comment only: the body text. */
  body?: string;
  /** The part this node plays on its Schematic, if any (PRD §12.10, §12.11).
   *  What the role costs the node is `SchematicConfig.nodePolicy`, per tier. */
  role?: NodeRole;
  /** Carried through from the graph so a projection back to `ServiceGraph`
   *  loses nothing the Outline draws. Neither is read by the engine. */
  badge?: OutlineBadge;
  lifecycle?: Lifecycle;

  // --- PRD §12.6 node anatomy (Wave 4), projected from `GraphNode` by
  // `./layout.ts`'s `buildDoc`. Every field mirrors `../graph/types.ts`'s
  // `GraphNode` — see that file for what each draws. ------------------------

  layer?: Layer;
  description?: string;
  authoredBy?: "human" | "agent";
  facets?: FacetCounts;
  libraries?: readonly string[];
  health?: HealthStatus;
  exportsCount?: number;
  modulesCount?: number;
  dependentsCount?: number;
  sharedAtLca?: boolean;
  schemasResolved?: boolean;
  deprecatedSuccessor?: string;
  staleReason?: string;
  exported?: boolean;
  budgetTier?: "hard" | "soft";

  // --- PRD §12.11 facet content (Wave 5), tier 3 only. Mirrors
  // `../graph/types.ts`'s `GraphNode` — see that file for what each draws. --

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

  // --- PRD §12.12 Inspector content (Wave 6), mirroring `../graph/types.ts`'s
  // `GraphNode` — see that file for what each draws. -------------------------

  decisions?: readonly string[];
  runReference?: string;
  assignee?: string;
  auditRows?: readonly LifecycleAuditRow[];
  given?: string;
  when?: string;
  then?: string;
  markerToken?: string;
  testLinkState?: "declared" | "linked";
  lastDurationMs?: number;
  mismatch?: string;
  semantics?: string;
  budgetSignOff?: string;
  budgetTrending?: boolean;
  exports?: readonly ExportRow[];
  resolvedMethods?: readonly ContractMethodSummary[];
  screenLinks?: readonly string[];
  inboundReferenceCount?: number;
  danglingReferences?: readonly string[];
}

/** One stored semantic edge. A drawn containment line at tier 3 is not one of
 *  these — see `frame.ts`. */
export interface SchematicEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
}

/** A whole open Schematic. `slug` names the layout file it persists to, and
 *  `title` is what the breadcrumb draws for it. `tier` is Wave 5's addition,
 *  optional so the hand-built documents `engine.test.ts` and
 *  `routing.test.ts` already construct keep compiling; `engine/layout.ts`'s
 *  `buildDoc` always sets it on a document opened through `openSchematic`,
 *  and `toGraph` reads it (defaulting to `"service"`, matching every
 *  pre-Wave-5 caller's only tier) to decide what an annotation-tier `group`
 *  node's presence in the projected Outline means at each tier (see that
 *  function's own comment). */
export interface SchematicDoc {
  slug: string;
  title: string;
  tier?: Tier;
  nodes: readonly SchematicNode[];
  edges: readonly SchematicEdge[];
}

/**
 * Derived lookups, rebuilt whenever the document changes. Held apart from the
 * document so the document stays a plain value that history can snapshot and
 * compare without dragging a Map along.
 */
export interface DocIndex {
  byId: ReadonlyMap<string, SchematicNode>;
  childrenOf: ReadonlyMap<string | null, readonly SchematicNode[]>;
}

export function indexDoc(doc: SchematicDoc): DocIndex {
  const byId = new Map<string, SchematicNode>();
  const childrenOf = new Map<string | null, SchematicNode[]>();
  for (const node of doc.nodes) {
    byId.set(node.id, node);
    const bucket = childrenOf.get(node.parentId);
    if (bucket) bucket.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  return { byId, childrenOf };
}

export function childrenOf(index: DocIndex, id: string | null): readonly SchematicNode[] {
  return index.childrenOf.get(id) ?? [];
}

/** Every node under `id`, at any depth. The count a collapsed box draws is
 *  this list's length, computed at draw time and never stored (PRD §0.4).
 *
 *  Visits each node once, which is what stops a `parentId` cycle from queueing
 *  the same pair forever — the descending half of the hazard `ancestorsOf`
 *  below describes, reached from `drawNode`'s collapsed count and from
 *  `../engine/anatomy.ts`'s `healthRollupFor`. */
export function descendantsOf(index: DocIndex, id: string): SchematicNode[] {
  const out: SchematicNode[] = [];
  const seen = new Set<string>([id]);
  const queue = [...childrenOf(index, id)];
  while (queue.length > 0) {
    const node = queue.pop() as SchematicNode;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
    queue.push(...childrenOf(index, node.id));
  }
  return out;
}

/**
 * From a node's parent up to the Schematic root, nearest first.
 *
 * **Stops on a cycle rather than following one.** `isHidden` calls this for
 * every node on every frame, so a `parentId` chain that loops does not draw a
 * wrong picture — it pushes until the array cannot grow, then throws `Invalid
 * array length` seconds and gigabytes later, inside render, where `App.tsx`'s
 * `openSchematic` catch cannot reach it.
 *
 * Neither source of a document is trusted to be acyclic: `.kaava/nodes/` is
 * loaded with a loop intact on purpose so rule L01 can report it
 * (`crates/schematify-core/src/graph.rs`), and `./layout.ts`'s
 * `fromAnnotation` copies `parentId` off `layout/<slug>.json` unvalidated.
 * Guarding here makes that invariant one thing to hold rather than one to
 * remember at each producer. Truncating costs nothing: every ancestor above
 * the repeat is already in `out`.
 */
export function ancestorsOf(index: DocIndex, id: string): SchematicNode[] {
  const out: SchematicNode[] = [];
  const seen = new Set<string>([id]);
  let current = index.byId.get(id)?.parentId ?? null;
  while (current !== null) {
    const node = index.byId.get(current);
    if (!node || seen.has(node.id)) break;
    seen.add(node.id);
    out.push(node);
    current = node.parentId;
  }
  return out;
}

/** True when `ancestorId` is at or above `id`. Guards a reparent against a
 *  containment cycle (PRD §12.5). */
export function isAtOrAbove(index: DocIndex, ancestorId: string, id: string): boolean {
  if (ancestorId === id) return true;
  return ancestorsOf(index, id).some((node) => node.id === ancestorId);
}

/** True when a collapsed ancestor hides this node. */
export function isHidden(index: DocIndex, id: string): boolean {
  return ancestorsOf(index, id).some((node) => node.collapsed);
}

/**
 * The node actually drawn in place of `id`: itself when nothing hides it, and
 * otherwise the outermost collapsed ancestor, which is the box an edge rolls
 * up to (PRD §12.3). Returns `null` only for an id the document does not hold.
 */
export function visibleStandIn(index: DocIndex, id: string): SchematicNode | null {
  const node = index.byId.get(id);
  if (!node) return null;
  const chain = ancestorsOf(index, id);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (chain[i].collapsed) return chain[i];
  }
  return node;
}

/** Every node drawn this frame, in document order: a node no collapsed
 *  ancestor hides. */
export function visibleNodes(doc: SchematicDoc, index: DocIndex): SchematicNode[] {
  return doc.nodes.filter((node) => !isHidden(index, node.id));
}

/** True for a comment or a group (PRD §11.3). */
export function isAnnotation(node: SchematicNode): boolean {
  return isAnnotationKind(node.kind);
}

/** The slugs already used among a node's siblings — slug uniqueness is scoped
 *  to the parent (PRD §3.2), so a duplicate only has to avoid these. */
export function siblingSlugs(index: DocIndex, parentId: string | null): Set<string> {
  return new Set(childrenOf(index, parentId).map((node) => node.slug));
}
