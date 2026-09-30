// @vitest-environment jsdom
/**
 * The Blender Viewer's send actions live in the shared footer and call the same
 * `context/put` as before: the parts list as text, the model as a file.
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
  blender: {
    found: true,
    path: "C:/b/blender.exe",
    source: "path",
    version: "4.2",
    major: 4,
    supported: true,
    configuredMissing: false,
  },
  project: true,
  readOnly: false,
  blends: [{ path: "C:/p/bed.blend", rel: "bed.blend", mtime: 1, size: 1 }],
  blend: "C:/p/bed.blend",
  rel: "bed.blend",
  model: "C:/p/.kaava/bed.glb",
  parts: [
    {
      name: "Frame",
      kind: "mesh",
      parent: null,
      visible: true,
      mesh: "Frame",
      materials: [],
      verts: 8,
      polys: 6,
      tris: 12,
      dimensions: [1, 1, 1],
    },
  ],
  renders: [],
  job: {
    running: false,
    blend: null,
    startedAt: null,
    finishedAt: null,
    step: 0,
    total: 0,
    label: "",
    log: [],
    outcome: null,
    error: null,
    warnings: [],
  },
};

function backend(put: () => unknown = () => ({ key: "k" })) {
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "blender-viewer/state") return Promise.resolve(STATE);
    if (method === "comments/list") return Promise.resolve([]);
    if (method === "context/put") return Promise.resolve(put());
    return Promise.resolve(null);
  });
}

const puts = () => bridge.invoke.mock.calls.filter((c) => c[0] === "context/put");

beforeEach(() => {
  bridge.invoke.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Blender Viewer send footer", () => {
  it("sends the parts list from the footer", async () => {
    backend();
    const { container } = render(<App />);
    const button = await screen.findByRole("button", { name: "Send parts" });
    expect(container.querySelector(".k-send-footer")?.contains(button)).toBe(true);
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Sent" });
    expect(puts()[0][1]).toMatchObject({ kind: "text", label: "Blender - parts list" });
  });

  it("sends the .glb as a file, next to Send parts", async () => {
    backend();
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Send parts" });
    const glb = await screen.findByRole("button", { name: "Send .glb" });
    const group = container.querySelector(".k-send-footer__actions");
    expect(group?.contains(glb)).toBe(true);
    fireEvent.click(glb);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]).toMatchObject({ kind: "file", path: "C:/p/.kaava/bed.glb" });
  });

  it("keeps Export and Open in Blender in the footer, after the sends", async () => {
    backend();
    const { container } = render(<App />);
    const open = await screen.findByRole("button", { name: /Open in Blender/ });
    expect(container.querySelector(".k-send-footer__trailing")?.contains(open)).toBe(true);
  });

  it("names what failed to send", async () => {
    backend(() => {
      throw new Error("no store");
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Send parts" }));
    await screen.findByText(/Couldn't send parts to the agent/);
  });
});
