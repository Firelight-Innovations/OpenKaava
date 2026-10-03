import { describe, expect, it } from "vitest";
import { Box3, PerspectiveCamera, Vector3 } from "three";
import { frameBounds, posesClose, poseFromCamera } from "./pose";
import type { CameraPose } from "./markupHost";

const unitBox = () => new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));

function project(
  point: Vector3,
  position: number[],
  target: number[],
  fov: number,
  aspect: number,
) {
  const cam = new PerspectiveCamera(fov, aspect, 0.01, 1000);
  cam.position.set(position[0], position[1], position[2]);
  cam.lookAt(target[0], target[1], target[2]);
  cam.updateMatrixWorld();
  return point.clone().project(cam);
}

describe("frameBounds", () => {
  it("aims at the box centre", () => {
    const box = new Box3(new Vector3(4, 0, 0), new Vector3(6, 2, 2));
    const framing = frameBounds(box, 50, 1);
    expect(framing.target).toEqual([5, 1, 1]);
  });

  it("keeps the whole bounding sphere inside the frustum", () => {
    const framing = frameBounds(unitBox(), 50, 1);
    // A corner of the box is the farthest point on the sphere the framing fits.
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const p = project(new Vector3(sx, sy, sz), framing.position, framing.target, 50, 1);
          expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
        }
  });

  it("backs off further for a portrait viewport, where the horizontal fov limits", () => {
    const wide = frameBounds(unitBox(), 50, 2);
    const tall = frameBounds(unitBox(), 50, 0.5);
    const dist = (f: { position: number[]; target: number[] }) =>
      Math.hypot(...f.position.map((v, i) => v - f.target[i]));
    expect(dist(tall)).toBeGreaterThan(dist(wide));
  });

  it("looks from the requested direction", () => {
    const framing = frameBounds(unitBox(), 50, 1, new Vector3(0, 0, 1));
    expect(framing.position[0]).toBeCloseTo(0);
    expect(framing.position[1]).toBeCloseTo(0);
    expect(framing.position[2]).toBeGreaterThan(1);
  });

  it("frames an empty box rather than throwing", () => {
    const framing = frameBounds(new Box3(), 50, 1);
    expect(framing.target).toEqual([0, 0, 0]);
    expect(Number.isFinite(framing.position[0])).toBe(true);
    expect(framing.far).toBeGreaterThan(framing.near);
  });

  it("treats a non-positive aspect as square", () => {
    expect(frameBounds(unitBox(), 50, 0).position).toEqual(frameBounds(unitBox(), 50, 1).position);
  });
});

describe("poseFromCamera", () => {
  it("uses the supplied orbit target", () => {
    const cam = new PerspectiveCamera(40);
    cam.position.set(0, 0, 10);
    const pose = poseFromCamera(cam, new Vector3(0, 0, 2));
    expect(pose.target).toEqual([0, 0, 2]);
    expect(pose.fov).toBe(40);
  });

  it("derives a target ahead of a camera that has none, along its -Z", () => {
    const cam = new PerspectiveCamera(40);
    cam.position.set(1, 2, 3);
    cam.updateMatrixWorld();
    const pose = poseFromCamera(cam, null);
    expect(pose.target[0]).toBeCloseTo(1);
    expect(pose.target[2]).toBeCloseTo(-2);
  });
});

describe("posesClose", () => {
  const base: CameraPose = { position: [0, 0, 10], target: [0, 0, 0], fov: 50, up: [0, 1, 0] };

  it("accepts an identical pose and a negligible drift", () => {
    expect(posesClose(base, { ...base })).toBe(true);
    expect(posesClose(base, { ...base, position: [0, 0, 10.0001] })).toBe(true);
  });

  it("rejects a moved camera, target or fov", () => {
    expect(posesClose(base, { ...base, position: [0.5, 0, 10] })).toBe(false);
    expect(posesClose(base, { ...base, target: [0, 0.5, 0] })).toBe(false);
    expect(posesClose(base, { ...base, fov: 60 })).toBe(false);
  });
});
