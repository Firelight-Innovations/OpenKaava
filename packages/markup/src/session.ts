/**
 * The session model: what ink belongs to which camera, and what is on screen
 * for the camera as it is now. Pure data in, pure data out; the React layer
 * only calls these and hands the result to Excalidraw.
 *
 * - Entering markup mode records the camera. Ink drawn while it is on belongs
 *   to that pose.
 * - Move the camera away and the ink hides, because a stroke drawn over one
 *   view is meaningless over another. Pins do not hide: each knows the world
 *   point it was placed on and follows it through `project`.
 * - Several sessions can coexist, one per pose.
 */
import { isPinPart, movePinTo } from "./pins";
import { kaavaData, live } from "./elements";
import type { CameraPose, MarkupElement, MarkupHost, Vec3 } from "./types";

const POSE_EPSILON = 1e-3;

function vecEqual(a: Vec3, b: Vec3, eps: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps
  );
}

/** Two poses are "the same view" when every component agrees within `eps`. */
export function poseMatches(a: CameraPose, b: CameraPose, eps = POSE_EPSILON): boolean {
  return (
    vecEqual(a.position, b.position, eps) &&
    vecEqual(a.target, b.target, eps) &&
    vecEqual(a.up, b.up, eps) &&
    Math.abs(a.fov - b.fov) <= eps
  );
}

export interface MarkupSession {
  id: string;
  /** Null on hosts without a camera: the ink is then always in view. */
  pose: CameraPose | null;
  /** Ink and pins drawn in this session, in Excalidraw's element shape. */
  elements: MarkupElement[];
}

/** True when the session holds anything but pins. */
export function hasInk(session: MarkupSession): boolean {
  return live(session.elements).some((el) => !isPinPart(el));
}

/** Whether a session's ink is in view for `current`. Poseless sessions always are. */
export function inView(session: MarkupSession, current: CameraPose | null): boolean {
  if (!session.pose || !current) return true;
  return poseMatches(session.pose, current);
}

export interface ComposedScene {
  /** What Excalidraw should show. Elements of `lockedIds` cannot be edited. */
  elements: MarkupElement[];
  /** Ids belonging to sessions other than the active one. */
  lockedIds: Set<string>;
  /** The session to offer a "Return" chip for: ink exists, but is out of view. */
  returnTo: MarkupSession | null;
}

/**
 * The scene for `current`.
 *
 * A session in view contributes everything. A session out of view contributes
 * only its pins, moved to where `project` says their world point is now; a pin
 * with no world point, or one `project` reports as not visible, is left out
 * (it has no honest position). Sessions other than `activeId` come back
 * locked, so the eraser and selection cannot touch what the user is not
 * editing.
 */
export function composeScene(
  sessions: readonly MarkupSession[],
  activeId: string | null,
  current: CameraPose | null,
  project?: MarkupHost["project"],
): ComposedScene {
  const elements: MarkupElement[] = [];
  const lockedIds = new Set<string>();
  let returnTo: MarkupSession | null = null;
  for (const session of sessions) {
    const isActive = session.id === activeId;
    const visible = inView(session, current);
    let shown: MarkupElement[];
    if (visible) {
      shown = session.elements;
    } else {
      if (hasInk(session)) returnTo = session;
      shown = followPins(session.elements, project);
    }
    for (const el of shown) {
      if (isActive) {
        elements.push(el);
      } else {
        lockedIds.add(el.id);
        elements.push(el.locked ? el : { ...el, locked: true });
      }
    }
  }
  return { elements, lockedIds, returnTo };
}

/** Pins only, each moved to its projected position; everything else dropped. */
export function followPins(
  elements: readonly MarkupElement[],
  project: MarkupHost["project"] | undefined,
): MarkupElement[] {
  if (!project) return [];
  let out = elements.filter((el) => isPinPart(el) && !el.isDeleted);
  for (const el of out.slice()) {
    const data = kaavaData(el);
    if (data?.kind !== "pin" || typeof data.n !== "number") continue;
    const wp = data.worldPoint;
    if (!Array.isArray(wp)) {
      out = dropPin(out, data.n);
      continue;
    }
    const p = project(wp as Vec3);
    if (!p.visible) {
      out = dropPin(out, data.n);
      continue;
    }
    out = movePinTo(out, data.n, p.x, p.y);
  }
  return out;
}

function dropPin(elements: MarkupElement[], n: number): MarkupElement[] {
  return elements.filter((el) => {
    const d = kaavaData(el);
    return !(d && (d.kind === "pin" || d.kind === "pin-label") && d.n === n);
  });
}

/**
 * The store behind the layer. It owns the sessions, which one is being edited,
 * and the pin high-water mark; it does not know about Excalidraw or the DOM.
 */
export class MarkupSessions {
  readonly sessions: MarkupSession[] = [];
  activeId: string | null = null;
  /** Highest pin number ever issued: numbers are stable across sessions and deletes. */
  pinHighWater = 0;
  private seq = 0;

  /**
   * Entering markup mode at `pose`. Resumes the session already bound to that
   * pose, so drawing twice from the same view adds to one drawing; otherwise
   * opens a new one.
   */
  enter(pose: CameraPose | null): MarkupSession {
    const existing = this.sessions.find((s) =>
      pose && s.pose ? poseMatches(s.pose, pose) : !pose && !s.pose,
    );
    const session = existing ?? this.create(pose);
    this.activeId = session.id;
    return session;
  }

  /** Leaving keeps the session: its ink stays bound to its pose. */
  leave(): void {
    this.activeId = null;
  }

  get active(): MarkupSession | null {
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  private create(pose: CameraPose | null): MarkupSession {
    this.seq += 1;
    const session: MarkupSession = { id: `markup-${this.seq}`, pose, elements: [] };
    this.sessions.push(session);
    return session;
  }

  /** Stores what Excalidraw now holds for the active session, and tracks the pin high-water mark. */
  setActiveElements(elements: readonly MarkupElement[]): void {
    const session = this.active;
    if (!session) return;
    session.elements = elements.slice();
    for (const el of elements) {
      const d = kaavaData(el);
      if (d && (d.kind === "pin" || d.kind === "pin-label") && typeof d.n === "number") {
        if (d.n > this.pinHighWater) this.pinHighWater = d.n;
      }
    }
  }

  /** The number for the next pin, and retires it. */
  takePinNumber(): number {
    this.pinHighWater += 1;
    return this.pinHighWater;
  }

  /** Forget everything in the active session (the "Clear" button). Pin numbers stay retired. */
  clearActive(): void {
    const session = this.active;
    if (session) session.elements = [];
  }

  compose(current: CameraPose | null, project?: MarkupHost["project"]): ComposedScene {
    return composeScene(this.sessions, this.activeId, current, project);
  }
}
