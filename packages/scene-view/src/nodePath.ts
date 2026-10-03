/**
 * Node paths: the stable, human-readable address of an object in the scene.
 *
 * `"Main/Chair/Leg3"` is what a pin records and what `onSelect` reports, so an
 * agent reading the markup can find the same node in the Godot scene tree or
 * the Blender outliner. The path is built from glTF node names, top-level node
 * first, and never includes the scene root itself: `GLTFLoader` names that
 * group after the glTF scene, which no exporter agrees on.
 *
 * Two loader artefacts are undone here. `GLTFLoader` turns a mesh with several
 * primitives into a Group with one same-named Mesh per primitive, which would
 * read `Chair/Chair`; the duplicate segment is dropped. And it sanitises names
 * (spaces become `_`, dots and brackets vanish), so a path is the name as the
 * loader saw it, not as the DCC tool typed it. Unnamed nodes fall back to
 * `node<sibling index>` so a path always exists.
 */
import type { Object3D } from "three";

const SEPARATOR = "/";

function segmentFor(obj: Object3D, parent: Object3D): string {
  if (obj.name) return obj.name;
  return `node${parent.children.indexOf(obj)}`;
}

/** True for the loader's per-primitive child of a multi-primitive mesh. */
function isPrimitiveShell(obj: Object3D, parent: Object3D, root: Object3D): boolean {
  return (
    parent !== root &&
    obj.name !== "" &&
    obj.name === parent.name &&
    (obj as { isMesh?: boolean }).isMesh === true &&
    (parent as { isMesh?: boolean }).isMesh !== true
  );
}

/** The path of `obj` below `root`, or `null` for `root` itself or a stranger. */
export function nodePath(obj: Object3D, root: Object3D): string | null {
  const segments: string[] = [];
  let cursor: Object3D | null = obj;
  while (cursor && cursor !== root) {
    const parent: Object3D | null = cursor.parent;
    if (!parent) return null;
    if (!isPrimitiveShell(cursor, parent, root)) segments.push(segmentFor(cursor, parent));
    cursor = parent;
  }
  if (cursor !== root || segments.length === 0) return null;
  return segments.reverse().join(SEPARATOR);
}

/**
 * The object at `path`, or `null`. The inverse of {@link nodePath}: at each
 * level it matches by name, so `find(nodePath(x)) === x` for every node that
 * is not a primitive shell. A shell resolves to its enclosing Group, which is
 * the object {@link selectableFor} returns for it.
 */
export function findByPath(root: Object3D, path: string): Object3D | null {
  if (path === "") return null;
  let current: Object3D = root;
  for (const segment of path.split(SEPARATOR)) {
    const next: Object3D | undefined = current.children.find(
      (child, index) => (child.name || `node${index}`) === segment,
    );
    if (!next) return null;
    current = next;
  }
  return current;
}

/**
 * The node a click on `hit` should select. A ray lands on a leaf mesh; when
 * that mesh is one primitive of a multi-primitive node, the selection is the
 * enclosing Group, so the whole Chair highlights and not one of its parts.
 */
export function selectableFor(hit: Object3D, root: Object3D): Object3D {
  const parent = hit.parent;
  if (parent && isPrimitiveShell(hit, parent, root)) return parent;
  return hit;
}
