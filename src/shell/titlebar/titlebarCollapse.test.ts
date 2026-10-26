/**
 * A narrow window must not stack the title bar's right cell under the pill.
 *
 * jsdom does not run the stylesheet, so this reads it. With the pill held on
 * the window's centre, each side had only half of what it left, and the right
 * cell's buttons (which do not shrink) spilled left under the pill: Upgrade and
 * search drawn over "No project".
 */
import { describe, expect, it } from "vitest";
import titlebarCss from "./titlebar.css?raw";

/** The body of the `@container titlebar (max-width: Npx)` block, or "". */
function under(px: number): string {
  const start = titlebarCss.indexOf(`@container titlebar (max-width: ${px}px)`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = titlebarCss.indexOf("{", start); i < titlebarCss.length; i++) {
    if (titlebarCss[i] === "{") depth++;
    if (titlebarCss[i] === "}" && --depth === 0) return titlebarCss.slice(start, i);
  }
  return "";
}

describe("titlebar.css collapse", () => {
  it("lets the pill leave the centre in a narrow bar, so the right cell gets the room", () => {
    expect(under(999)).toMatch(/grid-template-columns:\s*auto auto minmax\(0, 1fr\)/);
  });

  it("drops Upgrade before anything that is part of the work", () => {
    expect(under(899)).toMatch(/\.titlebar__upgrade\s*\{\s*display:\s*none/);
  });

  it("clips the right cell rather than letting it spill under the pill", () => {
    expect(titlebarCss).toMatch(/\.titlebar__end\s*\{\s*overflow:\s*clip/);
  });
});
