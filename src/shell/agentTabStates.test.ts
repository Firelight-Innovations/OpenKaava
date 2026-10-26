import { describe, expect, it, vi } from "vitest";
import {
  agentTabState,
  agentTabStatesVersion,
  publishAgentTabStates,
  subscribeAgentTabStates,
} from "./agentTabStates";

describe("agent tab states", () => {
  it("tells listeners only when a tab's state changes", () => {
    const heard = vi.fn();
    const stop = subscribeAgentTabStates(heard);
    publishAgentTabStates(new Map([["a1", "working"]]));
    expect(agentTabState("a1")).toBe("working");
    const seen = agentTabStatesVersion();
    publishAgentTabStates(new Map([["a1", "working"]]));
    expect(agentTabStatesVersion()).toBe(seen);
    publishAgentTabStates(new Map([["a1", "ready"]]));
    expect(agentTabState("a1")).toBe("ready");
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});
