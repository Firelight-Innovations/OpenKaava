// @vitest-environment jsdom
/**
 * The Godot Viewer's send actions live in the shared footer and call the same
 * `context/put` as before: the scene tree as text, the rendered frame as an image.
 * The markup "Send markup" button shares the footer; it needs the 3D view, which
 * needs WebGL, so it is covered by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@openkaava/bridge", () => ({
  invoke: bridge.invoke,
  reportPainted: vi.fn(),
  openIn: vi.fn(),
}));

import App from "./App";

const STATE = {
  project: ".",
  scenes: ["res://main.tscn"],
  scene: "res://main.tscn",
  renderedAt: 1,
  scenePath: "res://main.tscn",
  nodes: [{ path: "Main", name: "Main", type: "Node3D", children: [] }],
  source: "parsed",
  godot: null,
  note: null,
  imageAt: 1,
  job: null,
  // No engine, so the 3D view is not attempted and the rendered frame shows.
  engineFound: false,
};

function backend(put: () => unknown = () => ({ key: "k" })) {
  bridge.invoke.mockImplementation((method: string) => {
    switch (method) {
      case "godot-viewer/state":
        return Promise.resolve(STATE);
      case "godot-viewer/image":
        return Promise.resolve({ png: "AAAA" });
      case "godot/status":
        return Promise.resolve({
          environment: { root: "C:/p", readOnly: false },
          executable: { found: null, problems: [], setting: "" },
          projects: [],
        });
      case "comments/list":
        return Promise.resolve([]);
      case "context/put":
        return Promise.resolve(put());
      default:
        return Promise.resolve(null);
    }
  });
}

const puts = () => bridge.invoke.mock.calls.filter((c) => c[0] === "context/put");

beforeEach(() => bridge.invoke.mockReset());
afterEach(cleanup);

describe("Godot Viewer send footer", () => {
  it("sends the scene tree from the footer, not the toolbar", async () => {
    backend();
    const { container } = render(<App />);
    const button = await screen.findByRole("button", { name: "Send tree" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(container.querySelector(".k-send-footer")?.contains(button)).toBe(true);
    expect(container.querySelector(".gv__actions")?.contains(button)).toBe(false);
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Sent" });
    expect(puts()[0][1]).toMatchObject({ kind: "text", label: "Godot - scene tree" });
  });

  it("sends the rendered frame from the footer", async () => {
    backend();
    const { container } = render(<App />);
    const button = await screen.findByRole("button", { name: "Send frame" });
    expect(container.querySelector(".k-send-footer")?.contains(button)).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]).toMatchObject({ kind: "image", bytesBase64: "AAAA" });
  });

  it("names what failed to send", async () => {
    backend(() => {
      throw new Error("no store");
    });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Send tree" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/Couldn't send tree to the agent/);
  });
});
