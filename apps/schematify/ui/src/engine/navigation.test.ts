/**
 * Click-to-drill (PRD §17 Wave 5). Pure and DOM-free — see `./navigation.ts`'s
 * own header comment for why this is the one piece of the drill gesture that
 * gets a test at all.
 */
import { describe, expect, it } from "vitest";
import { MODULE_CONFIG, SERVICE_CONFIG, STACK_CONFIG } from "./presets";
import { configFor, LANDING_PATH, nextDrillTarget } from "./navigation";

describe("nextDrillTarget", () => {
  it("opens a Service Schematic from a click on a service at the stack tier", () => {
    expect(
      nextDrillTarget("stack", {
        kind: "service",
        slug: "billing-service",
        title: "Billing Service",
      }),
    ).toEqual({ tier: "service", slug: "billing-service", title: "Billing Service" });
  });

  it("opens a Module Schematic from a click on a module at the service tier", () => {
    expect(
      nextDrillTarget("service", {
        kind: "module",
        slug: "token-verifier",
        title: "Token Verifier",
      }),
    ).toEqual({ tier: "module", slug: "token-verifier", title: "Token Verifier" });
  });

  it("goes nowhere for a group, at the stack tier", () => {
    expect(
      nextDrillTarget("stack", { kind: "group", slug: "platform-core", title: "Platform Core" }),
    ).toBeNull();
  });

  it("goes nowhere for a facet card, at the module tier", () => {
    expect(
      nextDrillTarget("module", {
        kind: "contract-method",
        slug: "verify_signature",
        title: "verify_signature",
      }),
    ).toBeNull();
  });

  it("goes nowhere for a module clicked at the stack tier", () => {
    // Wrong tier for that kind: a module is not a service.
    expect(nextDrillTarget("stack", { kind: "module", slug: "x", title: "X" })).toBeNull();
  });
});

describe("configFor", () => {
  it("returns the stack preset unmodified, since there is exactly 1 stack", () => {
    expect(configFor({ tier: "stack", slug: "anything", title: "Stack" })).toBe(STACK_CONFIG);
  });

  it("overrides the service preset's layoutSlug per target", () => {
    const config = configFor({
      tier: "service",
      slug: "billing-service",
      title: "Billing Service",
    });
    expect(config.layoutSlug).toBe("billing-service");
    expect(config.tier).toBe("service");
    expect(config.edgeKinds).toBe(SERVICE_CONFIG.edgeKinds);
  });

  it("overrides the module preset's layoutSlug per target", () => {
    const config = configFor({ tier: "module", slug: "jwks-cache", title: "JWKS Cache" });
    expect(config.layoutSlug).toBe("jwks-cache");
    expect(config.arrangement).toBe(MODULE_CONFIG.arrangement);
  });
});

/**
 * The landing view. This is the test that would have caught the defect: the
 * app opened by asking for a service named `auth-service`, so every project
 * that did not happen to be `fixtures/saas-backend/` drew
 * `no service named "auth-service" in this project` over the whole shell and
 * offered nothing to click past it.
 *
 * The rule that fixes it is stated as an assertion rather than as a slug,
 * because pinning the literal `"stack"` would pass just as happily for a
 * second hardcoded service. What matters is that the landing view names
 * nothing the project has to contain.
 */
describe("LANDING_PATH", () => {
  it("opens the highest tier there is", () => {
    expect(LANDING_PATH.map((target) => target.tier)).toEqual(["stack"]);
  });

  it("names nothing the project has to contain — no service, no module", () => {
    // A service or module target carries a slug that must resolve against the
    // graph, and `projectServiceGraph`/`projectModuleGraph` throw when it does
    // not. Only a stack target is answerable for a project nobody has opened.
    expect(LANDING_PATH.every((target) => target.tier === "stack")).toBe(true);
  });

  it("is a single segment, so the breadcrumb has nowhere left to walk back to", () => {
    expect(LANDING_PATH).toHaveLength(1);
  });

  it("carries the slug the stack preset already keys its layout file on", () => {
    // Not a claim about the project: `configFor` ignores the field at this
    // tier. Keeping the two in step is what stops a landing view from writing
    // `layout/<something-else>.json`.
    expect(LANDING_PATH[0].slug).toBe(STACK_CONFIG.layoutSlug);
  });

  it("opens the stack preset unmodified when handed to configFor", () => {
    expect(configFor(LANDING_PATH[0])).toBe(STACK_CONFIG);
  });

  it("drills straight to a service, so the tier below is one click away", () => {
    const drilled = nextDrillTarget(LANDING_PATH[0].tier, {
      kind: "service",
      slug: "orchestrator-backend",
      title: "Orchestrator Backend",
    });
    expect(drilled).toEqual({
      tier: "service",
      slug: "orchestrator-backend",
      title: "Orchestrator Backend",
    });
  });
});
