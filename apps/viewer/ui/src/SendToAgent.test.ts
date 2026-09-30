import { describe, expect, it, vi } from "vitest";

vi.mock("@openkaava/bridge", () => ({ invoke: vi.fn() }));

import { pickSelection } from "./SendToAgent";

describe("pickSelection", () => {
  it("is null for an empty selection", () => {
    expect(pickSelection({ startLineNumber: 3, endLineNumber: 3, endColumn: 4 }, "")).toBeNull();
    expect(pickSelection(null, "x")).toBeNull();
  });

  it("gives the first and last line the selection touches", () => {
    expect(pickSelection({ startLineNumber: 12, endLineNumber: 30, endColumn: 9 }, "a\nb")).toEqual(
      { startLine: 12, endLine: 30, text: "a\nb" },
    );
  });

  it("does not count a line the selection only reaches the start of", () => {
    expect(pickSelection({ startLineNumber: 12, endLineNumber: 31, endColumn: 1 }, "a\n")).toEqual({
      startLine: 12,
      endLine: 30,
      text: "a\n",
    });
  });
});
