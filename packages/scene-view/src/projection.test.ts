import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera } from "three";
import { pickNode, projectPoint, viewportToNdc } from "./projection";

const W = 800;
const H = 600;

/** A camera at +Z looking at the origin, and a scene of two named boxes. */
function fixture() {
  const camera = new PerspectiveCamera(50, W / H, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const root = new Group();
  const main = new Group();
  main.name = "Main";
  const chair = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
  chair.name = "Chair";
  const table = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
  table.name = "Table";
  table.position.set(4, 0, 0);
  main.add(chair, table);
  root.add(main);
  root.updateMatrixWorld(true);
  return { camera, root };
}

describe("viewportToNdc", () => {
  it("maps the corners and centre, with y flipped", () => {
    expect(viewportToNdc(0, 0, W, H).toArray()).toEqual([-1, 1]);
    expect(viewportToNdc(W, H, W, H).toArray()).toEqual([1, -1]);
    const centre = viewportToNdc(W / 2, H / 2, W, H);
    expect(centre.x).toBeCloseTo(0);
    expect(centre.y).toBeCloseTo(0);
  });
});

describe("projectPoint", () => {
  it("puts the look-at point at the viewport centre", () => {
    const { camera } = fixture();
    const p = projectPoint(camera, [0, 0, 0], W, H);
    expect(p.x).toBeCloseTo(W / 2);
    expect(p.y).toBeCloseTo(H / 2);
    expect(p.visible).toBe(true);
  });

  it("is not visible behind the camera or outside the frustum", () => {
    const { camera } = fixture();
    expect(projectPoint(camera, [0, 0, 20], W, H).visible).toBe(false);
    expect(projectPoint(camera, [500, 0, 0], W, H).visible).toBe(false);
  });

  it("moves a point when the camera moves, which is what lets a pin follow", () => {
    const { camera } = fixture();
    const before = projectPoint(camera, [1, 0, 0], W, H);
    camera.position.set(2, 0, 10);
    camera.lookAt(2, 0, 0);
    camera.updateMatrixWorld();
    const after = projectPoint(camera, [1, 0, 0], W, H);
    expect(after.x).toBeLessThan(before.x);
  });
});

describe("pickNode", () => {
  it("returns the node path and a point on the surface", () => {
    const { camera, root } = fixture();
    const hit = pickNode(root, camera, W / 2, H / 2, W, H);
    expect(hit?.nodePath).toBe("Main/Chair");
    expect(hit?.worldPoint[2]).toBeCloseTo(1); // the box's near face
  });

  it("picks the other node where it is", () => {
    const { camera, root } = fixture();
    const p = projectPoint(camera, [4, 0, 1], W, H);
    expect(pickNode(root, camera, p.x, p.y, W, H)?.nodePath).toBe("Main/Table");
  });

  it("returns null over empty space and for a zero-sized viewport", () => {
    const { camera, root } = fixture();
    expect(pickNode(root, camera, 5, 5, W, H)).toBeNull();
    expect(pickNode(root, camera, 0, 0, 0, 0)).toBeNull();
  });

  it("skips hidden objects", () => {
    const { camera, root } = fixture();
    root.getObjectByName("Chair")!.visible = false;
    expect(pickNode(root, camera, W / 2, H / 2, W, H)).toBeNull();
  });

  it("round-trips: projecting the picked point lands on the pixel that was picked", () => {
    const { camera, root } = fixture();
    for (const [x, y] of [
      [W / 2, H / 2],
      [W / 2 + 30, H / 2 - 20],
      [W / 2 - 15, H / 2 + 40],
    ]) {
      const hit = pickNode(root, camera, x, y, W, H);
      expect(hit).not.toBeNull();
      const back = projectPoint(camera, hit!.worldPoint, W, H);
      expect(back.x).toBeCloseTo(x, 3);
      expect(back.y).toBeCloseTo(y, 3);
    }
  });

  it("round-trips after the camera has orbited", () => {
    const { camera, root } = fixture();
    camera.position.set(6, 4, 8);
    camera.lookAt(1, 0, 0);
    camera.updateMatrixWorld();
    const hit = pickNode(root, camera, W / 2, H / 2, W, H);
    expect(hit).not.toBeNull();
    const back = projectPoint(camera, hit!.worldPoint, W, H);
    expect(back.x).toBeCloseTo(W / 2, 3);
    expect(back.y).toBeCloseTo(H / 2, 3);
  });
});
