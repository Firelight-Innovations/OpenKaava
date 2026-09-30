// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  declaredSubject,
  getSubject,
  normalizePath,
  planViewerOpen,
  resetSubjectsForTest,
  setSubject,
  subjectsVersion,
  type Subject,
} from "./viewerSubjects";
import { baseNameOf } from "./viewerTitle";

const at = (path: string, extra: Partial<Subject> = {}): Subject => ({
  path,
  preview: false,
  dirty: false,
  ...extra,
});

describe("routing a file to a viewer", () => {
  const subjects: Record<string, Subject | undefined> = {};
  const of = (id: string) => subjects[id];
  beforeEach(() => {
    for (const k of Object.keys(subjects)) delete subjects[k];
  });

  it("focuses the viewer that already shows the file instead of opening another", () => {
    subjects["v1"] = at("C:\\p\\a.ts");
    subjects["v2"] = at("C:\\p\\b.ts");
    expect(planViewerOpen(["v1", "v2"], of, "C:\\p\\b.ts", false)).toEqual({
      kind: "focus",
      id: "v2",
    });
  });

  it("treats separators and drive-letter case as the same path", () => {
    subjects["v1"] = at("C:\\p\\a.ts");
    expect(planViewerOpen(["v1"], of, "c:/p/a.ts", true)).toEqual({ kind: "focus", id: "v1" });
  });

  it("keeps POSIX paths case sensitive", () => {
    subjects["v1"] = at("/p/A.ts");
    expect(planViewerOpen(["v1"], of, "/p/a.ts", false).kind).toBe("new");
    expect(normalizePath("/p/A.ts")).toBe("/p/A.ts");
  });

  it("lets a single click take over a clean peek, but only a peek", () => {
    subjects["v1"] = at("/p/a.ts", { preview: true });
    subjects["v2"] = at("/p/b.ts");
    expect(planViewerOpen(["v1", "v2"], of, "/p/c.ts", true)).toEqual({ kind: "reuse", id: "v1" });
    expect(planViewerOpen(["v1", "v2"], of, "/p/c.ts", false).kind).toBe("new");
  });

  it("never takes over a peek that has unsaved edits", () => {
    subjects["v1"] = at("/p/a.ts", { preview: true, dirty: true });
    expect(planViewerOpen(["v1"], of, "/p/c.ts", true).kind).toBe("new");
  });

  it("gives an empty viewer, such as one saved before this change, the next file", () => {
    subjects["v1"] = at("/p/a.ts");
    expect(planViewerOpen(["v1", "v2"], of, "/p/c.ts", false)).toEqual({
      kind: "reuse",
      id: "v2",
    });
  });

  it("opens a new viewer when every one is settled on another file", () => {
    subjects["v1"] = at("/p/a.ts");
    expect(planViewerOpen(["v1"], of, "/p/c.ts", false)).toEqual({ kind: "new" });
    expect(planViewerOpen([], of, "/p/c.ts", false)).toEqual({ kind: "new" });
  });
});

describe("what a viewer reports", () => {
  it("needs a title and a subject", () => {
    expect(declaredSubject({ title: "a.ts", subject: "/p/a.ts", preview: true })).toEqual({
      title: "a.ts",
      path: "/p/a.ts",
      preview: true,
      dirty: false,
    });
    expect(declaredSubject({ title: "a.ts" })).toBeNull();
    expect(declaredSubject({ subject: "/p/a.ts" })).toBeNull();
    expect(declaredSubject(null)).toBeNull();
  });
});

describe("the store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSubjectsForTest();
  });

  it("does not notify when nothing changed", () => {
    setSubject("v1", at("/p/a.ts"));
    const seen = subjectsVersion();
    setSubject("v1", at("/p/a.ts"));
    expect(subjectsVersion()).toBe(seen);
  });

  it("restores a settled subject after a restart", () => {
    setSubject("v1", at("/p/a.ts", { preview: true, dirty: true }));
    resetSubjectsForTest();
    expect(getSubject("v1")).toEqual(at("/p/a.ts"));
  });

  it("ignores corrupt stored state", () => {
    window.localStorage.setItem("kaava.viewer.subjects.v1", "{not json");
    resetSubjectsForTest();
    expect(getSubject("v1")).toBeUndefined();
  });
});

describe("the tab title", () => {
  it("is the last path segment under either separator", () => {
    expect(baseNameOf("C:\\p\\src\\a.ts")).toBe("a.ts");
    expect(baseNameOf("/p/src/a.ts")).toBe("a.ts");
    expect(baseNameOf("C:\\p\\dir\\")).toBe("dir");
    expect(baseNameOf("a.ts")).toBe("a.ts");
  });
});
