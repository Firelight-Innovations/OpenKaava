/**
 * `projectServiceGraph` is the one place the real, whole-project graph
 * (`schematify/load-graph`'s response) and this app's narrower `ServiceGraph`
 * meet. These assertions read the written content — the actual nodes, edges,
 * and their fields — rather than only checking that the function did not
 * throw, per STANDARDS.md §8's rule that an assertion which cannot fail is
 * worse than none.
 */
import { describe, expect, it, vi } from "vitest";
import { coversCountFor } from "../engine/anatomy";
import { countNodes } from "./index";
import {
  projectModuleGraph,
  projectServiceGraph,
  projectStackGraph,
  type RawGraph,
  type RawNode,
} from "./project";

function node(partial: Partial<RawNode> & Pick<RawNode, "id" | "slug" | "kind">): RawNode {
  return {
    title: partial.slug,
    lifecycle: "accepted",
    parent: null,
    ...partial,
  };
}

const RAW: RawGraph = {
  nodes: [
    node({ id: "svc", slug: "auth-service", kind: "service", title: "Auth Service" }),
    node({ id: "m1", slug: "http-entry", kind: "module", title: "HTTP Entry", parent: "svc" }),
    node({
      id: "m2",
      slug: "token-verifier",
      kind: "module",
      title: "Token Verifier",
      parent: "svc",
    }),
    node({
      id: "m3",
      slug: "jwks-cache",
      kind: "module",
      title: "JWKS Cache",
      parent: "m2",
      layer: "backend",
    }),
    node({
      id: "m4",
      slug: "audit-emitter",
      kind: "module",
      title: "Audit Emitter",
      parent: "svc",
      lifecycle: "stale",
    }),
    node({ id: "g1", slug: "core", kind: "group", title: "Core", parent: "svc" }),
    // A different service entirely, and a module inside it — neither should
    // ever appear in `auth-service`'s projection.
    node({ id: "svc2", slug: "billing-service", kind: "service", title: "Billing Service" }),
    node({ id: "n1", slug: "invoicer", kind: "module", title: "Invoicer", parent: "svc2" }),
    // A module's tier-3 facets. The Module Schematic draws these, not the
    // Service one — dropped entirely, not collapsed to "module" (that
    // collapse was tried first and inflated a 12-module real service into
    // 70 nodes on contact with `fixtures/saas-backend/`; see the wiring
    // handoff).
    node({ id: "f1", slug: "verify", kind: "contract-method", title: "verify", parent: "m2" }),
    node({ id: "f2", slug: "verify-case-1", kind: "test-case", title: "Case 1", parent: "m2" }),
    node({ id: "f3", slug: "verify-p95", kind: "budget", title: "verify_p95", parent: "m2" }),
    // A comment anchored to a module in this service — its drawn position
    // comes from `anchor` (PRD §11.3), not from this `parent` field, which
    // only says the comment belongs under `auth-service` at all.
    node({
      id: "c1",
      slug: "watch-out",
      kind: "comment",
      title: "Watch out",
      parent: "svc",
      anchor: "m2",
      body: "This one gets paged on.",
      author: "m.ross",
    }),
    // A floating comment: no anchor at all.
    node({
      id: "c2",
      slug: "floating-note",
      kind: "comment",
      title: "Floating note",
      parent: "svc",
    }),
  ],
  edges: [
    { id: "e1", kind: "depends_on", source: "m1", target: "m2" },
    { id: "e2", kind: "depends_on", source: "m1", target: "svc2" }, // crosses services — dropped
    { id: "e3", kind: "contains", source: "svc", target: "m1" }, // never a GraphEdge
    { id: "e4", kind: "implements", source: "m4", target: "m2" },
    { id: "e5", kind: "depends_on", source: "n1", target: "svc2" }, // wrong service entirely
    { id: "e6", kind: "depends_on", source: "m1", target: "g1" }, // a group is drawn, never an edge endpoint
    { id: "e7", kind: "depends_on", source: "m1", target: "c1" }, // a comment is drawn, never an edge endpoint
  ],
};

describe("projectServiceGraph", () => {
  const graph = projectServiceGraph(RAW, "auth-service");

  it("names the service by its slug and title", () => {
    expect(graph.serviceSlug).toBe("auth-service");
    expect(graph.serviceTitle).toBe("Auth Service");
    expect(graph.tier).toBe("service");
  });

  it("includes auth-service's own modules, group, and comments, not billing-service's", () => {
    const ids = graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["c1", "c2", "g1", "m1", "m2", "m3", "m4"].sort());
  });

  it("drops every tier-3 facet under a module — the Module Schematic's content, not the Service one's", () => {
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).not.toContain("f1");
    expect(ids).not.toContain("f2");
    expect(ids).not.toContain("f3");
  });

  it("draws a comment as a node, carrying its body and author", () => {
    const comment = graph.nodes.find((n) => n.id === "c1");
    expect(comment).toBeDefined();
    expect(comment?.kind).toBe("comment");
    expect(comment?.body).toBe("This one gets paged on.");
    expect(comment?.author).toBe("m.ross");
  });

  it("positions an anchored comment at its anchor, not its containment parent", () => {
    // `c1`'s raw `parent` is `svc` (it just belongs under auth-service), but
    // its `anchor` names `m2` — the node it is drawn pinned to, per
    // `../engine/engine.ts`'s own "anchored to a node by parentId" wording.
    expect(graph.nodes.find((n) => n.id === "c1")?.parentId).toBe("m2");
  });

  it("floats a comment with no anchor — parentId null", () => {
    expect(graph.nodes.find((n) => n.id === "c2")?.parentId).toBeNull();
  });

  it("draws a group as a node, but see index.test.ts / index.ts for why it is not counted", () => {
    // Per the owner's ruling: drawn and counted are different questions. A
    // group is annotation-tier (PRD §11.3) and is excluded from
    // `countNodes` (`./index.ts`), not from this projection — it is a real
    // containment box the Service Schematic draws.
    expect(graph.nodes.map((n) => n.id)).toContain("g1");
    expect(graph.nodes.find((n) => n.id === "g1")?.kind).toBe("group");
  });

  it("draws 7 nodes but counts 4 — a group and a comment are drawn, neither counted", () => {
    // `m1`-`m4` are the only real modules; `g1`, `c1`, `c2` are annotation
    // tier. `isAnnotationNodeKind` (`./types.ts`) has to name both kinds or
    // `countNodes` (`./index.ts`) miscounts one of them as a module.
    expect(graph.nodes).toHaveLength(7);
    expect(countNodes(graph)).toBe(4);
  });

  it("maps a top-level module's parent to null, matching the fixture convention", () => {
    const httpEntry = graph.nodes.find((n) => n.id === "m1");
    expect(httpEntry?.parentId).toBeNull();
  });

  it("keeps a nested node's real parent id", () => {
    const jwksCache = graph.nodes.find((n) => n.id === "m3");
    expect(jwksCache?.parentId).toBe("m2");
  });

  it("keeps the module kind as-is", () => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("m1")?.kind).toBe("module");
  });

  it("carries layer through when the raw node has one", () => {
    expect(graph.nodes.find((n) => n.id === "m3")?.layer).toBe("backend");
  });

  it("badges a stale node STALE and nothing else", () => {
    const badged = graph.nodes.filter((n) => n.badge !== undefined);
    expect(badged.map((n) => n.id)).toEqual(["m4"]);
    expect(badged[0].badge).toBe("STALE");
  });

  it("draws PRD §7.4's exact second caption line for a stale node with a stale mark", () => {
    const withStale: RawGraph = {
      nodes: [
        node({ id: "svc", slug: "auth-service", kind: "service", title: "Auth Service" }),
        node({
          id: "m2",
          slug: "crypto-primitives",
          kind: "module",
          title: "Crypto Primitives",
          parent: "svc",
        }),
        node({
          id: "m4",
          slug: "audit-emitter",
          kind: "module",
          title: "Audit Emitter",
          parent: "svc",
          lifecycle: "stale",
          stale: { source: "m2", member: "sign", at: "2026-08-25T12:00:00Z" },
        }),
      ],
      edges: [],
    };
    const now = Date.parse("2026-08-25T14:00:00Z");
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const result = projectServiceGraph(withStale, "auth-service");
      const auditEmitter = result.nodes.find((n) => n.id === "m4");
      expect(auditEmitter?.staleReason).toBe(
        "crypto-primitives.sign changed 2h ago. Re-review required.",
      );
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("leaves staleReason undefined for a stale node with no stale mark yet", () => {
    // A node written `stale` before Wave 10 started setting the field, or
    // one the CI-facing loader quarantined the reference out of — either
    // way, no caption is better than a caption naming nothing.
    const noMark: RawGraph = {
      nodes: [
        node({ id: "svc", slug: "auth-service", kind: "service" }),
        node({
          id: "m4",
          slug: "audit-emitter",
          kind: "module",
          parent: "svc",
          lifecycle: "stale",
        }),
      ],
      edges: [],
    };
    const result = projectServiceGraph(noMark, "auth-service");
    expect(result.nodes.find((n) => n.id === "m4")?.staleReason).toBeUndefined();
  });

  it("keeps a depends_on edge whose ends are both in the subtree", () => {
    expect(graph.edges.some((e) => e.id === "e1")).toBe(true);
  });

  it("drops an edge that crosses into another service", () => {
    expect(graph.edges.some((e) => e.id === "e2")).toBe(false);
    expect(graph.edges.some((e) => e.id === "e5")).toBe(false);
  });

  it("drops a contains edge — containment is parentId, never an edge", () => {
    expect(graph.edges.some((e) => e.id === "e3")).toBe(false);
  });

  it("drops an edge naming a group as an endpoint, even though the group itself is drawn", () => {
    expect(graph.edges.some((e) => e.id === "e6")).toBe(false);
  });

  it("drops an edge naming a comment as an endpoint, even though the comment itself is drawn", () => {
    expect(graph.edges.some((e) => e.id === "e7")).toBe(false);
  });

  it("keeps an implements edge, renaming source/target to from/to", () => {
    const implementsEdge = graph.edges.find((e) => e.id === "e4");
    expect(implementsEdge).toEqual({ id: "e4", kind: "implements", from: "m4", to: "m2" });
  });

  it("throws when no service carries the requested slug", () => {
    expect(() => projectServiceGraph(RAW, "no-such-service")).toThrow(/no-such-service/);
  });

  it("draws 13 nodes but counts 12, against auth-service's real containment shape", () => {
    // `fixtures/saas-backend/`'s actual `auth-service` (real slugs, real
    // containment — see the wiring handoff's fixture comparison): 12
    // modules plus one real top-level group, `token-pipeline`. Drawn and
    // counted are different questions per the owner's ruling — this test is
    // what the ruling asked to be asserted against the real fixture's
    // shape, not just against a synthetic `g1`/`m1` stand-in above.
    const auth: RawGraph = {
      nodes: [
        node({ id: "svc", slug: "auth-service", kind: "service", title: "Auth Service" }),
        node({ id: "n1", slug: "http-entry", kind: "module", parent: "svc" }),
        node({ id: "n2", slug: "token-issuer", kind: "module", parent: "svc" }),
        node({ id: "n3", slug: "token-verifier", kind: "module", parent: "svc" }),
        node({ id: "n4", slug: "jwks-cache", kind: "module", parent: "n3" }),
        node({ id: "n5", slug: "clock-skew", kind: "module", parent: "n3" }),
        node({ id: "n6", slug: "session-store", kind: "module", parent: "svc" }),
        node({ id: "n7", slug: "session-codec", kind: "module", parent: "n6" }),
        node({ id: "n8", slug: "session-index", kind: "module", parent: "n6" }),
        node({ id: "n9", slug: "crypto-primitives", kind: "module", parent: "svc" }),
        node({ id: "n10", slug: "password-hasher", kind: "module", parent: "svc" }),
        node({ id: "n11", slug: "rate-limiter", kind: "module", parent: "svc" }),
        node({ id: "n12", slug: "audit-emitter", kind: "module", parent: "svc" }),
        node({ id: "n13", slug: "token-pipeline", kind: "group", parent: "svc" }),
      ],
      edges: [],
    };
    const result = projectServiceGraph(auth, "auth-service");
    expect(result.nodes).toHaveLength(13);
    expect(result.nodes.map((n) => n.slug)).toContain("token-pipeline");
    expect(countNodes(result)).toBe(12);
  });

  it("does not hang on a containment cycle that never reaches the service", () => {
    const cyclic: RawGraph = {
      nodes: [
        node({ id: "svc", slug: "auth-service", kind: "service" }),
        node({ id: "a", slug: "a", kind: "module", parent: "b" }),
        node({ id: "b", slug: "b", kind: "module", parent: "a" }),
      ],
      edges: [],
    };
    const result = projectServiceGraph(cyclic, "auth-service");
    expect(result.nodes).toHaveLength(0);
  });
});

/**
 * `projectModuleGraph` — the wave 7c counterpart of `projectServiceGraph`
 * above. Shaped after PRD §16.1's `token-verifier` module paragraph: a
 * `cold_start_p95` budget with no probe (the exact node an L03 Problems row's
 * click-through has to land on, per the wave 7b handoff's known gap) and a
 * `verify_signature` contract method with 2 live `covers` edges.
 */
describe("projectModuleGraph", () => {
  const RAW: RawGraph = {
    nodes: [
      node({ id: "svc", slug: "auth-service", kind: "service", title: "Auth Service" }),
      node({
        id: "mod",
        slug: "token-verifier",
        kind: "module",
        title: "Token Verifier",
        parent: "svc",
        layer: "backend",
        description: "Verifies JWT signatures against the rotating key set.",
        ui_refs: ["schematify://screen/login-form"],
      }),
      node({
        id: "verify",
        slug: "verify_signature",
        kind: "contract-method",
        title: "verify_signature",
        parent: "mod",
        signature: "(token: string, jwks: KeySet)",
        returns: "Result<Claims, VerifyError>",
        exported: true,
      }),
      node({
        id: "budget",
        slug: "cold_start_p95",
        kind: "budget",
        title: "cold_start_p95",
        parent: "mod",
        metric: "cold_start_p95",
        op: "<",
        value: 800,
        unit: "ms",
        tier: "hard",
      }),
      node({
        id: "test1",
        slug: "test-expired-token",
        kind: "test-case",
        title: "expired token is rejected",
        parent: "mod",
        status: "passing",
      }),
      node({
        id: "doc",
        slug: "doc-verify",
        kind: "doc-block",
        title: "Usage note",
        parent: "mod",
        audience: "agent",
        body: "Call verify_signature before any session lookup.",
      }),
      node({
        id: "dep",
        slug: "jose",
        kind: "external-dep",
        title: "jose",
        parent: "mod",
        registry_ref: "lib-jose",
      }),
      node({ id: "g1", slug: "checks", kind: "group", title: "Checks", parent: "mod" }),
      node({
        id: "note1",
        slug: "anchored-note",
        kind: "comment",
        title: "Anchored note",
        parent: "mod",
        anchor: "verify",
        body: "Rotate before touching this.",
        author: "m.ross",
      }),
      node({
        id: "note2",
        slug: "floating-note",
        kind: "comment",
        title: "Floating note",
        parent: "mod",
      }),
      // A different module entirely — nothing here should leak in.
      node({ id: "mod2", slug: "token-issuer", kind: "module", parent: "svc" }),
      node({
        id: "other-method",
        slug: "mint",
        kind: "contract-method",
        title: "mint",
        parent: "mod2",
      }),
    ],
    edges: [
      { id: "e1", kind: "covers", source: "test1", target: "verify" },
      { id: "e2", kind: "covers", source: "test1", target: "verify" }, // 2nd case, same method
      { id: "e3", kind: "covers", source: "test1", target: "other-method" }, // wrong module — dropped
      { id: "e4", kind: "depends_on", source: "verify", target: "budget" }, // not a tier-3 kind — dropped
    ],
    libraries: { libraries: [{ id: "lib-jose", name: "jose", version: "5.2.4", license: "MIT" }] },
  };

  const graph = projectModuleGraph(RAW, "token-verifier");

  it("names the module by its slug and title, tier module", () => {
    expect(graph.serviceSlug).toBe("token-verifier");
    expect(graph.serviceTitle).toBe("Token Verifier");
    expect(graph.tier).toBe("module");
  });

  it("draws the module root as its own node, parentId null, unlike a service root", () => {
    const root = graph.nodes.find((n) => n.id === "mod");
    expect(root).toBeDefined();
    expect(root?.parentId).toBeNull();
    expect(root?.description).toBe("Verifies JWT signatures against the rotating key set.");
    expect(root?.screenRef).toBe("schematify://screen/login-form");
    expect(root?.layer).toBe("backend");
  });

  it("includes only token-verifier's own facets, not token-issuer's", () => {
    const ids = graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(
      ["budget", "doc", "mod", "test1", "verify", "dep", "g1", "note1", "note2"].sort(),
    );
  });

  it("keeps a facet's real parent id — the module's own, not null", () => {
    expect(graph.nodes.find((n) => n.id === "verify")?.parentId).toBe("mod");
  });

  it("draws a group facet on the Module Schematic — the same annotation-tier gap the Service tier had", () => {
    const group = graph.nodes.find((n) => n.id === "g1");
    expect(group).toBeDefined();
    expect(group?.kind).toBe("group");
  });

  it("draws a comment facet on the Module Schematic, positioned at its anchor", () => {
    const comment = graph.nodes.find((n) => n.id === "note1");
    expect(comment).toBeDefined();
    expect(comment?.kind).toBe("comment");
    expect(comment?.body).toBe("Rotate before touching this.");
    expect(comment?.author).toBe("m.ross");
    expect(comment?.parentId).toBe("verify");
  });

  it("floats a module-tier comment with no anchor — parentId null", () => {
    expect(graph.nodes.find((n) => n.id === "note2")?.parentId).toBeNull();
  });

  it("draws a contract method's signature, returns, and exported flag — not a stored covers count", () => {
    const verify = graph.nodes.find((n) => n.id === "verify");
    expect(verify?.signature).toBe("(token: string, jwks: KeySet)");
    expect(verify?.returns).toBe("Result<Claims, VerifyError>");
    expect(verify?.exported).toBe(true);
    // Wave 6 removed GraphNode.coversCount as a PRD §0.4 breach — a caller
    // computes it from the real edges via coversCountFor, below, not from a
    // field this projection would otherwise be storing a 2nd time.
  });

  it("returns real covers edges a caller can compute coversCountFor from — 2 for this module, not the 3rd targeting a different module's facet", () => {
    const coversTargetingVerify = graph.edges.filter(
      (e) => e.kind === "covers" && e.to === "verify",
    );
    expect(coversTargetingVerify).toHaveLength(2);
    expect(coversCountFor("verify", graph.edges)).toBe(2);
  });

  it("draws a budget's tier, threshold text, and leaves budgetValueText undefined — no probe, PRD §16.1's exact node", () => {
    const budget = graph.nodes.find((n) => n.id === "budget");
    expect(budget?.budgetTier).toBe("hard");
    expect(budget?.budgetThresholdText).toBe("< 800 ms");
    expect(budget?.budgetProbe).toBeUndefined();
    expect(budget?.budgetValueText).toBeUndefined();
  });

  it("draws a test case's status", () => {
    expect(graph.nodes.find((n) => n.id === "test1")?.testStatus).toBe("passing");
  });

  it("draws a doc block's audience and body", () => {
    const doc = graph.nodes.find((n) => n.id === "doc");
    expect(doc?.docAudience).toBe("agent");
    expect(doc?.docBody).toBe("Call verify_signature before any session lookup.");
  });

  it("resolves an external dep's version and license off the library registry", () => {
    const dep = graph.nodes.find((n) => n.id === "dep");
    expect(dep?.depVersion).toBe("5.2.4");
    expect(dep?.depLicense).toBe("MIT");
    expect(dep?.depRegistryOk).toBe(true);
  });

  it("marks an external dep unresolved when its registry_ref names nothing in libraries", () => {
    const withUnresolvedDep: RawGraph = {
      nodes: [
        node({ id: "svc", slug: "auth-service", kind: "service" }),
        node({ id: "mod", slug: "token-verifier", kind: "module", parent: "svc" }),
        node({
          id: "dep",
          slug: "ghost",
          kind: "external-dep",
          parent: "mod",
          registry_ref: "no-such-library",
        }),
      ],
      edges: [],
    };
    const result = projectModuleGraph(withUnresolvedDep, "token-verifier");
    const dep = result.nodes.find((n) => n.id === "dep");
    expect(dep?.depRegistryOk).toBe(false);
    expect(dep?.depVersion).toBeUndefined();
  });

  it("keeps a covers edge between 2 included facets", () => {
    expect(graph.edges.filter((e) => e.kind === "covers")).toHaveLength(2);
  });

  it("drops a covers edge that reaches outside this module", () => {
    expect(graph.edges.some((e) => e.id === "e3")).toBe(false);
  });

  it("drops an edge kind tier 3 does not carry", () => {
    expect(graph.edges.some((e) => e.id === "e4")).toBe(false);
  });

  it("throws when no module carries the requested slug", () => {
    expect(() => projectModuleGraph(RAW, "no-such-module")).toThrow(/no-such-module/);
  });

  it("draws PRD §7.4's caption on a stale module root, the same as a stale service-tier module", () => {
    const withStale: RawGraph = {
      nodes: [
        node({ id: "svc", slug: "auth-service", kind: "service" }),
        node({ id: "dep-src", slug: "crypto-primitives", kind: "module", parent: "svc" }),
        node({
          id: "mod",
          slug: "audit-emitter",
          kind: "module",
          parent: "svc",
          lifecycle: "stale",
          stale: { source: "dep-src", member: "sign", at: "2026-08-25T12:00:00Z" },
        }),
      ],
      edges: [],
    };
    const now = Date.parse("2026-08-25T14:00:00Z");
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const result = projectModuleGraph(withStale, "audit-emitter");
      const root = result.nodes.find((n) => n.id === "mod");
      expect(root?.badge).toBe("STALE");
      expect(root?.staleReason).toBe("crypto-primitives.sign changed 2h ago. Re-review required.");
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});

/**
 * `projectStackGraph` — tier 1, and the last of the three to get a real
 * projector. Until it did, `backend.ts` answered the stack tier with an empty
 * graph no matter what the project held, and `App.tsx` compensated by landing
 * on a service named `auth-service` instead. Every project without one drew
 * `no service named "auth-service" in this project` over the whole shell, and
 * the Stack Schematic was no way out of it: it had no nodes to click.
 *
 * The graph below is PRD §16.1's own stack shape — a group that really
 * contains services, a service nested in another service, modules and facets
 * that belong to deeper tiers, and one annotation per tier — so the assertions
 * read against the arrangement the PRD describes rather than a shape invented
 * here.
 */
describe("projectStackGraph", () => {
  const STACK: RawGraph = {
    nodes: [
      node({ id: "gw", slug: "api-gateway", kind: "service", title: "API Gateway" }),
      // A real containment parent, not a cosmetic overlay (PRD §16.1).
      node({ id: "core", slug: "platform-core", kind: "group", title: "Platform Core" }),
      node({
        id: "auth",
        slug: "auth-service",
        kind: "service",
        title: "Auth Service",
        parent: "core",
        layer: "backend",
      }),
      node({
        id: "sess",
        slug: "session-service",
        kind: "service",
        title: "Session Service",
        parent: "core",
      }),
      // A service inside a service: PRD §16.1's `ledger-store`.
      node({
        id: "ledger",
        slug: "ledger-store",
        kind: "service",
        title: "Ledger Store",
        parent: "sess",
      }),
      // Tier 2 and tier 3. None of it is tier 1's to draw, but the counts on
      // the service faces are computed from it.
      node({ id: "m1", slug: "http-entry", kind: "module", parent: "auth" }),
      node({ id: "m2", slug: "token-verifier", kind: "module", parent: "auth" }),
      node({ id: "m3", slug: "ledger-writer", kind: "module", parent: "ledger" }),
      node({ id: "f1", slug: "verify", kind: "contract-method", parent: "m2", exported: true }),
      node({ id: "f2", slug: "decode", kind: "contract-method", parent: "m2", exported: true }),
      node({ id: "f3", slug: "cache-key", kind: "contract-method", parent: "m2", exported: false }),
      node({ id: "f4", slug: "verify-case-1", kind: "test-case", parent: "m2" }),
      // An annotation group that arranges one service's modules — tier 2's,
      // not tier 1's, even though its own parent is a service.
      node({ id: "g2", slug: "token-pipeline", kind: "group", parent: "auth" }),
      // A comment on the stack canvas, anchored to a service.
      node({
        id: "c1",
        slug: "stack-note",
        kind: "comment",
        title: "Stack note",
        anchor: "gw",
        body: "The gateway fronts all three.",
        author: "b.seaborn",
      }),
      // A comment about a module: it belongs to that service's Schematic.
      node({ id: "c2", slug: "module-note", kind: "comment", parent: "m2", anchor: "m2" }),
    ],
    edges: [
      { id: "se1", kind: "depends_on", source: "gw", target: "auth" },
      { id: "se2", kind: "depends_on", source: "gw", target: "sess" },
      // Tier 2's line, between two modules — never drawn here.
      { id: "se3", kind: "depends_on", source: "m1", target: "m2" },
      // Containment is `parentId`, never an edge.
      { id: "se4", kind: "contains", source: "core", target: "auth" },
      // An annotation is never an edge endpoint.
      { id: "se5", kind: "depends_on", source: "gw", target: "core" },
    ],
    brief: {
      product_name: "saas-backend",
      problem: "",
      users: [],
      goals: [],
      non_goals: [],
      constraints: [],
      success_metrics: [],
    },
  };

  const graph = projectStackGraph(STACK);

  it("draws every service in the project, at any containment depth", () => {
    const services = graph.nodes.filter((n) => n.kind === "service").map((n) => n.slug);
    expect(services.sort()).toEqual([
      "api-gateway",
      "auth-service",
      "ledger-store",
      "session-service",
    ]);
  });

  it("opens at the stack tier without being told a slug", () => {
    expect(graph.tier).toBe("stack");
  });

  it("titles the Schematic from the project brief, having no root node to take one from", () => {
    expect(graph.serviceTitle).toBe("saas-backend");
  });

  it("falls back to the layout slug when the project states no brief", () => {
    expect(projectStackGraph({ nodes: [], edges: [] }).serviceTitle).toBe("stack");
  });

  it("nests a service inside the group that contains it", () => {
    expect(graph.nodes.find((n) => n.id === "auth")?.parentId).toBe("core");
  });

  it("nests a service inside another service", () => {
    expect(graph.nodes.find((n) => n.id === "ledger")?.parentId).toBe("sess");
  });

  it("keeps a group that really contains services", () => {
    expect(graph.nodes.find((n) => n.id === "core")?.kind).toBe("group");
  });

  it("drops a group that arranges one service's modules, which is tier 2's", () => {
    expect(graph.nodes.some((n) => n.id === "g2")).toBe(false);
  });

  it("draws a comment on the stack canvas at its anchor, not at its containment parent", () => {
    const comment = graph.nodes.find((n) => n.id === "c1");
    expect(comment?.parentId).toBe("gw");
    expect(comment?.body).toBe("The gateway fronts all three.");
  });

  it("drops a comment that belongs to a module's Schematic", () => {
    expect(graph.nodes.some((n) => n.id === "c2")).toBe(false);
  });

  it("draws no modules and no facets", () => {
    const deeper = ["m1", "m2", "m3", "f1", "f2", "f3", "f4"];
    expect(graph.nodes.some((n) => deeper.includes(n.id))).toBe(false);
  });

  it("counts each service's own modules, not the ones its child service holds", () => {
    expect(graph.nodes.find((n) => n.id === "auth")?.modulesCount).toBe(2);
    expect(graph.nodes.find((n) => n.id === "ledger")?.modulesCount).toBe(1);
  });

  it("counts a service's exports as its exported contract methods alone", () => {
    expect(graph.nodes.find((n) => n.id === "auth")?.exportsCount).toBe(2);
  });

  /**
   * `../engine/anatomy.ts`'s `countStringsFor` guards on `!== undefined`, so
   * writing `0` here is not a smaller number, it is a count string appearing
   * where the convention draws none — `./stack.ts`'s `event-bus` carries
   * neither field on purpose, and `notification-service` carries
   * `exportsCount: 0` on purpose. Counting nothing is not the same claim as
   * counting zero.
   */
  it("omits a count it has nothing to count, rather than writing zero", () => {
    const sess = graph.nodes.find((n) => n.id === "sess");
    expect(sess?.modulesCount).toBeUndefined();
    expect(sess?.exportsCount).toBeUndefined();
    // `ledger-store` has a module but no exported method: 1 field, not 2.
    expect(graph.nodes.find((n) => n.id === "ledger")?.exportsCount).toBeUndefined();
  });

  it("draws the dependency edges that run between services", () => {
    expect(graph.edges.map((e) => e.id).sort()).toEqual(["se1", "se2"]);
  });

  it("draws no edge whose endpoint is an annotation, and none for containment", () => {
    expect(graph.edges.some((e) => ["se3", "se4", "se5"].includes(e.id))).toBe(false);
  });

  it("returns an empty graph for a project with no services, rather than throwing", () => {
    const empty = projectStackGraph({ nodes: [], edges: [] });
    expect(empty.tier).toBe("stack");
    expect(empty.nodes).toEqual([]);
  });

  /**
   * A `.kaava/` tree is a directory a person can hand-edit, so a `parent`
   * chain that loops is a real possibility rather than a hypothetical one —
   * `isDescendantOf` guards the tier-2 and tier-3 walks for the same reason.
   * Without the guard this hangs rather than failing, which is why it is
   * asserted on its own instead of left to the cases above.
   */
  it("terminates on a containment cycle instead of walking it forever", () => {
    const cyclic: RawGraph = {
      nodes: [
        node({ id: "a", slug: "a", kind: "group", parent: "b" }),
        node({ id: "b", slug: "b", kind: "group", parent: "a" }),
        node({ id: "svc", slug: "orphan", kind: "service", parent: "a" }),
      ],
      edges: [],
    };
    expect(projectStackGraph(cyclic).nodes.map((n) => n.slug)).toContain("orphan");
  });

  it("drops a parent that is not itself drawn here, rather than dangling the reference", () => {
    const nested: RawGraph = {
      nodes: [
        node({ id: "svc", slug: "outer", kind: "service" }),
        node({ id: "m", slug: "inner-module", kind: "module", parent: "svc" }),
        node({ id: "svc2", slug: "misplaced", kind: "service", parent: "m" }),
      ],
      edges: [],
    };
    const result = projectStackGraph(nested);
    expect(result.nodes.find((n) => n.id === "svc2")?.parentId).toBeNull();
  });
});

/**
 * The containment cycle, taken as far as the engine rather than as far as the
 * projector.
 *
 * `crates/schematify-core/src/graph.rs` loads a project whose `parent` chain
 * loops on purpose — "A cycle in the `parent` chain terminates the walk rather
 * than hanging. Rule L01 reports the cycle" — so `schematify/load-graph` hands
 * one to this app rather than refusing it. Tiers 2 and 3 never had to think
 * about that: `isDescendantOf` only admits a node whose chain reaches the
 * Schematic's root, and a cyclic chain reaches no root. Tier 1 has no root, so
 * for one revision it copied the loop through into `parentId`.
 *
 * What that cost is not a wrong picture. `engine/doc.ts`'s `ancestorsOf` walks
 * `parentId` once per node per frame with no guard, so `buildFrame` allocated
 * until it threw `Invalid array length`, in render, past the point `App.tsx`
 * catches — and the L01 finding that would have explained it sits in a Dock
 * that never drew. These assert the shape the engine needs (a forest) rather
 * than only that the projector returned.
 */
describe("projectStackGraph and containment cycles", () => {
  /** Follows `parentId` from every node and returns the ids whose walk
   *  repeats. The engine's own precondition, stated as a check. */
  function nodesOnACycle(graph: ReturnType<typeof projectStackGraph>): string[] {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.nodes
      .filter((start) => {
        const seen = new Set<string>([start.id]);
        let current = start.parentId ? byId.get(start.parentId) : undefined;
        while (current) {
          if (seen.has(current.id)) return true;
          seen.add(current.id);
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return false;
      })
      .map((n) => n.id);
  }

  const TWO_GROUPS: RawGraph = {
    nodes: [
      node({ id: "a", slug: "a", kind: "group", parent: "b" }),
      node({ id: "b", slug: "b", kind: "group", parent: "a" }),
      node({ id: "svc", slug: "orphan", kind: "service", parent: "a" }),
    ],
    edges: [],
  };

  it("emits a forest, not a cycle, for two groups that contain each other", () => {
    expect(nodesOnACycle(projectStackGraph(TWO_GROUPS))).toEqual([]);
  });

  it("still draws the service that hung off the cycle", () => {
    expect(projectStackGraph(TWO_GROUPS).nodes.map((n) => n.slug)).toContain("orphan");
  });

  it("emits a forest for two services that name each other as parent", () => {
    const swapped: RawGraph = {
      nodes: [
        node({ id: "s1", slug: "one", kind: "service", parent: "s2" }),
        node({ id: "s2", slug: "two", kind: "service", parent: "s1" }),
      ],
      edges: [],
    };
    const graph = projectStackGraph(swapped);
    expect(nodesOnACycle(graph)).toEqual([]);
    // Neither service is lost: the landing view is the only way into a
    // project, so a malformed link costs nesting, never a whole service.
    expect(graph.nodes.map((n) => n.slug).sort()).toEqual(["one", "two"]);
  });

  it("emits a forest for a cycle three long", () => {
    const three: RawGraph = {
      nodes: [
        node({ id: "x", slug: "x", kind: "service", parent: "z" }),
        node({ id: "y", slug: "y", kind: "service", parent: "x" }),
        node({ id: "z", slug: "z", kind: "service", parent: "y" }),
      ],
      edges: [],
    };
    expect(nodesOnACycle(projectStackGraph(three))).toEqual([]);
  });

  /**
   * A comment takes its `parentId` from `anchor`, not from `parent`, so a
   * cycle can be closed by a field the containment walk never reads. The cut
   * runs over the emitted nodes for exactly this reason.
   */
  it("emits a forest when a comment's anchor closes the loop", () => {
    const anchored: RawGraph = {
      nodes: [
        node({ id: "svc", slug: "svc", kind: "service", parent: "c1" }),
        node({ id: "c1", slug: "note", kind: "comment", anchor: "svc" }),
      ],
      edges: [],
    };
    expect(nodesOnACycle(projectStackGraph(anchored))).toEqual([]);
  });

  it("leaves a well-formed nesting alone", () => {
    const nested: RawGraph = {
      nodes: [
        node({ id: "core", slug: "platform-core", kind: "group" }),
        node({ id: "sess", slug: "session-service", kind: "service", parent: "core" }),
        node({ id: "ledger", slug: "ledger-store", kind: "service", parent: "sess" }),
      ],
      edges: [],
    };
    const graph = projectStackGraph(nested);
    expect(nodesOnACycle(graph)).toEqual([]);
    expect(graph.nodes.find((n) => n.id === "ledger")?.parentId).toBe("sess");
    expect(graph.nodes.find((n) => n.id === "sess")?.parentId).toBe("core");
  });
});

/**
 * A service that contains another service — PRD §16.1's own shape,
 * `ledger-store` inside `session-service`. Tier 2 asked "is this service
 * somewhere above me", which for a nested service is true of two of them, so
 * the inner one's modules were drawn on the outer one's Schematic as well as
 * having a Schematic of their own (`nextDrillTarget` offers a service target
 * for any service, nested included). They also arrived carrying a `parentId`
 * naming the inner service, and `SERVICE_SCHEMATIC_KINDS` excludes `service`
 * from the node list — so `nestedFlow` never placed them and they stacked at
 * the world origin while their siblings were arranged around them.
 *
 * The question is "which service do I belong to", and that is the nearest one.
 * Found from tier 1: `modulesCount` attributes a module to its nearest service
 * ancestor, the two answers disagreed, and only one of them can be what
 * drilling in shows.
 */
describe("projectServiceGraph with a service inside a service", () => {
  const NESTED: RawGraph = {
    nodes: [
      node({ id: "sess", slug: "session-service", kind: "service", title: "Session Service" }),
      node({ id: "own", slug: "own-module", kind: "module", parent: "sess" }),
      node({ id: "grp", slug: "session-core", kind: "group", parent: "sess" }),
      node({ id: "grouped", slug: "grouped-module", kind: "module", parent: "grp" }),
      node({ id: "deep", slug: "deep-module", kind: "module", parent: "own" }),
      // The nested service and everything under it.
      node({ id: "ledger", slug: "ledger-store", kind: "service", parent: "sess" }),
      node({ id: "lw", slug: "ledger-writer", kind: "module", parent: "ledger" }),
      node({ id: "lg", slug: "ledger-core", kind: "group", parent: "ledger" }),
    ],
    edges: [],
  };

  const outer = projectServiceGraph(NESTED, "session-service");
  const inner = projectServiceGraph(NESTED, "ledger-store");

  it("draws the outer service's own modules and groups, at every depth", () => {
    expect(outer.nodes.map((n) => n.slug).sort()).toEqual([
      "deep-module",
      "grouped-module",
      "own-module",
      "session-core",
    ]);
  });

  it("draws the inner service's modules on the inner service's Schematic", () => {
    expect(inner.nodes.map((n) => n.slug).sort()).toEqual(["ledger-core", "ledger-writer"]);
  });

  it("draws no node twice — the two Schematics do not overlap", () => {
    const both = outer.nodes.map((n) => n.id).filter((id) => inner.nodes.some((n) => n.id === id));
    expect(both).toEqual([]);
  });

  /**
   * The visible symptom, and the one that made this worth fixing rather than
   * documenting: a node whose `parentId` names something absent from
   * `graph.nodes` is a node `engine/arrange.ts` never places, so it draws at
   * the world origin under whatever else landed there.
   */
  it("leaves no node pointing at a parent it does not draw", () => {
    for (const graph of [outer, inner]) {
      const drawn = new Set(graph.nodes.map((n) => n.id));
      const dangling = graph.nodes.filter((n) => n.parentId !== null && !drawn.has(n.parentId));
      expect(dangling.map((n) => n.slug)).toEqual([]);
    }
  });

  it("still rewrites a direct child's parent to null, as the root is not drawn", () => {
    expect(outer.nodes.find((n) => n.slug === "own-module")?.parentId).toBeNull();
    expect(outer.nodes.find((n) => n.slug === "deep-module")?.parentId).toBe("own");
  });
});
