// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TitleBarActions from "./TitleBarActions";

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof TitleBarActions>[0]> = {}) {
  const props = {
    onUpgrade: vi.fn(),
    onNewAgent: vi.fn(),
    terminalOpen: false,
    onToggleTerminal: vi.fn(),
    agentsOpen: false,
    onToggleAgents: vi.fn(),
    clustersOpen: true,
    onToggleClusters: vi.fn(),
    onOpenSettings: vi.fn(),
    ...over,
  };
  render(<TitleBarActions {...props} />);
  return props;
}

describe("TitleBarActions", () => {
  it("wires each button to its own action", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    fireEvent.click(screen.getByRole("button", { name: "New agent session" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(p.onUpgrade).toHaveBeenCalledTimes(1);
    expect(p.onNewAgent).toHaveBeenCalledTimes(1);
    expect(p.onToggleTerminal).toHaveBeenCalledTimes(1);
    expect(p.onToggleAgents).toHaveBeenCalledTimes(1);
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("has a Clusters button that toggles the list and shows its state", () => {
    const p = setup({ clustersOpen: false });
    const button = screen.getByRole("button", { name: /^Clusters/ });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(p.onToggleClusters).toHaveBeenCalledTimes(1);
  });

  it("shows the Clusters button pressed while the list is open", () => {
    setup({ clustersOpen: true });
    expect(screen.getByRole("button", { name: /^Clusters/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("disables New agent session when there is no cluster to open it in", () => {
    setup({ onNewAgent: undefined });
    expect(screen.getByRole("button", { name: "New agent session" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("shows the Agents button pressed while its page is open", () => {
    setup({ agentsOpen: true });
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
