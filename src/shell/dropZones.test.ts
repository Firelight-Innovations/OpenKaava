// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { hitTest, terminalAt, useDropZone } from "./dropZones";
import { renderHook } from "@testing-library/react";

/** A fake element with a fixed `getBoundingClientRect()` — enough for `hitTest`,
 *  which only ever reads that one method off whatever `useDropZone` was given. */
function rectEl(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

/** Registers a zone for the lifetime of the test and returns nothing — the
 *  registry is a module singleton, so cleanup is the caller's job via the
 *  returned unregister, which every test runs in `afterEach`. */
const cleanups: Array<() => void> = [];
function register(zone: Parameters<typeof useDropZone>[0], rect: Parameters<typeof rectEl>[0]): void {
  const { result } = renderHook(() => useDropZone(zone));
  const el = rectEl(rect);
  result.current(el);
  cleanups.push(() => result.current(null));
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("hitTest", () => {
  it("finds the pane's centre as an append, not a split", () => {
    register({ kind: "pane", paneId: "p1" }, { left: 0, top: 0, width: 200, height: 200 });
    expect(hitTest(100, 100)).toEqual({ kind: "pane", paneId: "p1", edge: null, before: false });
  });

  it("finds each of the four edge bands", () => {
    register({ kind: "pane", paneId: "p1" }, { left: 0, top: 0, width: 200, height: 200 });
    expect(hitTest(5, 100)).toEqual({ kind: "pane", paneId: "p1", edge: "row", before: true });
    expect(hitTest(195, 100)).toEqual({ kind: "pane", paneId: "p1", edge: "row", before: false });
    expect(hitTest(100, 5)).toEqual({ kind: "pane", paneId: "p1", edge: "column", before: true });
    expect(hitTest(100, 195)).toEqual({ kind: "pane", paneId: "p1", edge: "column", before: false });
  });

  it("prefers a strip over the pane beneath it", () => {
    register({ kind: "pane", paneId: "p1" }, { left: 0, top: 0, width: 200, height: 200 });
    register(
      { kind: "strip", at: (_x) => ({ paneId: "p1", tabRects: [{ left: 0, width: 40 } as DOMRect] }) },
      { left: 0, top: 0, width: 200, height: 34 },
    );
    expect(hitTest(100, 10)).toEqual({ kind: "strip", paneId: "p1", index: 1 });
  });

  it("lands on a cluster chip", () => {
    register({ kind: "cluster", clusterId: "c1" }, { left: 0, top: 0, width: 80, height: 36 });
    expect(hitTest(40, 18)).toEqual({ kind: "cluster", clusterId: "c1", refused: false });
  });

  it("prefers a cluster chip over the switcher's own background", () => {
    register({ kind: "switcher" }, { left: 0, top: 0, width: 400, height: 36 });
    register({ kind: "cluster", clusterId: "c1" }, { left: 100, top: 0, width: 80, height: 36 });
    expect(hitTest(140, 18)).toEqual({ kind: "cluster", clusterId: "c1", refused: false });
  });

  it("falls back to the switcher's empty space as a new-cluster target", () => {
    register({ kind: "switcher" }, { left: 0, top: 0, width: 400, height: 36 });
    register({ kind: "cluster", clusterId: "c1" }, { left: 100, top: 0, width: 80, height: 36 });
    expect(hitTest(10, 18)).toEqual({ kind: "new-cluster" });
  });

  it("finds the panel", () => {
    register({ kind: "panel" }, { left: 800, top: 0, width: 380, height: 600 });
    expect(hitTest(900, 100)).toEqual({ kind: "panel" });
  });

  it("detaches when nothing is registered at the point", () => {
    register({ kind: "pane", paneId: "p1" }, { left: 0, top: 0, width: 200, height: 200 });
    expect(hitTest(9999, 9999)).toEqual({ kind: "detach" });
  });
});

describe("terminalAt", () => {
  it("finds a registered terminal and ignores everything else", () => {
    register({ kind: "pane", paneId: "p1" }, { left: 0, top: 0, width: 200, height: 200 });
    register({ kind: "terminal", sessionId: "t1" }, { left: 0, top: 0, width: 200, height: 200 });
    expect(terminalAt(100, 100)).toBe("t1");
    expect(terminalAt(9999, 9999)).toBeNull();
  });
});
