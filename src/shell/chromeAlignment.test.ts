/**
 * The top-left chrome's alignment, read from the stylesheets that set it.
 *
 * No DOM here can lay these out — jsdom has no layout engine — so this pins
 * the declarations the alignment depends on instead. Each case below is a
 * regression from review round 1: half-pixel-high labels, mismatched gutters,
 * and square surfaces over rounded panes. It lives beside `WindowRoot.tsx` rather than
 * in a region because it reads five regions' stylesheets, which only the
 * wiring layer may do.
 */
import { describe, expect, it } from "vitest";
import frameCss from "./frame/frame.css?raw";
import stripCss from "./rail/clusterStrip.css?raw";
import panesCss from "./panes/panes.css?raw";
import toolwindowCss from "./toolwindow/toolwindow.css?raw";

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): Map<string, string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(stripped);
  if (!match) throw new Error(`no rule for ${selector}`);
  const decls = new Map<string, string>();
  for (const decl of match[1].split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
  }
  return decls;
}

/** A length's pixel value, resolving `var(--x, 12px)` to its fallback. */
function px(value: string | undefined): number {
  const fallback = /var\([^,]+,\s*([\d.]+)px\)/.exec(value ?? "");
  const plain = /^([\d.]+)px$/.exec(value ?? "");
  const found = fallback?.[1] ?? plain?.[1];
  if (found === undefined) throw new Error(`not a px length: ${value}`);
  return Number(found);
}

/** The left value of a one-to-four-value `padding`/`margin` shorthand. */
function leftOf(shorthand: string | undefined): number {
  const parts = (shorthand ?? "").match(/var\([^)]*\)|\S+/g) ?? [];
  const left = parts[parts.length === 4 ? 3 : parts.length === 1 ? 0 : 1];
  return left === "0" ? 0 : px(left);
}

describe("band heights leave the whole token for the content", () => {
  it("draws the pane strip's hairline without a border", () => {
    // A border-box border takes a pixel out of the height the content centres in.
    const decls = rule(panesCss, ".pane-tabstrip");
    expect([...decls.keys()].some((k) => k.startsWith("border"))).toBe(false);
    expect(decls.get("box-shadow")).toMatch(/^inset 0 -1px 0/);
  });
});

describe("one gutter around the panes and the rail card", () => {
  const gutter = 6;

  it("insets the pane grid and the right-hand card by the same gutter", () => {
    expect(leftOf(rule(frameCss, ".frame__toolwindow").get("margin"))).toBe(gutter);
    expect(px(rule(frameCss, ".frame__side").get("margin"))).toBe(gutter);
  });

  it("puts nothing between the title bar and the panes", () => {
    // The cluster bar used to be a 40px row here; the strip and the pill replaced it.
    expect(() => rule(frameCss, ".frame__switcher")).toThrow();
  });
});

describe("the cluster strip", () => {
  it("draws 28px badges, the shell's control size, with the active one marked on the edge", () => {
    const badge = rule(stripCss, ".clusterstrip__badge");
    expect(badge.get("width")).toMatch(/^var\(--control-md, 28px\)$/);
    expect(badge.get("height")).toMatch(/^var\(--control-md, 28px\)$/);
    expect(rule(stripCss, ".clusterstrip__badge[data-active]::before").get("background")).toBe(
      "var(--accent)",
    );
  });

  it("scrolls its own list rather than pushing the page icons off the rail", () => {
    const list = rule(stripCss, ".clusterstrip__list");
    expect(list.get("overflow-y")).toBe("auto");
    expect(list.get("max-height")).toBeDefined();
  });
});

describe("panes are one rounded card", () => {
  it("rounds and clips the pane itself", () => {
    const pane = rule(panesCss, ".pane");
    expect(pane.get("border-radius")).toMatch(/^var\(--radius-region/);
    expect(pane.get("overflow")).toBe("hidden");
  });

  it("rounds a surface's bottom corners to the pane border's inner edge", () => {
    const surface = rule(toolwindowCss, ".toolwindow__surface");
    expect(surface.get("overflow")).toBe("hidden");
    expect(surface.get("border-radius")).toMatch(
      /^0 0 calc\(var\(--radius-region, 10px\) - 1px\) calc\(var\(--radius-region, 10px\) - 1px\)$/,
    );
  });
});

describe("splitters are invisible until touched", () => {
  it("draws the pane dividers transparent at rest and accent on hover or drag", () => {
    expect(rule(panesCss, ".pane-split__divider::after").get("background")).toBe("transparent");
    const lit = rule(
      panesCss,
      ".pane-split__divider:hover::after,\n.pane-split__divider:active::after",
    );
    expect(lit.get("background")).toBe("var(--accent)");
  });

  it("draws the band and page grips the same way", () => {
    expect(rule(frameCss, ".frame__bottomgrip").get("background")).toBe("transparent");
    expect(rule(frameCss, ".frame__grip").get("background")).toBe("transparent");
  });

  it("divides a split's shares over the space left after its gaps", () => {
    // A percentage basis summed to the whole box and the gaps then pushed the last pane
    // past the edge, where the tool window clipped its border and rounded corners.
    expect(rule(panesCss, ".pane-split__child").get("flex-basis")).toBe("0");
  });
});

describe("the rail and an open page are one rounded card", () => {
  it("gives the right-hand box the pane's radius and the same 6px gutters", () => {
    const side = rule(frameCss, ".frame__side");
    expect(side.get("border-radius")).toMatch(/^var\(--radius-region/);
    expect(side.get("margin")).toMatch(/^var\(--space-1-5, 6px\)$/);
    expect(side.get("overflow")).toBe("hidden");
  });

  it("puts no border or radius on the docked page, so there is no second card", () => {
    const page = rule(frameCss, ".frame__page");
    expect(page.has("border")).toBe(false);
    expect(page.has("border-radius")).toBe(false);
  });
});
