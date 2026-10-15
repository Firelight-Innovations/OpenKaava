// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import AgentBar, { ClusterAgentBar } from "./AgentBar";

afterEach(cleanup);

function prompt() {
  return screen.getByRole("textbox", { name: "Message the agent from the agent bar" });
}

describe("AgentBar", () => {
  it("sends on Enter and clears the prompt once the send lands", async () => {
    const onSend = vi.fn(() => Promise.resolve());
    render(<AgentBar blocked={null} hint={null} onSend={onSend} />);
    fireEvent.change(prompt(), { target: { value: "  fix the test " } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(onSend).toHaveBeenCalledWith("fix the test");
    expect(prompt()).toHaveProperty("value", "");
  });

  it("keeps Shift+Enter for a new line", () => {
    const onSend = vi.fn(() => Promise.resolve());
    render(<AgentBar blocked={null} hint={null} onSend={onSend} />);
    fireEvent.change(prompt(), { target: { value: "one" } });
    fireEvent.keyDown(prompt(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows a refused send in its own words and keeps the draft", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("busy")));
    render(<AgentBar blocked={null} hint={null} onSend={onSend} />);
    fireEvent.change(prompt(), { target: { value: "again" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(screen.getByRole("status").textContent).toContain("still working");
    expect(prompt()).toHaveProperty("value", "again");
  });

  it("is disabled, with the reason, on a cluster that cannot run an agent", () => {
    render(<AgentBar blocked="mainCheckout" hint={null} onSend={vi.fn()} />);
    expect(prompt()).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toContain("never run on main");
  });

  it("shows the install line when the adapter is missing, and never says Claude Code", () => {
    render(<AgentBar blocked={null} hint="adapterMissing" onSend={vi.fn()} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.90.0");
    expect(document.body.textContent).not.toContain("Claude Code");
  });

  it("tells a machine without claude to install it and sign in", () => {
    render(<AgentBar blocked={null} hint="harnessMissing" onSend={vi.fn()} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Claude is not installed");
    expect(text).toContain("run `claude` once");
  });

  it("keeps what was typed while the send was in flight", async () => {
    let land: () => void = () => {};
    const onSend = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
    render(<AgentBar blocked={null} hint={null} onSend={onSend} />);
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
        blocked={null}
        hint={null}
        onSend={() => new Promise<void>((resolve) => (land = resolve))}
      />,
    );
    fireEvent.change(prompt(), { target: { value: "  first  " } });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    await act(async () => land());
    expect(prompt()).toHaveProperty("value", "");
  });
});

describe("ClusterAgentBar", () => {
  it("starts a cluster of its own with an empty draft", () => {
    const props = { blocked: null, hint: null, onSend: vi.fn() };
    const { rerender } = render(<ClusterAgentBar clusterId="a" {...props} />);
    fireEvent.change(prompt(), { target: { value: "half typed" } });
    rerender(<ClusterAgentBar clusterId="a" {...props} />);
    expect(prompt()).toHaveProperty("value", "half typed");
    rerender(<ClusterAgentBar clusterId="b" {...props} />);
    expect(prompt()).toHaveProperty("value", "");
  });
});
