/**
 * The `saas-backend` Stack Schematic fixture (PRD §16.1's Stack tier table).
 * The interesting numbers here are the ones WIREFRAME-EXTRACT.md Resolution
 * 10.2 rules on: the wireframe draws `6 services` where the table names 7,
 * and PRD §0.4 makes the computed value the truth over the drawn one.
 */
import { describe, expect, it } from "vitest";
import { computeDepth, countEdges, countServices, loadGraph, statusCell1 } from "./index";
import { STACK_GRAPH } from "./stack";

describe("STACK_GRAPH", () => {
  it("counts 8 nodes: 7 services and 1 group", () => {
    expect(STACK_GRAPH.nodes).toHaveLength(8);
    expect(STACK_GRAPH.nodes.filter((node) => node.kind === "service")).toHaveLength(7);
    expect(STACK_GRAPH.nodes.filter((node) => node.kind === "group")).toHaveLength(1);
  });

  it("computes 7 services, not the wireframe's drawn 6", () => {
    // WIREFRAME-EXTRACT.md §9: the wireframe's own Outline omits
    // `ledger-store` even though it is drawn on canvas and is `service`-kind
    // per the fixture table. Resolution 10.2 rules the computed count (7) as
    // the truth to draw, not the wireframe's `6`.
    expect(countServices(STACK_GRAPH)).toBe(7);
  });

  it("computes 7 dependency edges, from PRD prose rather than SVG geometry", () => {
    // WIREFRAME-EXTRACT.md Resolution 10.2's 3rd row: built from PRD §16.1's
    // "Seven dependency edges join them," not from tracing the wireframe's
    // drawn paths.
    expect(countEdges(STACK_GRAPH)).toBe(7);
  });

  it("gives event-bus exactly 4 dependents, matching its own drawn badge", () => {
    const eventBus = STACK_GRAPH.nodes.find((node) => node.id === "event-bus");
    expect(eventBus?.dependentsCount).toBe(4);
    const consumers = STACK_GRAPH.edges.filter((edge) => edge.to === "event-bus");
    expect(consumers).toHaveLength(4);
  });

  it("nests auth-service and session-service inside platform-core, and ledger-store inside session-service", () => {
    expect(STACK_GRAPH.nodes.find((node) => node.id === "auth-service")?.parentId).toBe(
      "platform-core",
    );
    expect(STACK_GRAPH.nodes.find((node) => node.id === "session-service")?.parentId).toBe(
      "platform-core",
    );
    expect(STACK_GRAPH.nodes.find((node) => node.id === "ledger-store")?.parentId).toBe(
      "session-service",
    );
  });

  it("carries the 4-row derived tech stack PRD §16.1 names", () => {
    expect(STACK_GRAPH.techStack?.map((row) => [row.name, row.moduleCount])).toEqual([
      ["jose", 6],
      ["zod", 14],
      ["argon2", 2],
      ["postgres", 9],
    ]);
  });

  it("computes a containment depth deeper than either drawn number", () => {
    // Neither the wireframe's drawn `2` nor WIREFRAME-EXTRACT.md's own
    // speculative "would make depth 3" counts `platform-core` as a real
    // containment level. It is one (a `service`-kind grandchild sits under
    // it), so the honest computed depth is 4 — recorded as a divergence in
    // the Wave 5 handoff, not silently matched to either drawn number.
    expect(computeDepth(STACK_GRAPH.nodes)).toBe(4);
  });

  it("draws status bar cell 1 as services only, with no edge count", () => {
    expect(statusCell1(STACK_GRAPH)).toBe(".veistra/ · 7 services");
  });
});

describe("loadGraph at the stack tier", () => {
  it("resolves the stack fixture regardless of slug", async () => {
    const graph = await loadGraph("stack", "saas-backend");
    expect(graph.serviceSlug).toBe("saas-backend");
    expect(graph.tier).toBe("stack");
  });
});
