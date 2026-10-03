/**
 * Camera poses as plain data, and the framing maths that produces them.
 *
 * A pose is what leaves this package (`markupHost.ts` defines the type): it goes
 * to the markup layer, comes back as `initialPose`, and can be persisted by a
 * host. It is deliberately not a `PerspectiveCamera`, so this file can be tested
 * without a renderer. Orbit controls keep their own `target`, which is why a
 * pose carries one; position and orientation alone cannot restore an orbit.
 */
import { Box3, PerspectiveCamera, Quaternion, Vector3 } from "three";
import type { CameraPose, Vec3 } from "./markupHost";

export interface Framing {
  position: Vec3;
  target: Vec3;
  near: number;
  far: number;
}

/** Looking at the scene from front-right-above: reads as 3D at a glance. */
const DEFAULT_DIRECTION = new Vector3(1, 0.7, 1).normalize();

/** Air around the subject, as a multiple of the tight fit. */
const FRAMING_MARGIN = 1.25;

/**
 * Where to put a camera so `box` fills the view, seen from `direction`.
 *
 * Fits the bounding sphere, not the box, so a rotation of the orbit never
 * clips a corner. That leaves more air around a flat scene than a tight fit
 * would; the sphere is the price of a framing that stays right as the user
 * orbits. An empty box frames a unit cube at the origin rather than throwing,
 * since a scene with no geometry is a legal glTF.
 *
 * `aspect` matters: a portrait viewport is limited by its horizontal field of
 * view, which is narrower than `fov`.
 */
export function frameBounds(
  box: Box3,
  fov: number,
  aspect: number,
  direction: Vector3 = DEFAULT_DIRECTION,
): Framing {
  const center = new Vector3();
  let radius = 0.5;
  if (!box.isEmpty()) {
    box.getCenter(center);
    radius = Math.max(box.getSize(new Vector3()).length() / 2, 1e-6);
  }
  const vFov = (fov * Math.PI) / 180;
  const safeAspect = aspect > 0 ? aspect : 1;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * safeAspect);
  const limiting = Math.min(vFov, hFov);
  const distance = (radius / Math.sin(limiting / 2)) * FRAMING_MARGIN;
  const dir = direction.clone().normalize();
  const position = center.clone().addScaledVector(dir, distance);
  return {
    position: toVec3(position),
    target: toVec3(center),
    near: Math.max(distance / 1000, 1e-4),
    far: distance + radius * 20,
  };
}

/** The pose a framing implies, with world-up and the given field of view. */
export function poseFromFraming(framing: Framing, fov: number): CameraPose {
  return { position: framing.position, target: framing.target, fov, up: [0, 1, 0] };
}

/**
 * Reads a pose off a camera and its orbit target.
 * A glTF camera looks down its own -Z, so a caller that has no orbit target yet
 * passes `null` and gets one a short way in front of the camera.
 */
export function poseFromCamera(camera: PerspectiveCamera, target: Vector3 | null): CameraPose {
  const position = camera.getWorldPosition(new Vector3());
  let look = target;
  if (!look) {
    const forward = new Vector3(0, 0, -1).applyQuaternion(
      camera.getWorldQuaternion(new Quaternion()),
    );
    look = position.clone().addScaledVector(forward, 5);
  }
  return {
    position: toVec3(position),
    target: toVec3(look),
    fov: camera.fov,
    up: toVec3(camera.up),
  };
}

const EPSILON = 1e-4;

/**
 * Whether two poses are the same view. Tolerance is relative to the
 * camera-to-target distance, so it means the same thing on a chess piece and
 * on a city block.
 */
export function posesClose(a: CameraPose, b: CameraPose): boolean {
  const scale = Math.max(distance(a.position, a.target), 1e-3);
  const tol = scale * EPSILON;
  return (
    distance(a.position, b.position) <= tol &&
    distance(a.target, b.target) <= tol &&
    Math.abs(a.fov - b.fov) <= 1e-3
  );
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function toVec3(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}
