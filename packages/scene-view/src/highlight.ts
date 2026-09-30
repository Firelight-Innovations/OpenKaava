/**
 * Selection highlight by material swap.
 *
 * glTF materials are shared between meshes, so tinting a material in place
 * would light up every object that uses it. Instead each mesh under the
 * selection gets a private clone, tinted, and the original goes in a map to be
 * put back on deselect. An outline pass was the alternative: it looks better
 * and costs a second render target plus post-processing code and bundle, for a
 * preview whose job is "which thing did I click".
 *
 * No GL is touched here, only materials, so it runs under vitest. The clones
 * are the only objects this class disposes; the originals stay the scene's.
 */
import { Color } from "three";
import type { Material, Mesh, Object3D } from "three";

interface Tintable extends Material {
  emissive?: Color;
  emissiveIntensity?: number;
  color?: Color;
}

const TINT_INTENSITY = 0.55;
const BASIC_MIX = 0.5;

export class SelectionHighlight {
  private originals = new Map<Mesh, Material | Material[]>();
  private clones: Material[] = [];

  /** `tint` is a resolved CSS colour string; three parses it. */
  apply(root: Object3D, tint: string) {
    this.clear();
    root.traverse((obj) => {
      const mesh = obj as Mesh;
      if ((mesh as { isMesh?: boolean }).isMesh !== true || !mesh.material) return;
      this.originals.set(mesh, mesh.material);
      const swap = (m: Material) => {
        const clone = m.clone() as Tintable;
        this.tintOne(clone, tint);
        this.clones.push(clone);
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
  }

  /** Puts every original material back and frees the clones. Safe to call twice. */
  clear() {
    for (const [mesh, original] of this.originals) mesh.material = original;
    this.originals.clear();
    for (const clone of this.clones) clone.dispose();
    this.clones = [];
  }

  isActive(): boolean {
    return this.originals.size > 0;
  }

  private tintOne(material: Tintable, tint: string) {
    if (material.emissive) {
      material.emissive.set(tint);
      material.emissiveIntensity = TINT_INTENSITY;
    } else if (material.color) {
      material.color.lerp(new Color(tint), BASIC_MIX);
    }
  }
}
