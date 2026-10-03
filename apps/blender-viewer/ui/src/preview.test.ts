import { describe, expect, it } from "vitest";
import { fetchGlb, partNodeMap } from "./preview";
import type { BlenderPart } from "./rpc";

const part = (name: string, parent: string | null): BlenderPart => ({
  name,
  kind: "mesh",
  parent,
  visible: true,
  mesh: name,
  materials: [],
  verts: 0,
  polys: 0,
  tris: 0,
  dimensions: [],
});

describe("partNodeMap", () => {
  it("names a part by its parent chain, the way the 3D view does", () => {
    const map = partNodeMap([part("Bed", null), part("Frame", "Bed"), part("Leg", "Frame")]);
    expect(map).toEqual({ Bed: "Bed", "Bed/Frame": "Frame", "Bed/Frame/Leg": "Leg" });
  });

  it("stops at a parent that is not in the list, and at a cycle", () => {
    const map = partNodeMap([part("A", "Missing"), part("B", "C"), part("C", "B")]);
    expect(map.A).toBe("A");
    expect(Object.values(map).sort()).toEqual(["A", "B", "C"]);
  });
});

describe("fetchGlb", () => {
  it("decodes the bytes", async () => {
    const out = await fetchGlb(() => Promise.resolve({ base64: "QUJD" }));
    expect(out.kind).toBe("ready");
    if (out.kind === "ready") expect(new Uint8Array(out.glb)).toEqual(new Uint8Array([65, 66, 67]));
  });

  it("says why when the backend cannot read it", async () => {
    const out = await fetchGlb(() => Promise.reject(new Error("this export has no .glb")));
    expect(out).toEqual({ kind: "failed", message: "this export has no .glb" });
  });
});
