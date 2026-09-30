import { describe, expect, it } from "vitest";
import {
  BoxGeometry,
  BufferGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
} from "three";
import {
  capNotice,
  checkTriangleCap,
  countTriangles,
  DEFAULT_MAX_TRIANGLES,
  hasPunctualLights,
} from "./limits";

const material = new MeshBasicMaterial();

describe("countTriangles", () => {
  it("counts indexed geometry by index", () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), material)); // 12 triangles
    expect(countTriangles(root)).toBe(12);
  });

  it("counts non-indexed geometry by vertex", () => {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(new Array(27 * 3).fill(0), 3));
    const root = new Group();
    root.add(new Mesh(geo, material));
    expect(countTriangles(root)).toBe(9);
  });

  it("multiplies an instanced mesh by its instance count", () => {
    const root = new Group();
    root.add(new InstancedMesh(new BoxGeometry(), material, 5));
    expect(countTriangles(root)).toBe(60);
  });

  it("adds nested meshes and ignores non-meshes", () => {
    const root = new Group();
    const inner = new Group();
    inner.add(new Mesh(new BoxGeometry(), material), new Mesh(new BoxGeometry(), material));
    root.add(inner, new DirectionalLight());
    expect(countTriangles(root)).toBe(24);
  });
});

describe("checkTriangleCap", () => {
  it("passes a scene at exactly the limit and fails one over", () => {
    expect(checkTriangleCap(100, 100).exceeded).toBe(false);
    expect(checkTriangleCap(101, 100).exceeded).toBe(true);
  });

  it("disables the check for a non-positive limit", () => {
    expect(checkTriangleCap(1e9, 0).exceeded).toBe(false);
  });

  it("defaults to two million", () => {
    expect(DEFAULT_MAX_TRIANGLES).toBe(2_000_000);
  });

  it("words the notice with both numbers", () => {
    const text = capNotice(checkTriangleCap(3_500_000, 2_000_000));
    expect(text).toContain("3,500,000");
    expect(text).toContain("2,000,000");
  });
});

describe("hasPunctualLights", () => {
  it("finds a light anywhere in the tree", () => {
    const root = new Group();
    const inner = new Group();
    inner.add(new DirectionalLight());
    root.add(inner);
    expect(hasPunctualLights(root)).toBe(true);
    expect(hasPunctualLights(new Group())).toBe(false);
  });
});
