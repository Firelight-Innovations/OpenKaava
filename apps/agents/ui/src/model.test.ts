import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, ago, byMachine, byWorkflow, stateOf, titleOf } from "./model";
import type { Machine, Overview, Session, Status } from "./rpc";

const NOW = Date.parse("2026-09-28T16:00:00Z");

function session(agent: string, id: string, status: Status | null): Session {
  return {
    agent,
    sessionId: id,
    statusGeneration: 1,
    written: "2026-09-28T00:00:00Z",
    status,
    transcript: null,
  };
}

const machine = (name: string, status = "RUNNING"): Machine => ({
  name,
  zone: "us-central1-a",
  status,
  machineType: "e2-standard-8",
  role: "agent",
  lastStart: null,
  lastStop: null,
});

describe("stateOf", () => {
  it("calls a running session stale once its last event is old", () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const old = new Date(NOW - STALE_AFTER_MS - 60_000).toISOString();
    expect(stateOf(session("a", "1", { state: "running", updated: fresh }), NOW)).toBe("running");
    expect(stateOf(session("a", "1", { state: "running", updated: old }), NOW)).toBe("stale");
  });

  it("never calls an idle or ended session stale", () => {
    const old = "2020-01-01T00:00:00Z";
    expect(stateOf(session("a", "1", { state: "idle", updated: old }), NOW)).toBe("idle");
    expect(stateOf(session("a", "1", { state: "ended", updated: old }), NOW)).toBe("ended");
  });

  it("reports an unreadable status as unknown", () => {
    expect(stateOf(session("a", "1", null), NOW)).toBe("unknown");
  });
});

describe("titleOf", () => {
  it("prefers the prompt, then the first request, then the workflow step", () => {
    const wf = { name: "asset-build", run: "r1", step: "render" };
    expect(titleOf(session("a", "1", { prompt: "Do it", workflow: wf }), "Earlier")).toBe("Do it");
    expect(titleOf(session("a", "1", { prompt: null, workflow: wf }), "Earlier")).toBe("Earlier");
    expect(titleOf(session("a", "1", { workflow: wf }))).toBe("asset-build · render");
    expect(titleOf(session("a", "abcdef1234", {}))).toBe("Session abcdef12");
  });
});

describe("byMachine", () => {
  it("splits live from recent and keeps a machine with no sessions", () => {
    const recent = new Date(NOW - 60_000).toISOString();
    const overview: Overview = {
      source: "fixture",
      project: "p",
      machines: [machine("w1"), machine("w2", "TERMINATED")],
      sessions: [
        session("w1", "live", { state: "running", updated: recent }),
        session("w1", "done", { state: "ended", updated: recent }),
        session("gone", "x", { state: "idle", updated: recent }),
      ],
      problems: [],
    };
    const groups = byMachine(overview, NOW);
    expect(groups.map((g) => g.name)).toEqual(["w1", "w2", "gone"]);
    expect(groups[0].live.map((s) => s.sessionId)).toEqual(["live"]);
    expect(groups[0].recent.map((s) => s.sessionId)).toEqual(["done"]);
    expect(groups[1].live).toEqual([]);
    expect(groups[2].machine).toBeNull();
  });
});

describe("byWorkflow", () => {
  it("groups by run, orders steps oldest first, and puts hand-started sessions last", () => {
    const wf = (run: string, step: string) => ({ name: "asset-build", run, step });
    const groups = byWorkflow([
      session("a", "render", { workflow: wf("r1", "render"), updated: "2026-09-28T12:00:00Z" }),
      session("a", "model", { workflow: wf("r1", "model"), updated: "2026-09-28T11:00:00Z" }),
      session("b", "other", { workflow: wf("r0", "build"), updated: "2026-09-27T09:00:00Z" }),
      session("a", "manual", { updated: "2026-09-28T15:00:00Z" }),
    ]);
    expect(groups.map((g) => g.run)).toEqual(["r1", "r0", null]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["model", "render"]);
  });
});

describe("ago", () => {
  it("rounds to the coarsest unit that still reads as recent", () => {
    expect(ago(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
    expect(ago(new Date(NOW - 4 * 60_000).toISOString(), NOW)).toBe("4 min ago");
    expect(ago(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3 h ago");
    expect(ago("2026-09-01T00:00:00Z", NOW)).toBe("2026-09-01");
  });
});
