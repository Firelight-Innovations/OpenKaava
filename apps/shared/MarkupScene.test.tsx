// @vitest-environment jsdom
/**
 * The shared 3D stage, as the Blender Viewer uses it: marking up locks the
 * camera, the markup JSON is told which .blend it came from, and an out-of-date
 * export cannot be marked up. three.js needs WebGL, so SceneView and the layer
 * are stand-ins.
 */
import { forwardRef, useImperativeHandle, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  setInteractive: vi.fn(),
  exported: vi.fn(),
  sceneHost: vi.fn(() => ({})),
}));

const HANDLE = vi.hoisted(() => ({
  getCamera: () => ({ position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 50 }),
  setInteractive: (v: boolean) => h.setInteractive(v),
}));

vi.mock("@kaava/scene-view", () => ({
  SceneView: forwardRef(function Fake({ children }: { children?: ReactNode }, ref) {
    useImperativeHandle(ref, () => HANDLE, []);
    return <div>{children}</div>;
  }),
}));

vi.mock("@kaava/markup", () => ({
  sceneHost: h.sceneHost,
  poseMatches: () => true,
}));

vi.mock("@kaava/markup/layer", () => ({
  MarkupLayer: ({
    active,
    onActiveChange,
    onController,
  }: {
    active: boolean;
    onActiveChange: (next: boolean) => void;
    onController: (c: unknown) => void;
  }) => {
    onController({ exportMarkup: h.exported });
    return active ? (
      <button type="button" onClick={() => onActiveChange(false)}>
        Done
      </button>
    ) : null;
  },
}));

import MarkupScene, { type MarkupSceneProps } from "./MarkupScene";

function mount(over: Partial<MarkupSceneProps> = {}) {
  const props: MarkupSceneProps = {
    glb: new ArrayBuffer(0),
    glbPath: "C:/p/.kaava/blender/bed/model.glb",
    extra: { engine: "blender", blend: "bed.blend" },
    selectedPath: null,
    onSelect: vi.fn(),
    onMarkup: vi.fn(),
    onNotice: vi.fn(),
    ...over,
  };
  render(<MarkupScene {...props} />);
  return props;
}

beforeEach(() => {
  h.setInteractive.mockReset();
  h.exported.mockReset();
  h.sceneHost.mockClear();
});
afterEach(cleanup);

describe("MarkupScene", () => {
  it("locks the camera while marking and returns the drawing on Done", async () => {
    h.exported.mockResolvedValue({
      png: new Blob(),
      json: { pins: [{ n: 1, note: "x" }], annotations: [] },
    });
    const props = mount();
    await waitFor(() => expect(h.setInteractive).toHaveBeenLastCalledWith(true));
    fireEvent.click(await screen.findByRole("button", { name: /Mark up/ }));
    await waitFor(() => expect(h.setInteractive).toHaveBeenLastCalledWith(false));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(props.onMarkup).toHaveBeenCalledTimes(1));
    expect(h.setInteractive).toHaveBeenLastCalledWith(true);
  });

  it("tells the markup which glb and .blend it was drawn from", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Mark up/ }));
    await waitFor(() => expect(h.sceneHost).toHaveBeenCalled());
    expect(h.sceneHost).toHaveBeenLastCalledWith(HANDLE, {
      glb: ".kaava/blender/bed/model.glb",
      extra: { engine: "blender", blend: "bed.blend" },
    });
  });

  it("will not start marking up an out-of-date model, and says why", async () => {
    mount({ markupDisabled: "Re-export to mark it up." });
    const button = (await screen.findByRole("button", { name: /Mark up/ })) as HTMLButtonElement;
    await waitFor(() => expect(h.setInteractive).toHaveBeenCalled());
    expect(button.disabled).toBe(true);
    expect(screen.getAllByText("Re-export to mark it up.").length).toBeGreaterThan(0);
  });
});
