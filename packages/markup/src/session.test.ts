import { describe, expect, it } from "vitest";
import { arrow, pin, pose } from "./fixtures";
import { MarkupSessions, composeScene, poseMatches } from "./session";
import type { Projected, Vec3 } from "./types";

describe("poseMatches", () => {
  it("accepts tiny float drift and rejects a real move", () => {
    expect(poseMatches(pose(1), pose(1 + 1e-6))).toBe(true);
    expect(poseMatches(pose(1), pose(1.5))).toBe(false);
    expect(poseMatches(pose(1, 50), pose(1, 60))).toBe(false);
  });
});

describe("sessions", () => {
  it("binds ink to the pose it was entered at and resumes it at that pose", () => {
    const s = new MarkupSessions();
    const first = s.enter(pose(1));
    s.setActiveElements([arrow("a", 0, 0, 10, 10)]);
    s.leave();
    expect(s.activeId).toBeNull();
    const again = s.enter(pose(1));
    expect(again.id).toBe(first.id);
    expect(again.elements).toHaveLength(1);
  });

  it("opens a second session at a different pose", () => {
    const s = new MarkupSessions();
    const a = s.enter(pose(1));
    s.leave();
    const b = s.enter(pose(9));
    expect(b.id).not.toBe(a.id);
    expect(s.sessions).toHaveLength(2);
  });

  it("uses one session for a host with no camera", () => {
    const s = new MarkupSessions();
    const a = s.enter(null);
    s.leave();
    expect(s.enter(null).id).toBe(a.id);
  });

  it("tracks the pin high-water mark across sessions and deletes", () => {
    const s = new MarkupSessions();
    s.enter(pose(1));
    s.setActiveElements(pin(3, 0, 0));
    expect(s.pinHighWater).toBe(3);
    s.clearActive();
    expect(s.pinHighWater).toBe(3);
    expect(s.takePinNumber()).toBe(4);
  });
});

describe("composeScene", () => {
  // The camera moved from x=1 to x=9: a world point that was at 100 is now at 300.
  const project = (p: Vec3): Projected => ({ x: p[0] * 100 + 200, y: 80, visible: p[2] >= 0 });

  function twoSessions() {
    const s = new MarkupSessions();
    s.enter(pose(1));
    s.setActiveElements([arrow("a", 0, 0, 10, 10), ...pin(1, 100, 80, [1, 0, 0])]);
    s.leave();
    return s;
  }

  it("shows everything while the camera is at the session pose", () => {
    const s = twoSessions();
    const c = s.compose(pose(1), project);
    expect(c.elements.map((e) => e.id)).toEqual(["a", "m1", "l1"]);
    expect(c.returnTo).toBeNull();
  });

  it("hides ink but keeps pins once the camera moves away, and offers Return", () => {
    const s = twoSessions();
    const c = s.compose(pose(9), project);
    expect(c.elements.map((e) => e.id)).toEqual(["m1", "l1"]);
    expect(c.returnTo?.pose).toEqual(pose(1));
  });

  it("moves a pin to where its world point projects", () => {
    const s = twoSessions();
    const c = s.compose(pose(9), project);
    const marker = c.elements[0];
    expect(marker.x + marker.width / 2).toBe(300);
    expect(marker.y + marker.height / 2).toBe(80);
    const label = c.elements[1];
    expect(label.x - marker.x).toBe(12);
  });

  it("brings the ink back when the camera returns", () => {
    const s = twoSessions();
    s.compose(pose(9), project);
    expect(s.compose(pose(1), project).elements.map((e) => e.id)).toContain("a");
  });

  it("drops a pin that projects out of view, and a pin with no world point", () => {
    const s = new MarkupSessions();
    s.enter(pose(1));
    s.setActiveElements([...pin(1, 0, 0, [0, 0, -1]), ...pin(2, 0, 0)]);
    s.leave();
    expect(s.compose(pose(9), project).elements).toEqual([]);
  });

  it("drops every pin when the host cannot project", () => {
    const s = twoSessions();
    expect(s.compose(pose(9), undefined).elements).toEqual([]);
  });

  it("locks the elements of sessions that are not being edited", () => {
    const s = twoSessions();
    s.enter(pose(9));
    s.setActiveElements([arrow("b", 0, 0, 5, 5)]);
    const c = composeScene(s.sessions, s.activeId, pose(9), project);
    expect(c.lockedIds).toEqual(new Set(["m1", "l1"]));
    expect(c.elements.find((e) => e.id === "m1")?.locked).toBe(true);
    expect(c.elements.find((e) => e.id === "b")?.locked).toBeUndefined();
  });

  it("has no Return chip for a session that holds only pins", () => {
    const s = new MarkupSessions();
    s.enter(pose(1));
    s.setActiveElements(pin(1, 0, 0, [0, 0, 1]));
    s.leave();
    expect(s.compose(pose(9), project).returnTo).toBeNull();
  });

  it("always shows the ink of a session with no pose", () => {
    const s = new MarkupSessions();
    s.enter(null);
    s.setActiveElements([arrow("a", 0, 0, 10, 10)]);
    s.leave();
    expect(s.compose(null).elements.map((e) => e.id)).toEqual(["a"]);
  });
});
