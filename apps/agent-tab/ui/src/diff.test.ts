import { describe, expect, it } from "vitest";
import { counts, lineDiff } from "./diff";

describe("lineDiff", () => {
  it("marks removed and added lines around the ones kept", () => {
    const lines = lineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(lines).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "B" },
      { op: " ", text: "c" },
      { op: "+", text: "d" },
    ]);
    expect(counts(lines ?? [])).toEqual({ added: 2, removed: 1 });
  });

  it("treats a new file as all additions", () => {
    expect(lineDiff(null, "x\ny")).toEqual([
      { op: "+", text: "x" },
      { op: "+", text: "y" },
    ]);
  });

  it("gives up on a change too large to compare", () => {
    const big = Array.from({ length: 3000 }, (_, i) => String(i)).join("\n");
    expect(lineDiff(big, `${big}\nmore`)).toBeNull();
  });
});
