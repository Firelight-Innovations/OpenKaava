import { describe, expect, it } from "vitest";
import { summarize } from "./actions";
import type { Item, ToolStatus } from "./protocol.generated";

function tool(id: string, toolKind: string, status: ToolStatus = "completed"): Item {
  return {
    id,
    turnId: "t1",
    kind: {
      kind: "toolCall",
      title: id,
      toolKind,
      status,
      output: "",
      truncated: false,
      paths: [],
      diffs: [],
    },
  };
}

describe("summarize", () => {
  it("counts each verb in the order the agent first used it", () => {
    const run = [tool("a", "execute"), tool("b", "read"), tool("c", "execute"), tool("d", "think")];
    expect(summarize(run)).toEqual({
      summary: "Ran 2 commands, read a file, used a tool",
      running: false,
      failed: 0,
    });
  });

  it("reads delete and move as edits, and an unknown kind as a tool", () => {
    const run = [tool("a", "edit"), tool("b", "delete"), tool("c", "move"), tool("d", "nonesuch")];
    expect(summarize(run).summary).toBe("Edited 3 files, used a tool");
  });

  it("is running while any call is pending or in progress, and counts failures", () => {
    expect(summarize([tool("a", "search"), tool("b", "fetch", "inProgress")])).toEqual({
      summary: "Ran a search, fetched a page",
      running: true,
      failed: 0,
    });
    expect(summarize([tool("a", "execute", "failed"), tool("b", "execute", "pending")])).toEqual({
      summary: "Ran 2 commands",
      running: true,
      failed: 1,
    });
  });

  it("reads a kind named after an Object member as a tool, not a crash", () => {
    const run = [tool("a", "constructor"), tool("b", "toString"), tool("c", "__proto__")];
    expect(summarize(run).summary).toBe("Used 3 tools");
  });
});
