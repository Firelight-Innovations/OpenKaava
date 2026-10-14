// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import AgentBar from "./AgentBar";

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

  it("shows the one-line fix for a harness that is not ready, and never says Claude Code", () => {
    render(<AgentBar blocked={null} hint="signedOut" onSend={vi.fn()} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Run `claude` once");
    expect(document.body.textContent).not.toContain("Claude Code");
  });
});
