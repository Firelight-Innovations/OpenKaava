/**
 * The workspace `focus` probe cuts the selection in the page, and the page is
 * the only place a cut can split a surrogate pair: `JSON.stringify` then writes
 * the lone half as `\ud83d` and the backend refuses the page's whole answer.
 * The helper lives in a Rust string, so this reads it out of the source and
 * runs it, rather than trusting a one-off run in a shell.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("../src-tauri/src/mcp/servers/workspace.rs", import.meta.url),
  "utf8",
);

const helper = SOURCE.match(/const SELECTION_CAP = \d+;\nconst cutSelection = [\s\S]*?\n\};/);

/** The probe's own `SELECTION_CAP` and `cutSelection`, as the page runs them. */
const { cap, cutSelection } = new Function(
  `${helper?.[0] ?? ""}\nreturn { cap: SELECTION_CAP, cutSelection };`,
)();

describe("the focus probe's selection cut", () => {
  it("is found in the probe, and the probe uses it", () => {
    expect(helper).not.toBeNull();
    expect(SOURCE).toContain("selectedText: cutSelection(text),");
    expect(SOURCE).not.toMatch(/text\.slice\(0, 2000\)/);
  });

  it("leaves a selection at or under the cap whole", () => {
    expect(cutSelection("short")).toBe("short");
    const exact = "a".repeat(cap);
    expect(cutSelection(exact)).toBe(exact);
  });

  it("cuts a plain run of text at the cap", () => {
    expect(cutSelection("a".repeat(cap + 50))).toHaveLength(cap);
  });

  it("backs off a pair whose high half would be the last unit kept", () => {
    const text = `${"a".repeat(cap - 1)}😀tail`;
    const cut = cutSelection(text);
    expect(cut).toHaveLength(cap - 1);
    expect(cut.isWellFormed()).toBe(true);
    expect(JSON.parse(JSON.stringify({ cut })).cut).toBe(cut);
  });

  it("keeps a pair that ends exactly at the cap", () => {
    const text = `${"a".repeat(cap - 2)}😀tail`;
    const cut = cutSelection(text);
    expect(cut).toHaveLength(cap);
    expect(cut.isWellFormed()).toBe(true);
    expect(cut.endsWith("😀")).toBe(true);
  });

  it("never writes a lone surrogate into the JSON the backend parses", () => {
    for (let pad = cap - 4; pad <= cap + 1; pad += 1) {
      const text = `${"a".repeat(pad)}😀😀😀`;
      expect(JSON.stringify({ selectedText: cutSelection(text) })).not.toMatch(/\\ud[89ab]/i);
    }
  });
});
