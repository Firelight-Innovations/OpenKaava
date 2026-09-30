/**
 * The top-left chrome's alignment, read from the stylesheets that set it.
 *
 * No DOM here can lay these out — jsdom has no layout engine — so this pins
 * the declarations the alignment depends on instead. Each case below is a
 * regression from review round 1: tabs riding at the top of the switcher,
 * half-pixel-high labels, left edges on three different columns, and square
 * surfaces over rounded panes. It lives beside `WindowRoot.tsx` rather than
 * in a region because it reads five regions' stylesheets, which only the
 * wiring layer may do.
 */
import { describe, expect, it } from "vitest";
import frameCss from "./frame/frame.css?raw";
import switcherCss from "./switcher/switcher.css?raw";
import envbarCss from "./envbar/envbar.css?raw";
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
  it("draws the switcher's and the pane strip's hairlines without a border", () => {
    // A border-box border takes a pixel out of the height the content centres in.
    for (const [css, selector] of [
      [frameCss, ".frame__switcher"],
      [panesCss, ".pane-tabstrip"],
    ] as const) {
      const decls = rule(css, selector);
      expect([...decls.keys()].some((k) => k.startsWith("border"))).toBe(false);
      expect(decls.get("box-shadow")).toMatch(/^inset 0 -1px 0/);
    }
  });

  it("centres cluster tabs in the switcher rather than stretching their wrappers", () => {
    expect(rule(switcherCss, ".switcher__tabs").get("align-items")).toBe("center");
  });

  it("sizes the environment bar from its token", () => {
    expect(rule(envbarCss, ".envbar").get("height")).toMatch(/^var\(--h-envbar/);
  });
});

describe("one gutter on the left", () => {
  const gutter = 6;

  it("insets the first cluster tab, the environment bar and the pane grid by the same gutter", () => {
    expect(leftOf(rule(switcherCss, ".switcher__tabs").get("padding-left"))).toBe(gutter);
    expect(leftOf(rule(frameCss, ".frame__envbar").get("margin"))).toBe(gutter);
    expect(leftOf(rule(frameCss, ".frame__toolwindow").get("margin"))).toBe(gutter);
  });

  it("starts each band's content on the same column inside its 1px border", () => {
    const clusterTab = leftOf(rule(switcherCss, ".switcher__tab").get("padding"));
    const envbar = leftOf(rule(envbarCss, ".envbar").get("padding"));
    const paneTab = leftOf(rule(panesCss, ".pane-tab").get("padding"));
    expect(new Set([clusterTab, envbar, paneTab]).size).toBe(1);
  });

  it("leaves no stray margin on a cluster tab to push the first one off the gutter", () => {
    expect(rule(switcherCss, ".switcher__tab").has("margin")).toBe(false);
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
