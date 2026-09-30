import { describe, expect, it, vi } from "vitest";
import { pose } from "./fixtures";
import { buildPalette, toHex } from "./palette";
import { sceneHost } from "./sceneHost";
import type { SceneViewHandle } from "./types";

function handle(): SceneViewHandle {
  return {
    getCamera: vi.fn(() => pose(1)),
    setCamera: vi.fn(),
    setInteractive: vi.fn(),
    pick: vi.fn(() => ({
      nodePath: "Root/Cube",
      worldPoint: [1, 2, 3] as [number, number, number],
    })),
    project: vi.fn(() => ({ x: 5, y: 6, visible: true })),
    capture: vi.fn(async () => new Blob(["frame"])),
    viewportSize: vi.fn(() => ({ width: 300, height: 200 })),
    onCameraChange: vi.fn(() => () => {}),
  };
}

describe("sceneHost", () => {
  it("passes pick, project, size and the camera calls through", () => {
    const h = handle();
    const host = sceneHost(h, { glb: "a.glb", pixelRatio: 2 });
    expect(host.pick?.(10, 20)).toEqual({ nodePath: "Root/Cube", worldPoint: [1, 2, 3] });
    expect(h.pick).toHaveBeenCalledWith(10, 20);
    expect(host.project?.([0, 0, 0])).toEqual({ x: 5, y: 6, visible: true });
    expect(host.size()).toEqual({ width: 300, height: 200 });
    host.setInteractive?.(false);
    expect(h.setInteractive).toHaveBeenCalledWith(false);
    host.setCamera?.(pose(2), { animate: true });
    expect(h.setCamera).toHaveBeenCalledWith(pose(2), { animate: true });
    expect(host.getCamera?.()).toEqual(pose(1));
  });

  it("captures at the requested pixel ratio", async () => {
    const h = handle();
    await sceneHost(h, { pixelRatio: 2 }).capture();
    expect(h.capture).toHaveBeenCalledWith({ scale: 2 });
  });

  it("describes the scene, the model and the camera for an agent", () => {
    const host = sceneHost(handle(), { glb: "assets/a.glb", extra: { engine: "godot" } });
    expect(host.describe()).toEqual({
      kind: "scene",
      glb: "assets/a.glb",
      engine: "godot",
      camera: pose(1),
    });
  });
});

describe("palette", () => {
  it("normalises the colour forms a browser reports", () => {
    expect(toHex("#abc")).toBe("#aabbcc");
    expect(toHex("#3F76FF")).toBe("#3f76ff");
    expect(toHex("rgb(63, 118, 255)")).toBe("#3f76ff");
    expect(toHex("rgba(63 118 255 / 0.5)")).toBe("#3f76ff");
    expect(toHex("color(srgb 1 0 0)")).toBe("#ff0000");
    expect(toHex("banana")).toBeNull();
  });

  it("reads swatches from tokens and falls back where a token is missing", () => {
    const tokens: Record<string, string> = { "--danger": "rgb(1, 2, 3)", "--accent": "#112233" };
    const p = buildPalette((t) => tokens[t]);
    expect(p.swatches[0]).toMatchObject({ id: "danger", color: "#010203" });
    expect(p.ink).toBe("#010203");
    expect(p.pinFill).toBe("#112233");
    expect(p.swatches.every((s) => /^#[0-9a-f]{6}$/.test(s.color))).toBe(true);
  });
});
