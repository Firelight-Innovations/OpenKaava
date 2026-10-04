// @vitest-environment jsdom
/**
 * What a pane tab wears: a File Viewer is one file and looks like it — the
 * file's icon, its path as the tooltip, a dot when it has unsaved edits — while
 * any other app keeps the generic glyph and no colour square.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ClusterMember } from "../contract";
import { resetSubjectsForTest, setSubject } from "../viewerSubjects";
import PaneTabStrip from "./PaneTabStrip";
import stripSource from "./PaneTabStrip.tsx?raw";

beforeEach(() => {
  window.localStorage.clear();
  resetSubjectsForTest();
});
afterEach(cleanup);

const member = (over: Partial<ClusterMember>): ClusterMember => ({
  id: "viewer-1",
  dragId: "viewer-1",
  title: "main.rs",
  kind: "app",
  appId: "viewer",
  paneId: "p1",
  showing: true,
  agentFinished: false,
  ...over,
});

function strip(members: ClusterMember[]) {
  return render(
    <PaneTabStrip
      paneId="p1"
      members={members}
      caret={null}
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe("a File Viewer tab", () => {
  it("shows the file's icon and its full path as the tooltip", () => {
    setSubject("viewer-1", { path: "C:\\p\\src\\main.rs", preview: false, dirty: false });
    const { container } = strip([member({})]);
    const icon = container.querySelector<HTMLImageElement>("img.pane-tab__fileicon");
    expect(icon?.getAttribute("src")).toMatch(/^\/icons\/material\/.+\.svg$/);
    expect(container.querySelector(".pane-tab")?.getAttribute("title")).toBe("C:\\p\\src\\main.rs");
    expect(container.querySelector(".pane-tab__swatch")).toBeNull();
  });

  it("marks unsaved edits, and updates when the viewer reports them", () => {
    setSubject("viewer-1", { path: "/p/a.ts", preview: false, dirty: false });
    const { container } = strip([member({ title: "a.ts" })]);
    expect(container.querySelector(".pane-tab__dot--dirty")).toBeNull();
    act(() => setSubject("viewer-1", { path: "/p/a.ts", preview: false, dirty: true }));
    expect(container.querySelector(".pane-tab__dot--dirty")).not.toBeNull();
  });

  it("falls back to the app glyph before the viewer has opened a file", () => {
    const { container } = strip([member({ title: "File Viewer" })]);
    expect(container.querySelector("img.pane-tab__fileicon")).toBeNull();
    expect(container.querySelector(".pane-tab__icon--app")).not.toBeNull();
  });
});

describe("double-clicking a tab", () => {
  it("has no maximise gesture bound on the tab", () => {
    expect(stripSource).not.toMatch(/onDoubleClick|onToggleMaximize/);
  });
});

describe("any other app's tab", () => {
  it("keeps the app glyph and has no colour square", () => {
    const { container } = strip([member({ id: "files-1", title: "Files", appId: "files" })]);
    expect(container.querySelector(".pane-tab__icon--app")).not.toBeNull();
    expect(container.querySelector(".pane-tab__swatch")).toBeNull();
    expect(container.querySelector("img.pane-tab__fileicon")).toBeNull();
  });
});
