import { describe, expect, it } from "vitest";
import { dropLabel } from "./dropLabel";
import type { DropTarget } from "./contract";

describe("dropLabel", () => {
  it("is null with nothing in the air", () => {
    expect(dropLabel(null)).toBeNull();
  });

  it("names all four split edges", () => {
    const at = (edge: "row" | "column", before: boolean): DropTarget => ({
      kind: "pane",
      paneId: "p1",
      edge,
      before,
    });
    expect(dropLabel(at("row", true))).toBe("Split left");
    expect(dropLabel(at("row", false))).toBe("Split right");
    expect(dropLabel(at("column", true))).toBe("Split up");
    expect(dropLabel(at("column", false))).toBe("Split down");
  });

  it("calls a pane's centre and a strip both an append", () => {
    expect(dropLabel({ kind: "pane", paneId: "p1", edge: null, before: false })).toBe("Add as tab");
    expect(dropLabel({ kind: "strip", paneId: "p1", index: 0 })).toBe("Add as tab");
  });

  it("says which way a cluster drop will go", () => {
    expect(dropLabel({ kind: "cluster", clusterId: "c1", refused: false })).toBe(
      "Move into this cluster",
    );
    expect(dropLabel({ kind: "cluster", clusterId: "c1", refused: true })).toMatch(/can't/i);
  });

  it("names the rest of the zones", () => {
    expect(dropLabel({ kind: "new-cluster" })).toBe("Open in a new cluster");
    expect(dropLabel({ kind: "panel" })).toBe("Move to the terminal panel");
    expect(dropLabel({ kind: "detach" })).toMatch(/new window/);
    expect(dropLabel({ kind: "none" })).toBeNull();
  });
});
