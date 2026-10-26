/**
 * The calls whose params carry a choice: what `choose` sends for each kind of
 * model, and what `onChosen` hands on from the host's event.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  on: (event: string, cb: (payload: unknown) => void) => {
    bridge.listeners.set(event, cb);
    return () => bridge.listeners.delete(event);
  },
  VeistraRpcError: Error,
}));

import { CHOSEN, choose, onChosen } from "./rpc";

beforeEach(() => {
  bridge.invoke.mockReset().mockResolvedValue({});
  bridge.listeners.clear();
});

describe("choose", () => {
  it("leaves the model out unless one is given, so the host keeps the tab's", async () => {
    await choose("codex");
    expect(bridge.invoke).toHaveBeenLastCalledWith("agent-tab/choose", { harness: "codex" });
  });

  it("sends a model's value, or null for the agent's default", async () => {
    await choose("codex", "gpt-5.2");
    expect(bridge.invoke).toHaveBeenLastCalledWith("agent-tab/choose", {
      harness: "codex",
      model: "gpt-5.2",
    });
    await choose("claude", null);
    expect(bridge.invoke).toHaveBeenLastCalledWith("agent-tab/choose", {
      harness: "claude",
      model: null,
    });
  });
});

describe("onChosen", () => {
  it("hands on the harness and the model, null when the event has none", () => {
    const heard = vi.fn();
    onChosen(heard);
    const emit = bridge.listeners.get(CHOSEN);
    emit?.({ instanceId: "i", harness: "codex", model: "gpt-5.2" });
    emit?.({ instanceId: "i", harness: "claude" });
    expect(heard.mock.calls).toEqual([
      ["codex", "gpt-5.2"],
      ["claude", null],
    ]);
  });
});
