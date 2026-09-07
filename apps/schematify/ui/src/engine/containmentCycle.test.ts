/**
 * A containment cycle must not hang or crash the draw.
 *
 * `parentId` reaches the document from two places and neither is validated.
 * `.kaava/nodes/` is one: `crates/schematify-core/src/graph.rs` says plainly
 * that "a cycle in the `parent` chain terminates the walk rather than hanging.
 * Rule L01 reports the cycle" — core loads such a project on purpose and
 * leaves the complaint to the linter, so `schematify/load-graph` hands one to
 * this app rather than refusing it. `layout/<slug>.json` is the other, and it
 * is the worse of the two: `./layout.ts`'s `fromAnnotation` copies `parentId`
 * off disk verbatim, and a `layout/` file is cosmetic data a person is invited
 * to hand-edit (PRD §6.2).
 *
 * **The draw survives; one component over does not, yet.** `../graph/index.ts`'s
 * `computeDepth` still throws on a cycle by design, and `Outline.tsx` and
 * `InspectorShell.tsx` both call it during render — so the layout-file case
 * above still blanks the app through `outlineFooter`. Overturning that
 * decision means rewriting the test that pins it, which is issue 119 and not
 * this change. Do not read a green file here as "cycles are handled".
 */
import { describe, expect, it } from "vitest";
import { ancestorsOf, descendantsOf, indexDoc, type SchematicDoc } from "./doc";
import { buildFrame } from "./frame";
import { buildDoc } from "./layout";
import { STACK_CONFIG } from "./presets";
import { projectStackGraph, type RawGraph } from "../graph/project";
import type { SchematicGraph } from "../graph/types";

/** Two nodes that name each other as parent, the smallest cycle there is. */
const CYCLIC_DOC: SchematicDoc = {
  slug: "stack",
  title: "stack",
  tier: "stack",
  nodes: [
    {
      id: "a",
      slug: "a",
      title: "A",
      kind: "service",
      parentId: "b",
      collapsed: false,
      rect: { x: 0, y: 0, width: 100, height: 60 },
    },
    {
      id: "b",
      slug: "b",
      title: "B",
      kind: "service",
      parentId: "a",
      collapsed: false,
      rect: { x: 200, y: 0, width: 100, height: 60 },
    },
  ],
  edges: [],
};

describe("ancestorsOf", () => {
  it("stops on a cycle instead of walking it forever", () => {
    const index = indexDoc(CYCLIC_DOC);
    // The chain from `a` is b, then a again. It reports the finite part and
    // stops; without the guard this never returns.
    expect(ancestorsOf(index, "a").map((node) => node.id)).toEqual(["b"]);
    expect(ancestorsOf(index, "b").map((node) => node.id)).toEqual(["a"]);
  });

  it("still walks a well-formed chain to the root", () => {
    const index = indexDoc({
      ...CYCLIC_DOC,
      nodes: [
        { ...CYCLIC_DOC.nodes[0], parentId: null },
        { ...CYCLIC_DOC.nodes[1], parentId: "a" },
      ],
    });
    expect(ancestorsOf(index, "b").map((node) => node.id)).toEqual(["a"]);
  });
});

describe("descendantsOf", () => {
  it("visits each node once instead of queueing a cycle forever", () => {
    const index = indexDoc(CYCLIC_DOC);
    expect(descendantsOf(index, "a").map((node) => node.id)).toEqual(["b"]);
  });
});

/**
 * The whole draw, not just the walk. Unguarded, `isHidden` calls `ancestorsOf`
 * for every node on every frame and it pushes until the array cannot grow:
 * `buildFrame` threw `Invalid array length` after ~4 seconds and ~2.5 GB,
 * inside render, past the point `App.tsx`'s `openSchematic` catch can reach —
 * so React unmounts the tree, the shell never receives a painted frame, and
 * the L01 finding that would explain it sits in a Dock that never drew.
 */
describe("buildFrame over a cyclic document", () => {
  it("draws rather than allocating until it throws", () => {
    const frame = buildFrame({
      doc: CYCLIC_DOC,
      config: STACK_CONFIG,
      viewport: { x: -400, y: -400, zoom: 1 },
      size: { width: 2000, height: 2000 },
      selection: new Set(),
    });
    expect(frame.nodes.map((node) => node.node.id).sort()).toEqual(["a", "b"]);
  });

  /**
   * The `layout/` half, which no projector can defend against: a valid graph
   * plus two annotations whose stored `parentId`s point at each other.
   * `fromAnnotation` copies both straight into `draft.nodes`.
   */
  it("draws when the cycle comes from a hand-edited layout file, not from the graph", () => {
    const graph: SchematicGraph = {
      tier: "stack",
      serviceSlug: "stack",
      serviceTitle: "stack",
      nodes: [
        {
          id: "svc",
          slug: "only-service",
          title: "Only Service",
          kind: "service",
          parentId: null,
        },
      ],
      edges: [],
    };
    const doc = buildDoc(
      graph,
      {
        version: 1,
        schematic: "stack",
        nodes: {},
        annotations: [
          {
            id: "n1",
            kind: "group",
            slug: "one",
            title: "One",
            parentId: "n2",
            x: 0,
            y: 0,
            width: 200,
            height: 120,
          },
          {
            id: "n2",
            kind: "group",
            slug: "two",
            title: "Two",
            parentId: "n1",
            x: 0,
            y: 0,
            width: 200,
            height: 120,
          },
        ],
      },
      STACK_CONFIG,
    );

    const frame = buildFrame({
      doc,
      config: STACK_CONFIG,
      viewport: { x: -400, y: -400, zoom: 1 },
      size: { width: 2000, height: 2000 },
      selection: new Set(),
    });
    expect(frame.nodes.map((node) => node.node.id)).toContain("svc");
  });

  /**
   * The `.kaava/nodes/` half, end to end — the finding-1 path itself, and the
   * one the cases above only approximate by hand-building a document. This is
   * what `App.tsx` actually does: project, build, draw. `graph.rs` loads a
   * project shaped exactly like this and leaves rule L01 to complain, so it is
   * a real response to a real project rather than a synthetic input.
   */
  it("draws a cyclic project through the whole path: project, build, frame", () => {
    const raw: RawGraph = {
      nodes: [
        { id: "a", slug: "a", kind: "group", title: "A", lifecycle: "accepted", parent: "b" },
        { id: "b", slug: "b", kind: "group", title: "B", lifecycle: "accepted", parent: "a" },
        {
          id: "svc",
          slug: "orphan",
          kind: "service",
          title: "Orphan",
          lifecycle: "accepted",
          parent: "a",
        },
      ],
      edges: [],
    };

    const frame = buildFrame({
      doc: buildDoc(projectStackGraph(raw), null, STACK_CONFIG),
      config: STACK_CONFIG,
      viewport: { x: -400, y: -400, zoom: 1 },
      size: { width: 2000, height: 2000 },
      selection: new Set(),
    });

    // The service survives the cycle above it and is drawn, which is the whole
    // point: a malformed group must not cost a service on the only view that
    // is the way into a project.
    expect(frame.nodes.map((node) => node.node.slug)).toContain("orphan");
  });
});
