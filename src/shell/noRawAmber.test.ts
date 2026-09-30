import { describe, expect, it } from "vitest";

/**
 * Nothing under `src/` or `apps/` may spell the amber accent as a literal —
 * `#d98a3f`, `rgb(217 138 63 …)`, `rgba(217, 138, 63, …)` — because a literal
 * ignores the accent setting. Use `var(--accent)` / `--accent-wash` /
 * `--accent-line` or `color-mix(in srgb, var(--accent) N%, transparent)`;
 * Monaco, which takes strings, reads the resolved value via
 * `accentThemeColors` in `@openkaava/bridge/theme`.
 *
 * Exempt: the token definitions in `src/tokens.css`, and tests, which need the
 * literal as a fixture.
 */
const files = import.meta.glob(
  ["../**/*.{css,ts,tsx}", "../../apps/**/*.{css,ts,tsx}", "!../../apps/**/node_modules/**"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const AMBER = /#d98a3f|#e39a55|217\s*[, ]\s*138\s*[, ]\s*63/i;
const EXEMPT = [/^\.\.\/tokens\.css$/, /\.test\.tsx?$/];

describe("no raw amber literals", () => {
  it("finds the sources it is meant to scan", () => {
    expect(Object.keys(files).length).toBeGreaterThan(100);
  });

  it("leaves every colour that should follow the accent to the token", () => {
    const offenders = Object.entries(files)
      .filter(([path]) => !EXEMPT.some((re) => re.test(path)))
      .filter(([, text]) => AMBER.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
