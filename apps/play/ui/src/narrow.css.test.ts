import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the app tsconfig carries no Node types.
import play from "./App.css?raw";
import footer from "../../../shared/send-footer.css?raw";

/**
 * Structure checks for the narrow-pane layout. jsdom does no layout, so these
 * pin the declarations that keep headers and footers from overlapping.
 */
function rule(css: string, selector: string): string {
  // The last rule for the selector: a shared group rule may come first.
  const at = css.lastIndexOf(`\n${selector} {`);
  expect(at, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("narrow panes", () => {
  it("Play header wraps and never clips the badge or state pill", () => {
    expect(rule(play, ".pl__header")).toContain("flex-wrap: wrap");
    expect(rule(play, ".pl__badge")).toContain("flex-shrink: 0");
    expect(rule(play, ".pl__pill")).toContain("white-space: nowrap");
  });

  it("Play footer buttons keep their labels on one line", () => {
    expect(rule(play, ".pl__footer-btn")).toContain("white-space: nowrap");
    expect(rule(play, ".pl__footer-time")).toContain("white-space: nowrap");
  });

  it("Play log breaks at words, not at every character", () => {
    const line = rule(play, ".pl__line");
    expect(line).not.toContain("anywhere");
    expect(line).toContain("overflow-wrap: break-word");
    expect(rule(play, ".pl__log")).toContain("overflow: auto");
  });

  it("the shared footer wraps its groups instead of overlapping them", () => {
    expect(rule(footer, ".k-send-footer")).toContain("flex-wrap: wrap");
    expect(rule(footer, ".k-send-footer__trailing")).toContain("flex-wrap: wrap");
  });
});
