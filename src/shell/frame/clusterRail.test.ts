/**
 * The cluster list must stay reachable beside a docked page.
 *
 * jsdom does not run the stylesheet, so this reads it: a rule that hides the rail
 * while a page is docked is exactly the regression that left the cluster list
 * impossible to open with Agents docked on the right.
 */
import { describe, expect, it } from "vitest";
import frameCss from "./frame.css?raw";

/** Every rule whose selector mentions `.frame__rail`, as selector and body. */
function railRules(): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of frameCss.matchAll(pattern)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selector.includes(".frame__rail")) rules.push({ selector, body: m[2] });
  }
  return rules;
}

describe("frame.css cluster rail", () => {
  it("never hides the rail while a page is docked", () => {
    const hiding = railRules().filter(
      ({ selector, body }) => selector.includes("data-docked") && /display\s*:\s*none/.test(body),
    );
    expect(hiding).toEqual([]);
  });

  it("gives the column back only through the folded-list width variable", () => {
    expect(frameCss).toMatch(
      /\.frame__side:has\(\.clusterstrip\[data-collapsed\]\)\s*\{\s*--w-project-rail:\s*0px/,
    );
  });
});
