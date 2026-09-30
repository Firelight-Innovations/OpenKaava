import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from "three";
import { SelectionHighlight } from "./highlight";

describe("SelectionHighlight", () => {
  it("tints a private clone and leaves the shared original untouched", () => {
    const shared = new MeshStandardMaterial({ color: 0x808080 });
    const a = new Mesh(new BoxGeometry(), shared);
    const b = new Mesh(new BoxGeometry(), shared);
    const root = new Group();
    root.add(a, b);

    const h = new SelectionHighlight();
    h.apply(a, "#ff0000");

    expect(a.material).not.toBe(shared);
    expect((a.material as MeshStandardMaterial).emissive.r).toBeGreaterThan(0);
    expect(b.material).toBe(shared);
    expect(shared.emissive.r).toBe(0);
  });

  it("restores the original materials on clear, including arrays", () => {
    const m1 = new MeshStandardMaterial();
    const m2 = new MeshStandardMaterial();
    const mesh = new Mesh(new BoxGeometry(), [m1, m2]);
    const h = new SelectionHighlight();
    h.apply(mesh, "#00ff00");
    expect(mesh.material).not.toEqual([m1, m2]);
    h.clear();
    expect(mesh.material).toEqual([m1, m2]);
    expect(h.isActive()).toBe(false);
  });

  it("re-applying replaces the previous selection", () => {
    const a = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const b = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const originalA = a.material;
    const h = new SelectionHighlight();
    h.apply(a, "#ff0000");
    h.apply(b, "#ff0000");
    expect(a.material).toBe(originalA);
  });

  it("tints materials that have no emissive by mixing the colour", () => {
    const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: 0x000000 }));
    new SelectionHighlight().apply(mesh, "#ff0000");
    expect((mesh.material as MeshBasicMaterial).color.r).toBeGreaterThan(0);
  });

  it("clear is safe to call twice", () => {
    const h = new SelectionHighlight();
    h.clear();
    h.clear();
    expect(h.isActive()).toBe(false);
  });
});
