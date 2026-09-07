/**
 * `schematify/load-graph`'s tier/slug routing. `backend.ts`'s
 * `loadRealGraph` used to ignore both and always return `auth-service`.
 * Fixing that alone wasn't enough: `./index.ts`'s `defaultSeam.loadGraph` —
 * what `App.tsx`'s real click-through calls, 1 layer above
 * `createBackendSeam` — had the identical 0-argument-arrow shape. Both
 * layers are covered here; a fix at one proves nothing about the other,
 * since TypeScript lets a function with fewer declared parameters satisfy a
 * type requiring more.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `@openkaava/bridge` is mocked, not imported for real — its root export
// touches `window` at module load, which this plain-Node file has none of.
// `./index.ts` keeps `./backend.ts` out of its own static imports for the
// same reason; faking the one thing `backend.ts` calls covers both
// `createBackendSeam` (imported directly) and `defaultSeam` (reached
// through `./index.ts`'s own lazy `import("./backend")`).

const invokeMock = vi.fn();
vi.mock("@openkaava/bridge", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  KaavaRpcError: class KaavaRpcError extends Error {},
}));

// Import after the mock: `vi.mock` calls are hoisted above every import in
// this file by vitest's transform, so `./backend`'s own static
// `import { invoke } from "@openkaava/bridge"` resolves to the mock above,
// never the real bridge — whether reached directly (`createBackendSeam`) or
// through `./index.ts`'s lazy `import("./backend")` (`defaultSeam`).
const { createBackendSeam, productSeam } = await import("./backend");
const { defaultSeam } = await import("./index");

function response(nodes: Record<string, unknown>[]) {
  return { graph: { nodes, edges: [] }, report: { clean: true } };
}

const AUTH_SERVICE = {
  id: "svc-auth",
  slug: "auth-service",
  kind: "service",
  title: "Auth Service",
  lifecycle: "accepted",
  parent: null,
};
const BILLING_SERVICE = {
  id: "svc-billing",
  slug: "billing-service",
  kind: "service",
  title: "Billing Service",
  lifecycle: "accepted",
  parent: null,
};
const TOKEN_VERIFIER = {
  id: "mod-verifier",
  slug: "token-verifier",
  kind: "module",
  title: "Token Verifier",
  lifecycle: "accepted",
  parent: "svc-auth",
};
const COLD_START_BUDGET = {
  id: "budget-cold-start",
  slug: "cold_start_p95",
  kind: "budget",
  title: "cold_start_p95",
  lifecycle: "accepted",
  parent: "mod-verifier",
  metric: "cold_start_p95",
  op: "<",
  value: 800,
  unit: "ms",
  tier: "hard",
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("createBackendSeam().loadGraph", () => {
  it("draws the requested service, not the hardcoded auth-service default", async () => {
    invokeMock.mockResolvedValue(response([BILLING_SERVICE]));
    const graph = await createBackendSeam().loadGraph("service", "billing-service");
    expect(graph.tier).toBe("service");
    expect(graph.serviceSlug).toBe("billing-service");
  });

  it("draws the requested module and the offending node inside it, not an empty Module Schematic", async () => {
    invokeMock.mockResolvedValue(response([AUTH_SERVICE, TOKEN_VERIFIER, COLD_START_BUDGET]));
    const graph = await createBackendSeam().loadGraph("module", "token-verifier");
    expect(graph.tier).toBe("module");
    expect(graph.serviceSlug).toBe("token-verifier");
    expect(graph.nodes.map((n) => n.slug)).toContain("cold_start_p95");
  });

  it("still defaults to the auth-service Service Schematic when called with no arguments", async () => {
    invokeMock.mockResolvedValue(response([AUTH_SERVICE]));
    const graph = await createBackendSeam().loadGraph();
    expect(graph.tier).toBe("service");
    expect(graph.serviceSlug).toBe("auth-service");
  });

  /**
   * This case used to assert the opposite — that the stack tier returned an
   * empty graph without calling the backend at all, "an honest empty graph
   * ... never a silently wrong service". That was true of the stand-in and is
   * no longer true of anything: `projectStackGraph` reads the same
   * `schematify/load-graph` response every other tier does. The old assertion
   * is not deleted so much as inverted, because the behaviour it pinned is
   * exactly what this change replaces.
   */
  it("draws the project's own services at the stack tier, not an empty graph", async () => {
    invokeMock.mockResolvedValue(response([AUTH_SERVICE, BILLING_SERVICE, TOKEN_VERIFIER]));
    const graph = await createBackendSeam().loadGraph("stack", "stack");
    expect(graph.tier).toBe("stack");
    expect(graph.nodes.map((n) => n.slug).sort()).toEqual(["auth-service", "billing-service"]);
    expect(invokeMock).toHaveBeenCalledWith("schematify/load-graph", { actor: "human" });
  });
});

/**
 * `defaultSeam.loadGraph` — the seam `engine/index.ts`'s `openSchematic`
 * (and so `App.tsx`'s real click-through) actually calls, one layer above
 * `createBackendSeam`. The suite above proves `createBackendSeam().loadGraph`
 * routes correctly; it proves nothing about whether the wrapper 1 layer up
 * still forwards its arguments to that function — which, until this fix,
 * it didn't.
 */
describe("defaultSeam.loadGraph (the real path a click-through calls)", () => {
  it("draws the requested module through the full seam, not just through createBackendSeam directly", async () => {
    invokeMock.mockResolvedValue(response([AUTH_SERVICE, TOKEN_VERIFIER, COLD_START_BUDGET]));
    const graph = await defaultSeam.loadGraph("module", "token-verifier");
    expect(graph.tier).toBe("module");
    expect(graph.serviceSlug).toBe("token-verifier");
  });

  it("draws the requested service through the full seam", async () => {
    invokeMock.mockResolvedValue(response([BILLING_SERVICE]));
    const graph = await defaultSeam.loadGraph("service", "billing-service");
    expect(graph.tier).toBe("service");
    expect(graph.serviceSlug).toBe("billing-service");
  });

  /**
   * The stack tier through the layer that actually serves it. Once the app
   * lands on tier 1 this is the first call every open makes — and the one
   * that used to come back empty whatever the project held.
   */
  it("draws the stack tier through the full seam, which is what the landing view opens", async () => {
    invokeMock.mockResolvedValue(response([AUTH_SERVICE, BILLING_SERVICE]));
    const graph = await defaultSeam.loadGraph("stack", "stack");
    expect(graph.tier).toBe("stack");
    expect(graph.nodes).toHaveLength(2);
  });
});

/**
 * `productSeam.loadProduct` — wave 10c's own seam, parallel to but
 * independent of `SchematifySeam` above. Unlike `loadGraph`, it takes no
 * `tier`/`slug`: PRD §12.17/§12.18 describe the Product and Decisions
 * sections as project-wide (one screen registry, one flow editor, one
 * decision log per project, not one per Schematic), and
 * `src-tauri/src/apps/schematify.rs`'s own `load_graph` has no scope
 * parameter to forward one to — it always walks the whole `.kaava/` tree
 * (see that function's own doc comment). This is not the round-2
 * `loadGraph` defect in a new place: there is no narrower call to make.
 * Asserted directly, the same way the suites above assert on `invokeMock`'s
 * own call arguments rather than only on a returned shape, so a future
 * regression that starts sending a scope silently (or drops one that turns
 * out to matter) shows up here.
 */
describe("productSeam.loadProduct", () => {
  it("calls schematify/load-graph with only actor — no tier, no slug, no scope", async () => {
    invokeMock.mockResolvedValue({
      graph: { nodes: [], edges: [], screens: [], flows: [], decisions: [], brief: null },
      report: { clean: true },
    });

    await productSeam.loadProduct();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("schematify/load-graph", { actor: "human" });
  });

  it("projects the whole-project response's product collections and node ids", async () => {
    invokeMock.mockResolvedValue({
      graph: {
        nodes: [AUTH_SERVICE, TOKEN_VERIFIER],
        edges: [],
        screens: [{ id: "s1", slug: "login-form" }],
        flows: [{ id: "f1", slug: "first-run-signup" }],
        decisions: [{ id: "d1", slug: "DEC-TEC-AUTH-004" }],
        brief: { product_name: "saas-backend" },
      },
      report: { clean: true },
    });

    const product = await productSeam.loadProduct();

    expect(product.nodeIds.has("svc-auth")).toBe(true);
    expect(product.nodeIds.has("mod-verifier")).toBe(true);
    expect(product.screens).toHaveLength(1);
    expect(product.flows).toHaveLength(1);
    expect(product.decisions).toHaveLength(1);
    expect(product.brief).toEqual({ product_name: "saas-backend" });
  });
});
