import { describe, expect, it } from "vitest";
import type { Openable } from "../../bindings";
import { filterApps, stepIndex } from "./pickerFilter";

const app = (id: string, name: string, description = ""): Openable => ({
  id,
  name,
  description,
  kind: "app",
});

const APPS = [
  app("home", "Home", "Start here"),
  app("files", "Files", "Browse and edit files"),
  app("godot-viewer", "Godot Viewer", "Watch a running game"),
  app("schematify", "Schematify", "Edit a schematic file"),
];

describe("filterApps", () => {
  it("returns every app for an empty or blank query", () => {
    expect(filterApps(APPS, "")).toEqual(APPS);
    expect(filterApps(APPS, "   ")).toEqual(APPS);
  });

  it("matches by name, case-insensitively", () => {
    expect(filterApps(APPS, "GODOT").map((a) => a.id)).toEqual(["godot-viewer"]);
  });

  it("ranks a name prefix above a description mention", () => {
    // Schematify's description says "file", but Files starts with it.
    expect(filterApps(APPS, "file").map((a) => a.id)).toEqual(["files", "schematify"]);
  });

  it("finds an app by its id when the name differs", () => {
    expect(filterApps([app("x.y", "Plugin Thing")], "x.y")).toHaveLength(1);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterApps(APPS, "zzz")).toEqual([]);
  });
});

describe("stepIndex", () => {
  it("wraps in both directions", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  it("stays at zero for an empty list", () => {
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
