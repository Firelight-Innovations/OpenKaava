import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@openkaava/bridge", () => ({ invoke }));

import { partsText, putGlb, putParts, putRender } from "./context";
import type { BlenderViewerState } from "./rpc";

const state = {
  rel: "art/crate.blend",
  model: "C:/p/.kaava/blender/crate/model.glb",
  parts: [
    {
      name: "Crate",
      kind: "mesh",
      parent: null,
      visible: true,
      mesh: "Crate",
      materials: ["Wood"],
      verts: 8,
      polys: 6,
      tris: 12,
      dimensions: [1, 1, 1],
    },
    { name: "Rig", kind: "armature", parent: null, visible: true },
  ],
} as unknown as BlenderViewerState;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ id: "ctx-1" });
});

describe("partsText", () => {
  it("lists meshes with counts and other kinds by kind", () => {
    const text = partsText(state).split("\n");
    expect(text[0]).toBe("Blender scene art/crate.blend (2 objects)");
    expect(text[1]).toBe("Crate | mesh | 12 tris | 8 verts | Wood | 1.00 x 1.00 x 1.00 m");
    expect(text[2]).toBe("Rig | armature");
  });
});

describe("context puts", () => {
  it("sends a render as an image with its bytes", async () => {
    await putRender("AAAA", "wire", "art/crate.blend");
    expect(invoke).toHaveBeenCalledWith(
      "context/put",
      expect.objectContaining({ kind: "image", bytesBase64: "AAAA" }),
    );
  });

  it("sends the parts list as text", async () => {
    await putParts(state);
    const [method, params] = invoke.mock.calls[0] as [string, { kind: string; text: string }];
    expect(method).toBe("context/put");
    expect(params.kind).toBe("text");
    expect(params.text).toContain("Crate");
  });

  it("sends the glb by path, never its bytes", async () => {
    await putGlb(state);
    const [, params] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.kind).toBe("file");
    expect(params.path).toBe(state.model);
    expect(params.bytesBase64).toBeUndefined();
  });
});
