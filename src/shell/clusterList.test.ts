import { describe, expect, it } from "vitest";
import type { Cluster } from "./contract";
import {
  branchLabel,
  clusterMenuItems,
  clusterTooltip,
  cycleTarget,
  folderName,
  monogram,
  needsAttention,
  orderClusters,
} from "./clusterList";

function cluster(id: string, over: Partial<Cluster> = {}): Cluster {
  return {
    id,
    name: id,
    tree: { kind: "leaf", tabs: [], active: null } as unknown as Cluster["tree"],
    project: "C:/code/openkaava",
    worktree: null,
    activeTerminal: null,
    bandHeight: null,
    pinned: false,
    ...over,
  };
}

const wt = (branch: string) => ({ path: `C:/wt/${branch}`, branch, base: "main" });

describe("orderClusters", () => {
  it("puts the design canvas first and keeps the rest in window order", () => {
    const design = cluster("d", { worktree: wt("wt/design") });
    const out = orderClusters([cluster("a"), cluster("b"), design, cluster("c")]);
    expect(out.map((c) => c.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("leaves the order alone when there is no design cluster", () => {
    expect(orderClusters([cluster("a"), cluster("b")]).map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("cycleTarget", () => {
  const list = [cluster("a"), cluster("b"), cluster("c")];

  it("steps forward and back, wrapping at both ends", () => {
    expect(cycleTarget(list, "a", 1)).toBe("b");
    expect(cycleTarget(list, "c", 1)).toBe("a");
    expect(cycleTarget(list, "a", -1)).toBe("c");
    expect(cycleTarget(list, "b", -1)).toBe("a");
  });

  it("has nowhere to go with one cluster or none", () => {
    expect(cycleTarget([cluster("a")], "a", 1)).toBeNull();
    expect(cycleTarget([], null, 1)).toBeNull();
  });

  it("starts from the ends when nothing is active", () => {
    expect(cycleTarget(list, null, 1)).toBe("a");
    expect(cycleTarget(list, null, -1)).toBe("c");
  });
});

describe("labels", () => {
  it("names the folder whatever the separator", () => {
    expect(folderName(String.raw`C:\code\open-kaava` + "\\")).toBe("open-kaava");
    expect(folderName("/home/me/proj")).toBe("proj");
  });

  it("reads project · branch for a worktree, and main for none", () => {
    expect(clusterTooltip(cluster("a", { worktree: wt("feat/x") }))).toBe("openkaava · feat/x");
    expect(clusterTooltip(cluster("a"))).toBe("openkaava · main");
    expect(branchLabel(cluster("a"))).toBe("main");
  });

  it("says when the worktree folder is gone", () => {
    const missing = cluster("a", { worktree: wt("feat/x"), environmentMissing: true });
    expect(clusterTooltip(missing)).toContain("missing");
  });

  it("makes two-letter monograms", () => {
    expect(monogram("godot-port")).toBe("GP");
    expect(monogram("auth")).toBe("AU");
    expect(monogram("x")).toBe("X");
    expect(monogram("")).toBe("?");
  });
});

describe("needsAttention", () => {
  const terminals = [
    { clusterId: "b", agentFinished: true },
    { clusterId: "a", agentFinished: true },
    { clusterId: "c", agentFinished: false },
  ];

  it("flags a background cluster whose agent finished", () => {
    expect(needsAttention("b", "a", terminals)).toBe(true);
    expect(needsAttention("c", "a", terminals)).toBe(false);
  });

  it("never flags the open cluster", () => {
    expect(needsAttention("a", "a", terminals)).toBe(false);
  });
});

describe("clusterMenuItems", () => {
  it("mirrors the tab's actions and routes them to the same handlers", async () => {
    const calls: string[] = [];
    const items = clusterMenuItems(cluster("a", { name: "auth" }), {
      onSelect: (id) => calls.push(`select:${id}`),
      onRename: async (id, name) => void calls.push(`rename:${id}:${name}`),
      onClose: (id) => calls.push(`close:${id}`),
    });
    expect(items.map((i) => i.label)).toEqual(["Switch to cluster", "Rename…", "Close cluster"]);

    items[0].onSelect?.();
    items[2].onSelect?.();
    await items[1].prompt?.onSubmit("  billing ");
    expect(calls).toEqual(["select:a", "close:a", "rename:a:billing"]);
  });

  it("offers Change icon… only where a picker is wired", () => {
    const base = { onSelect: () => {}, onRename: async () => {}, onClose: () => {} };
    const opened: string[] = [];
    const items = clusterMenuItems(cluster("a", { name: "auth" }), {
      ...base,
      onChangeIcon: (id) => opened.push(id),
    });
    expect(items.map((i) => i.label)).toEqual([
      "Switch to cluster",
      "Rename…",
      "Change icon…",
      "Close cluster",
    ]);
    items[2].onSelect?.();
    expect(opened).toEqual(["a"]);
  });

  it("refuses an empty name and skips an unchanged one", async () => {
    const renamed: string[] = [];
    const items = clusterMenuItems(cluster("a", { name: "auth" }), {
      onSelect: () => {},
      onRename: async (_id, name) => void renamed.push(name),
      onClose: () => {},
    });
    await expect(items[1].prompt?.onSubmit("  ")).rejects.toThrow();
    await items[1].prompt?.onSubmit("auth");
    expect(renamed).toEqual([]);
  });
});
