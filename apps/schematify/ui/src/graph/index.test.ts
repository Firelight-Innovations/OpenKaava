/**
 * Cell 1 and cell 2 are exact-string acceptance conditions for Wave 2 (PRD
 * §17), so these assertions match those strings literally rather than
 * loosely. Cell 5 (the session-only semantic-write notice, added later — see
 * `StatusBar.tsx`'s own header comment) carries the same exact-string
 * discipline for the same reason: a person reads this cell, so its wording
 * is the acceptance condition, not a loose "is truthy" check. Everything
 * here is computed from `AUTH_SERVICE_GRAPH` (or, for cell 5, a literal path
 * list) at call time — none of it is a stored count, per PRD §0.4 — so a
 * change to the fixture that changed a count would fail exactly the test
 * that should catch it.
 */
import { describe, expect, it } from "vitest";
import { AUTH_SERVICE_GRAPH } from "./fixture";
import type { GraphNode, SchematicGraph } from "./types";
import {
  buildOutlineRows,
  computeDepth,
  countEdges,
  countNodes,
  loadGraph,
  outlineFooter,
  plural,
  stackHeaderCounts,
  statusCell1,
  statusCell2,
  statusCell5,
} from "./index";

describe("loadGraph", () => {
  it("resolves the auth-service fixture", async () => {
    const graph = await loadGraph();
    expect(graph.serviceSlug).toBe("auth-service");
  });
});

describe("computed counts", () => {
  it("counts 12 nodes", () => {
    expect(countNodes(AUTH_SERVICE_GRAPH)).toBe(12);
  });

  it("counts 9 edges", () => {
    expect(countEdges(AUTH_SERVICE_GRAPH)).toBe(9);
  });

  it("computes containment depth 3", () => {
    expect(computeDepth(AUTH_SERVICE_GRAPH.nodes)).toBe(3);
  });

  it("throws rather than looping forever on a containment cycle", () => {
    const cyclic: GraphNode[] = [
      { id: "a", slug: "a", title: "A", kind: "module", parentId: "b" },
      { id: "b", slug: "b", title: "B", kind: "module", parentId: "a" },
    ];
    expect(() => computeDepth(cyclic)).toThrow(/cycle/);
  });

  it("treats a dangling parentId as top-level rather than throwing", () => {
    const dangling: GraphNode[] = [
      { id: "a", slug: "a", title: "A", kind: "module", parentId: "no-such-node" },
    ];
    expect(computeDepth(dangling)).toBe(2);
  });
});

describe("status bar", () => {
  it("draws cell 1 exactly as PRD §17 Wave 2 requires", () => {
    expect(statusCell1(AUTH_SERVICE_GRAPH)).toBe(".kaava/ · 12 nodes · 9 edges");
  });

  it("draws cell 2 exactly as PRD §17 Wave 2 requires", () => {
    expect(statusCell2(AUTH_SERVICE_GRAPH)).toBe("layout/auth-service.json clean");
  });

  it("draws cell 2 as modified when the layout is not clean", () => {
    expect(statusCell2(AUTH_SERVICE_GRAPH, false)).toBe("layout/auth-service.json modified");
  });

  it("draws cell 5 blank when nothing has written to the semantic layer", () => {
    expect(statusCell5([])).toBe("");
  });

  it("draws cell 5 with a singular noun for exactly 1 semantic write", () => {
    expect(statusCell5(["nodes/token-issuer.json"])).toBe(
      "1 unsaved change — session only, lost on reload",
    );
  });

  it("draws cell 5 with a plural noun and the distinct file count for several writes", () => {
    expect(statusCell5(["nodes/token-issuer.json", "edges/e1.json"])).toBe(
      "2 unsaved changes — session only, lost on reload",
    );
  });

  it("counts a path once no matter how many times undo/redo replayed it", () => {
    // `engine.semanticWrites` records one array entry per write event, so a
    // reparent that gets undone and redone appears twice for the same path
    // (`engine.ts`'s `applySemantic`). Cell 5 counts files at risk, not
    // write events, so this must still read 1 rather than 3.
    expect(statusCell5(["nodes/a.json", "nodes/a.json", "nodes/a.json"])).toBe(
      "1 unsaved change — session only, lost on reload",
    );
  });
});

describe("outline footer", () => {
  it("reads 12 nodes · depth 3", () => {
    expect(outlineFooter(AUTH_SERVICE_GRAPH)).toBe("12 nodes · depth 3");
  });
});

describe("buildOutlineRows", () => {
  const rows = buildOutlineRows(AUTH_SERVICE_GRAPH);

  it("draws every root-level node and every expanded node's children, but no row for a collapsed node's children", () => {
    // 12 nodes total; session-store's 2 children (session-codec,
    // session-index) get no row of their own because session-store is
    // collapsed. 12 - 2 = 10 rows.
    expect(rows).toHaveLength(10);
    expect(rows.some((row) => row.node.id === "session-codec")).toBe(false);
    expect(rows.some((row) => row.node.id === "session-index")).toBe(false);
  });

  it("draws token-verifier's children as their own rows, since it is not collapsed", () => {
    expect(rows.some((row) => row.node.id === "jwks-cache")).toBe(true);
    expect(rows.some((row) => row.node.id === "clock-skew")).toBe(true);
  });

  it("gives the collapsed session-store row a trailing count of 2", () => {
    const sessionStore = rows.find((row) => row.node.id === "session-store");
    expect(sessionStore?.hiddenChildCount).toBe(2);
  });

  it("draws the ENTRY badge on http-entry and the STALE badge on audit-emitter, and no other row", () => {
    const badged = rows.filter((row) => row.node.badge !== undefined);
    expect(badged.map((row) => [row.node.id, row.node.badge])).toEqual([
      ["http-entry", "ENTRY"],
      ["audit-emitter", "STALE"],
    ]);
  });

  it("indents a child one level deeper than its parent", () => {
    const parent = rows.find((row) => row.node.id === "token-verifier");
    const child = rows.find((row) => row.node.id === "jwks-cache");
    expect(child?.depth).toBe((parent?.depth ?? 0) + 1);
  });
});

/**
 * Every count string in this app was written with its noun already plural,
 * which is correct for the fixtures — every count in them is above 1 — and
 * wrong for a real project. The Stack Schematic is where it first shows: of
 * this repository's own 17 services, several hold exactly 1 module, so the
 * landing view drew `1 modules` on the first screen anyone sees.
 *
 * Asserted at 1 and at 0, because the fixtures cover neither and that is why
 * this went unnoticed.
 */
describe("plural", () => {
  it("draws the singular at 1", () => {
    expect(plural(1, "service")).toBe("1 service");
    expect(plural(1, "module")).toBe("1 module");
    expect(plural(1, "dependency edge")).toBe("1 dependency edge");
  });

  it("draws the plural at 0 and above 1", () => {
    expect(plural(0, "export")).toBe("0 exports");
    expect(plural(2, "export")).toBe("2 exports");
    expect(plural(17, "service")).toBe("17 services");
  });

  it("takes an irregular plural rather than guessing one", () => {
    expect(plural(1, "child", "children")).toBe("1 child");
    expect(plural(2, "child", "children")).toBe("2 children");
  });
});

/** The two strings the Stack Schematic draws from a project holding exactly
 *  one of everything — the case no fixture covers. */
describe("the tier-1 count strings at 1", () => {
  const ONE_SERVICE: SchematicGraph = {
    tier: "stack",
    serviceSlug: "stack",
    serviceTitle: "one",
    nodes: [{ id: "s", slug: "only", title: "Only", kind: "service", parentId: null }],
    edges: [{ id: "e", kind: "depends_on", from: "s", to: "s" }],
  };

  it("draws the header in the singular", () => {
    expect(stackHeaderCounts(ONE_SERVICE)).toBe("1 service · 1 dependency edge");
  });

  it("draws status bar cell 1 in the singular", () => {
    expect(statusCell1(ONE_SERVICE)).toBe(".kaava/ · 1 service");
  });
});
