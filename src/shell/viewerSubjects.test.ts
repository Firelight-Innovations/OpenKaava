// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearsSubject,
  declaredSubject,
  getSubject,
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

describe("what a viewer reports", () => {
  it("says it has no file with a null subject", () => {
    expect(clearsSubject({ title: "File Viewer", subject: null })).toBe(true);
    expect(clearsSubject({ title: "a.ts", subject: "/p/a.ts" })).toBe(false);
    expect(clearsSubject({ title: "a.ts" })).toBe(false);
  });

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
