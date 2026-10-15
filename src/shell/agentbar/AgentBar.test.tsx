// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isValidElement } from "react";
import type { AgentBarStatus, BarHarnessInfo } from "../state/agentBar";
import AgentBar, { ClusterAgentBar } from "./AgentBar";
import { BarSlotsProvider, defaultBarSlots, type BarSlots } from "./slots";

afterEach(cleanup);

const CLAUDE: BarHarnessInfo = {
  harness: "claude",
  name: "Claude",
  hint: null,
  setup: {
    cli: "claude",
    signIn: "claude",
    adapterInstall: "npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.90.0",
    adapterVersion: "0.90.0",
  },
};

function status(over: Partial<AgentBarStatus> = {}): AgentBarStatus {
  return {
    blocked: null,
    harnesses: [CLAUDE],
    current: "claude",
    running: null,
    model: null,
    ...over,
  };
}

const resolved = () => vi.fn((..._args: unknown[]) => Promise.resolve());

function prompt() {
  return screen.getByRole("textbox", { name: "Message the agent from the agent bar" });
}

async function sendDraft(text: string) {
  fireEvent.change(prompt(), { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(prompt(), { key: "Enter" });
  });
}

describe("AgentBar", () => {
  it("sends on Enter and clears the prompt once the send lands", async () => {
    const onSend = resolved();
    render(<AgentBar status={status()} onSend={onSend} />);
    await sendDraft("  fix the test ");
    expect(onSend).toHaveBeenCalledWith("fix the test");
    expect(prompt()).toHaveProperty("value", "");
  });

  it("keeps Shift+Enter for a new line", () => {
    const onSend = resolved();
    render(<AgentBar status={status()} onSend={onSend} />);
    fireEvent.change(prompt(), { target: { value: "one" } });
    fireEvent.keyDown(prompt(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows a refused send in its own words and keeps the draft", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("busy")));
    render(<AgentBar status={status()} onSend={onSend} />);
    await sendDraft("again");
    expect(screen.getByRole("status").textContent).toContain("still working");
    expect(prompt()).toHaveProperty("value", "again");
  });

  it("is disabled, with the reason, on a cluster that cannot run an agent", () => {
    render(<AgentBar status={status({ blocked: "mainCheckout" })} onSend={vi.fn()} />);
    expect(prompt()).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toContain("never run on main");
  });

  it("draws every piece through its slot map", () => {
    const stub = (name: string) =>
      function Stub(props: Record<string, unknown>) {
        const passed = Object.values(props).filter(isValidElement);
        return <div data-slot={name}>{passed}</div>;
      };
    const names = Object.keys(defaultBarSlots) as (keyof BarSlots)[];
    const slots = Object.fromEntries(names.map((n) => [n, stub(n)])) as Partial<BarSlots>;
    const { container } = render(
      <BarSlotsProvider slots={slots}>
        <AgentBar status={status({ blocked: "mainCheckout" })} onSend={vi.fn()} />
      </BarSlotsProvider>,
    );
    const all = [...container.querySelectorAll("*")];
    expect(all.filter((el) => !el.hasAttribute("data-slot")).map((el) => el.outerHTML)).toEqual([]);
    expect(new Set(all.map((el) => el.getAttribute("data-slot")))).toEqual(new Set(names));
  });

  it("shows the install line when the adapter is missing, and never says Claude Code", () => {
    const missing = { ...CLAUDE, hint: "adapterMissing" };
    render(<AgentBar status={status({ harnesses: [missing] })} onSend={vi.fn()} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.90.0");
    expect(document.body.textContent).not.toContain("Claude Code");
  });

  it("tells a machine without claude to install it and sign in", () => {
    const missing = { ...CLAUDE, hint: "harnessMissing" };
    render(<AgentBar status={status({ harnesses: [missing] })} onSend={vi.fn()} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Claude is not installed");
    expect(text).toContain("run `claude` once");
  });

  it("leaves a hint a running session earns to the agent tab", () => {
    const signedOut = { ...CLAUDE, hint: "signedOut" };
    render(<AgentBar status={status({ harnesses: [signedOut] })} onSend={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps what was typed while the send was in flight", async () => {
    let land: () => void = () => {};
    const onSend = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
    render(<AgentBar status={status()} onSend={onSend} />);
    fireEvent.change(prompt(), { target: { value: "first" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("first");
    fireEvent.change(prompt(), { target: { value: "the start of the next" } });
    await act(async () => land());
    expect(prompt()).toHaveProperty("value", "the start of the next");
  });

  it("clears the box when it still holds what was sent, trimmed or not", async () => {
    let land: () => void = () => {};
    render(
      <AgentBar
        status={status()}
        onSend={() => new Promise<void>((resolve) => (land = resolve))}
      />,
    );
    fireEvent.change(prompt(), { target: { value: "  first  " } });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    await act(async () => land());
    expect(prompt()).toHaveProperty("value", "");
  });

  it("names the harness, and the model only while its agent runs", () => {
    const { rerender } = render(<AgentBar status={status({ model: "Opus" })} onSend={vi.fn()} />);
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.queryByText("Opus")).toBeNull();
    rerender(<AgentBar status={status({ running: "claude", model: "Opus" })} onSend={vi.fn()} />);
    expect(screen.getByText("Opus")).toBeTruthy();
  });

  it("names the harness that is not ready when the host refuses it", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("harness")));
    render(<AgentBar status={status()} onSend={onSend} />);
    await sendDraft("hello");
    expect(screen.getByRole("status").textContent).toBe("Claude is not ready to run.");
  });
});

describe("ClusterAgentBar", () => {
  it("starts a cluster of its own with an empty draft", () => {
    const props = { status: status(), onSend: vi.fn() };
    const { rerender } = render(<ClusterAgentBar clusterId="a" {...props} />);
    fireEvent.change(prompt(), { target: { value: "half typed" } });
    rerender(<ClusterAgentBar clusterId="a" {...props} />);
    expect(prompt()).toHaveProperty("value", "half typed");
    rerender(<ClusterAgentBar clusterId="b" {...props} />);
    expect(prompt()).toHaveProperty("value", "");
  });
});
