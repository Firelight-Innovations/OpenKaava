// @vitest-environment jsdom
/**
 * The agent tab end to end against a scripted bridge: attach, live envelopes,
 * sending, approvals and refusals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => {
  class KaavaRpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
      readonly data?: unknown,
    ) {
      super(message);
    }
  }
  return {
    invoke: vi.fn(),
    listeners: new Map<string, (payload: unknown) => void>(),
    KaavaRpcError,
  };
});

vi.mock("@openkaava/bridge", () => ({
  invoke: bridge.invoke,
  on: (event: string, cb: (payload: unknown) => void) => {
    bridge.listeners.set(event, cb);
    return () => bridge.listeners.delete(event);
  },
  reportPainted: vi.fn(),
  KaavaRpcError: bridge.KaavaRpcError,
}));

import App from "./App";
import { strings } from "./strings";
import type { Attachment, Envelope, Item } from "./protocol.generated";

const STATUS = {
  state: "ready",
  harness: "claude",
  cwd: "C:/work/feature-x",
  mode: "default",
  adapterVersion: "0.90.0",
  exitCode: null,
  hint: null,
  pendingPrompt: null,
} as const;

function item(id: string, kind: Item["kind"]): Item {
  return { id, turnId: "t1", kind };
}

function backend(attachment: Attachment, overrides: Record<string, () => Promise<unknown>> = {}) {
  bridge.invoke.mockImplementation((method: string) => {
    const override = overrides[method];
    if (override) return override();
    switch (method) {
      case "agent-tab/attach":
        return Promise.resolve(attachment);
      case "agent-tab/harnesses":
        return Promise.resolve({ harnesses: [{ harness: "claude", hint: null }], blocked: null });
      default:
        return Promise.resolve({});
    }
  });
}

function emit(envelope: Envelope) {
  act(() => bridge.listeners.get("agent-tab:event")?.(envelope));
}

function prompt() {
  return screen.getByRole("textbox", { name: "Message the agent" });
}

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.listeners.clear();
});
afterEach(cleanup);

describe("the agent tab", () => {
  it("draws the attached transcript, then applies only newer events", async () => {
    backend({
      status: STATUS,
      seq: 5,
      items: [item("u1", { kind: "userMessage", text: "list the files" })],
    });
    render(<App />);
    await screen.findByText("list the files");

    emit({
      instanceId: "i",
      seq: 4,
      event: { type: "itemStarted", item: item("a0", { kind: "assistantText", text: "stale" }) },
    });
    emit({
      instanceId: "i",
      seq: 6,
      event: { type: "itemStarted", item: item("a1", { kind: "assistantText", text: "Here" }) },
    });
    emit({
      instanceId: "i",
      seq: 7,
      event: { type: "itemDelta", itemId: "a1", text: " they are" },
    });

    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("Here they are")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Ready");
  });

  it("sends on Enter as Claude and clears the prompt", async () => {
    backend({ status: null, seq: 0, items: [] });
    render(<App />);
    await screen.findByText("Start a session");
    fireEvent.change(prompt(), { target: { value: "fix the test" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      harness: "claude",
      text: "fix the test",
    });
    expect(prompt()).toHaveProperty("value", "");
  });

  it("shows a refusal and its hint in the tab's own words", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/send": () =>
          Promise.reject(
            new bridge.KaavaRpcError(-32010, "x", { code: "harness", hint: "adapterMissing" }),
          ),
      },
    );
    render(<App />);
    await screen.findByText("Start a session");
    fireEvent.change(prompt(), { target: { value: "go" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Claude is not ready to run.");
    expect(alert.textContent).toContain("claude-agent-acp@0.90.0");
    expect(prompt()).toHaveProperty("value", "go");
  });

  it("words the harness's setup hint in the empty state", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [{ harness: "claude", hint: "signedOut" }], blocked: null }),
      },
    );
    render(<App />);
    expect(await screen.findByText(strings.hint.signedOut)).toBeTruthy();
  });

  it("words an error item's hint inside the error", async () => {
    backend({
      status: STATUS,
      seq: 2,
      items: [item("e1", { kind: "error", message: "boom", hint: "harnessMissing" })],
    });
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    expect(alert.textContent).toContain(strings.hint.harnessMissing);
  });

  it("says a main checkout is why, when the shell refuses the write before the tab's own code", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/send": () =>
          Promise.reject(new bridge.KaavaRpcError(-32003, "main is read-only")),
      },
    );
    render(<App />);
    await screen.findByText("Start a session");
    fireEvent.change(prompt(), { target: { value: "go" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("main checkout");
    expect(alert.textContent).not.toContain("Could not send that.");
    expect(prompt()).toHaveProperty("value", "go");
  });

  it("answers an approval with the option clicked", async () => {
    backend({
      status: { ...STATUS, state: "needsInput" },
      seq: 3,
      items: [
        item("p1", {
          kind: "approval",
          title: "Run npm test",
          toolCallId: "c1",
          detail: "npm test",
          detailTruncated: false,
          paths: [],
          diffs: [],
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "reject", kind: "reject_once", name: "Reject" },
          ],
          answer: null,
        }),
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/answer", {
        itemId: "p1",
        optionId: "allow",
      }),
    );
    expect(screen.getByRole("button", { name: "Reject" })).toHaveProperty("disabled", true);
  });

  it("lets an approval be answered again when the answer did not land", async () => {
    backend(
      {
        status: { ...STATUS, state: "needsInput" },
        seq: 3,
        items: [
          item("p1", {
            kind: "approval",
            title: "Run npm test",
            toolCallId: "c1",
            detail: "npm test",
            detailTruncated: false,
            paths: [],
            diffs: [],
            options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
            answer: null,
          }),
        ],
      },
      { "agent-tab/answer": () => Promise.reject(new Error("gone")) },
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Allow" })).toHaveProperty("disabled", false),
    );
  });

  it("retries the prompt the error answered, and keeps what is being typed", async () => {
    backend({
      status: STATUS,
      seq: 4,
      items: [
        item("u1", { kind: "userMessage", text: "fix the build" }),
        item("e2", { kind: "error", message: "overloaded", hint: null }),
      ],
    });
    render(<App />);
    await screen.findByText("fix the build");
    fireEvent.change(prompt(), { target: { value: "half typed" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      harness: "claude",
      text: "fix the build",
    });
    expect(prompt()).toHaveProperty("value", "half typed");
  });

  it("offers to attach again when the first attach fails", async () => {
    let attempts = 0;
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/attach": () =>
          ++attempts === 1
            ? Promise.reject(new Error("not yet"))
            : Promise.resolve({
                status: STATUS,
                seq: 2,
                items: [item("u1", { kind: "userMessage", text: "back again" })],
              }),
      },
    );
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not reach the agent host.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await screen.findByText("back again");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("turns Send into Stop while the agent works, and Esc cancels the turn", async () => {
    backend({ status: { ...STATUS, state: "working" }, seq: 1, items: [] });
    render(<App />);
    await screen.findByRole("button", { name: "Stop" });
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
  });

  it("shows the accepted prompt while the agent starts, and Stop and Esc withdraw it", async () => {
    backend({
      status: { ...STATUS, state: "starting", pendingPrompt: "fix the build" },
      seq: 2,
      items: [],
    });
    render(<App />);
    await screen.findByText("fix the build");
    expect(screen.getByText(/Your message is sent once it is ready/)).toBeTruthy();
    expect(screen.queryByText("Start a session")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
    bridge.invoke.mockClear();
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
  });

  it("retries a prompt whose handshake failed, with that prompt and not an older one", async () => {
    backend({
      status: { ...STATUS, state: "failed", hint: "signedOut" },
      seq: 9,
      items: [
        item("u1", { kind: "userMessage", text: "an older prompt" }),
        item("u2", { kind: "userMessage", text: "the one that failed" }),
        item("e2", { kind: "error", message: "authentication required", hint: "signedOut" }),
      ],
    });
    render(<App />);
    await screen.findByText("the one that failed");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      harness: "claude",
      text: "the one that failed",
    });
  });

  it("never names the harness Claude Code", async () => {
    backend({ status: STATUS, seq: 1, items: [] });
    render(<App />);
    await screen.findByText("Claude");
    expect(document.body.textContent).not.toContain("Claude Code");
  });
});
