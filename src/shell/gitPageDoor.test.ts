/**
 * The status bar's git controls and "Review & merge" open the Git page through
 * the rail's toggling door. These pin that a view request never shuts the page,
 * that only `null` does, and that a covering screen comes down first.
 */
import { describe, expect, it } from "vitest";
import { gitViewShowing, showGitView } from "./gitPageDoor";

/** A door that records what was done to it, in order. */
function door() {
  const did: string[] = [];
  return {
    did,
    uncover: () => did.push("uncover"),
    open: () => did.push("open"),
    close: () => did.push("close"),
    setView: (view: string) => did.push(`view:${view}`),
  };
}

describe("showGitView", () => {
  it("opens a shut page, then picks the view", () => {
    const d = door();
    showGitView("github", false, d);
    expect(d.did).toEqual(["uncover", "open", "view:github"]);
  });

  it("switches an open page's view without going through the door", () => {
    const d = door();
    showGitView("worktree", true, d);
    expect(d.did).toEqual(["uncover", "view:worktree"]);
  });

  it("shuts an open page on null", () => {
    const d = door();
    showGitView(null, true, d);
    expect(d.did).toEqual(["uncover", "close"]);
  });

  it("does nothing on null while the Git page is shut, so another page stays open", () => {
    const d = door();
    showGitView(null, false, d);
    expect(d.did).toEqual(["uncover"]);
  });
});

describe("gitViewShowing", () => {
  it("is the page's view while the Git page is open and uncovered", () => {
    expect(gitViewShowing("git", false, "github")).toBe("github");
  });

  it("is null while a screen covers the page, so pressing the view cannot shut it", () => {
    expect(gitViewShowing("git", true, "worktree")).toBeNull();
  });

  it("is null while another page, or none, is open", () => {
    expect(gitViewShowing("hindsight", false, "worktree")).toBeNull();
    expect(gitViewShowing(undefined, false, "worktree")).toBeNull();
  });
});
