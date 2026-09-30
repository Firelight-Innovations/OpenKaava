import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from "three";
import { findByPath, nodePath, selectableFor } from "./nodePath";

function named<T extends Object3D>(obj: T, name: string): T {
  obj.name = name;
  return obj;
}

function tree() {
  const scene = named(new Group(), "Scene");
  const main = named(new Group(), "Main");
  const chair = named(new Group(), "Chair");
  const leg = named(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), "Leg3");
  chair.add(leg);
  main.add(chair);
  scene.add(main);
  return { scene, main, chair, leg };
}

describe("nodePath", () => {
  it("joins names from the top-level node down, excluding the scene root", () => {
    const { scene, leg, main } = tree();
    expect(nodePath(leg, scene)).toBe("Main/Chair/Leg3");
    expect(nodePath(main, scene)).toBe("Main");
  });

  it("returns null for the root itself and for an object outside the tree", () => {
    const { scene } = tree();
    expect(nodePath(scene, scene)).toBeNull();
    expect(nodePath(new Object3D(), scene)).toBeNull();
  });

  it("falls back to the sibling index for unnamed nodes", () => {
    const scene = new Group();
    const a = new Object3D();
    const b = new Object3D();
    scene.add(a, b);
    expect(nodePath(b, scene)).toBe("node1");
  });

  it("collapses the loader's per-primitive shells into their group", () => {
    const scene = new Group();
    const chair = named(new Group(), "Chair");
    const prim = named(new Mesh(), "Chair");
    chair.add(prim);
    scene.add(chair);
    expect(nodePath(prim, scene)).toBe("Chair");
    expect(selectableFor(prim, scene)).toBe(chair);
  });

  it("does not collapse a mesh child with the same name under a mesh", () => {
    const scene = new Group();
    const parent = named(new Mesh(), "Part");
    const child = named(new Mesh(), "Part");
    parent.add(child);
    scene.add(parent);
    expect(nodePath(child, scene)).toBe("Part/Part");
  });
});

describe("findByPath", () => {
  it("is the inverse of nodePath", () => {
    const { scene, leg, chair } = tree();
    expect(findByPath(scene, "Main/Chair/Leg3")).toBe(leg);
    expect(findByPath(scene, nodePath(chair, scene) as string)).toBe(chair);
  });

  it("returns null for a missing or empty path", () => {
    const { scene } = tree();
    expect(findByPath(scene, "Main/Table")).toBeNull();
    expect(findByPath(scene, "")).toBeNull();
  });

  it("finds unnamed nodes by their fallback segment", () => {
    const scene = new Group();
    scene.add(new Object3D(), new Object3D());
    expect(findByPath(scene, "node1")).toBe(scene.children[1]);
  });
});
