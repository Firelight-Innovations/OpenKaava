import { describe, expect, it } from "vitest";
import { agentTabFrames } from "./agentTabFrames";

const frame = (id: string, over: { isApp?: boolean; origin?: string | null } = {}) => ({
  id,
  isApp: true,
  origin: "http://app.localhost" as string | null,
  ...over,
});

describe("agentTabFrames", () => {
  it("answers the frame the payload names, at its own origin", () => {
    const frames = new Map([
      ["one", frame("agent-1")],
      ["two", frame("agent-2", { origin: "http://other.localhost" })],
    ]);
    expect(agentTabFrames(frames, { instanceId: "agent-2", harness: "pi" })).toEqual([
      ["two", "http://other.localhost"],
    ]);
  });

  it("skips a frame that has not said hello, and one that is not an app", () => {
    const frames = new Map([
      ["quiet", frame("agent-1", { origin: null })],
      ["tool", frame("agent-1", { isApp: false })],
    ]);
    expect(agentTabFrames(frames, { instanceId: "agent-1" })).toEqual([]);
  });

  it("answers nothing for a payload that names no instance", () => {
    const frames = new Map([["one", frame("agent-1")]]);
    expect(agentTabFrames(frames, null)).toEqual([]);
    expect(agentTabFrames(frames, { harness: "pi" })).toEqual([]);
    expect(agentTabFrames(frames, "agent-1")).toEqual([]);
  });
});
