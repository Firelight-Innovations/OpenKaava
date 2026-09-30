import { describe, expect, it, vi } from "vitest";
import { arrow, el, pin } from "./fixtures";
import { annotateTargets, resolveTargets, targetPoint } from "./targets";
import type { MarkupHost } from "./types";

const hit = { nodePath: "Root/Door", worldPoint: [1, 2, 3] as [number, number, number] };

describe("targetPoint", () => {
  it("uses the head of an arrow", () => {
    expect(targetPoint(arrow("a", 10, 20, 30, 40))).toEqual({ at: "head", x: 40, y: 60 });
  });

  it("uses the tail when only the start has a head", () => {
    const a = { ...arrow("a", 10, 20, 30, 40), startArrowhead: "arrow", endArrowhead: null };
    expect(targetPoint(a)).toEqual({ at: "head", x: 10, y: 20 });
  });

  it("uses the centre of a box or ellipse", () => {
    expect(
      targetPoint(el({ id: "r", type: "rectangle", x: 10, y: 10, width: 100, height: 40 })),
    ).toEqual({
      at: "centre",
      x: 60,
      y: 30,
    });
    expect(
      targetPoint(el({ id: "e", type: "ellipse", x: 0, y: 0, width: 20, height: 20 }))?.at,
    ).toBe("centre");
  });

  it("has nothing for ink, text or deleted elements", () => {
    expect(targetPoint(el({ id: "f", type: "freedraw" }))).toBeNull();
    expect(targetPoint(el({ id: "t", type: "text" }))).toBeNull();
    expect(targetPoint({ ...arrow("a", 0, 0, 5, 5), isDeleted: true })).toBeNull();
  });
});

describe("pick to targets", () => {
  it("asks the host for the arrow head and records what it returns", () => {
    const pick = vi.fn(() => hit);
    expect(resolveTargets(arrow("a", 0, 0, 100, 50), pick)).toEqual([{ ...hit, at: "head" }]);
    expect(pick).toHaveBeenCalledWith(100, 50);
  });

  it("records nothing over empty space or without a picker", () => {
    expect(resolveTargets(arrow("a", 0, 0, 1, 1), () => null)).toEqual([]);
    expect(resolveTargets(arrow("a", 0, 0, 1, 1), undefined)).toEqual([]);
  });
});

describe("annotateTargets", () => {
  const pick: MarkupHost["pick"] = () => hit;

  it("stamps kind and targets onto arrows and boxes", () => {
    const [a, r] = annotateTargets(
      [arrow("a", 0, 0, 10, 10), el({ id: "r", type: "rectangle", width: 10, height: 10 })],
      pick,
    );
    expect(a.customData).toEqual({ kaava: { kind: "arrow", targets: [{ ...hit, at: "head" }] } });
    expect(r.customData).toEqual({
      kaava: { kind: "rectangle", targets: [{ ...hit, at: "centre" }] },
    });
  });

  it("stamps only the kind when the host cannot pick", () => {
    const [a] = annotateTargets([arrow("a", 0, 0, 10, 10)], undefined);
    expect(a.customData).toEqual({ kaava: { kind: "arrow" } });
  });

  it("is idempotent: a second pass returns the same objects", () => {
    const once = annotateTargets([arrow("a", 0, 0, 10, 10)], pick);
    const twice = annotateTargets(once, pick);
    expect(twice[0]).toBe(once[0]);
  });

  it("drops a stale target when the arrow now points at nothing", () => {
    const once = annotateTargets([arrow("a", 0, 0, 10, 10)], pick);
    const [after] = annotateTargets(once, () => null);
    expect(after.customData).toEqual({ kaava: { kind: "arrow" } });
  });

  it("leaves pins and bound labels alone", () => {
    const pins = pin(1, 0, 0);
    const out = annotateTargets(pins, pick);
    expect(out[0]).toBe(pins[0]);
    expect(out[1]).toBe(pins[1]);
  });
});
