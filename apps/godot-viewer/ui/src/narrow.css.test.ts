import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the app tsconfig carries no Node types.
import godot from "./App.css?raw";

/**
 * Structure checks for the narrow-pane layout. jsdom does no layout, so these
 * pin the declarations that keep the header and footer from overlapping.
 */
function rule(css: string, selector: string): string {
  // The last rule for the selector: a shared group rule may come first.
  const at = css.lastIndexOf(`\n${selector} {`);
  expect(at, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("narrow panes", () => {
  it("Godot Viewer header wraps and truncates its badge", () => {
    expect(rule(godot, ".gv__header")).toContain("flex-wrap: wrap");
    const badge = rule(godot, ".gv__badge");
    expect(badge).toContain("text-overflow: ellipsis");
    expect(badge).toContain("white-space: nowrap");
    expect(rule(godot, ".gv__footer-btn")).toContain("white-space: nowrap");
  });
});
