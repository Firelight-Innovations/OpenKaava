// @vitest-environment jsdom
/**
 * The transcript's live touches: the reasoning the agent is still writing
 * shimmers, and stops once the turn is over.
 */
import "./jsdom-shims";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@openkaava/bridge", () => ({
  invoke: bridge.invoke,
  on: () => () => {},
  reportPainted: vi.fn(),
  KaavaRpcError: class extends Error {},
}));

import App from "./App";
import type { Attachment, Item, SessionState } from "./protocol.generated";

function item(id: string, kind: Item["kind"]): Item {
  return { id, turnId: "t1", kind };
}

function session(state: SessionState, items: Item[]): Attachment {
  return {
    seq: 1,
    status: {
      state,
      harness: "claude",
      cwd: "C:/work",
      mode: "default",
      adapterVersion: null,
      exitCode: null,
      hint: null,
      pendingPrompt: null,
    },
    items,
  };
}

function backend(attachment: Attachment) {
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "agent-tab/attach") return Promise.resolve(attachment);
    if (method === "agent-tab/harnesses")
      return Promise.resolve({ harnesses: [{ harness: "claude", hint: null }], blocked: null });
    return Promise.resolve({});
  });
}

const PROMPT = item("u", { kind: "userMessage", text: "why" });
const THOUGHT = item("r", { kind: "reasoning", text: "hmm" });

beforeEach(() => bridge.invoke.mockReset());
afterEach(cleanup);

describe("the transcript", () => {
  it("shimmers the thinking label while the agent is still thinking", async () => {
    backend(session("working", [PROMPT, THOUGHT]));
    render(<App />);
    const label = await screen.findByText("Thinking");
    expect(label.hasAttribute("data-live")).toBe(true);
  });

  it("stops the shimmer once the turn is over", async () => {
    backend(session("ready", [PROMPT, THOUGHT]));
    render(<App />);
    const label = await screen.findByText("Thinking");
    expect(label.hasAttribute("data-live")).toBe(false);
  });

  it("folds the reasoning behind a caret, not the browser's triangle", async () => {
    backend(session("ready", [PROMPT, THOUGHT]));
    render(<App />);
    const summary = (await screen.findByText("Thinking")).closest("summary");
    expect(summary?.className).toContain("at-disclosure");
  });
});
