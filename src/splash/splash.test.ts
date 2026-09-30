// @vitest-environment jsdom
//
// `splash.html` is standalone and cannot import `tokens.css`, so its copies of
// the tokens and its head script are checked from here. jsdom is for the script.
import { beforeEach, describe, expect, it } from "vitest";
import {
  SPLASH_APPEARANCE_KEY,
  serializeSplashAppearance,
} from "../shell/settings/splashAppearance";
import splash from "../../splash.html?raw";
import tokens from "../tokens.css?raw";

/** The `--name: value` declarations of the first block whose selector is `selector`. */
function declarations(css: string, selector: string): Map<string, string> {
  const start = css.search(new RegExp(`^\\s*${selector.replace(/[[\]"]/g, "\\$&")} \\{`, "m"));
  expect(start, `no ${selector} block`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start) + 1;
  const body = css.slice(open, open + css.slice(open).search(/^\s*\}\s*$/m));
  const map = new Map<string, string>();
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) map.set(m[1], m[2].trim());
  return map;
}

/** Tokens the splash defines on its own account and that `tokens.css` has no entry for. */
const SPLASH_ONLY = new Set(["--accent", "--art-base", "--art-rot", "--art-tail", "--ground"]);

describe.each([":root", ':root[data-theme="light"]'])("splash.html tokens under %s", (selector) => {
  it("match tokens.css", () => {
    const copied = declarations(splash, selector);
    const source = declarations(tokens, selector);
    expect(copied.size).toBeGreaterThan(10);
    for (const [name, value] of copied) {
      if (SPLASH_ONLY.has(name)) continue;
      // The light block only restates what differs; a name it omits inherits from `:root`.
      const expected = source.get(name) ?? declarations(tokens, ":root").get(name);
      expect(value, name).toBe(expected);
    }
  });
});

describe("splash.html head script", () => {
  const script = /<script id="splash-appearance">([\s\S]*?)<\/script>/.exec(splash)?.[1] ?? "";

  function run(stored: string | null): DOMStringMap {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-accent");
    if (stored === null) localStorage.removeItem(SPLASH_APPEARANCE_KEY);
    else localStorage.setItem(SPLASH_APPEARANCE_KEY, stored);
    new Function(script)();
    return document.documentElement.dataset;
  }

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("light"),
    })) as unknown as typeof window.matchMedia;
  });

  it("is present", () => {
    expect(script).not.toBe("");
  });

  it("applies what the shell's writer stores", () => {
    const dataset = run(serializeSplashAppearance("light", "blue"));
    expect(dataset.theme).toBe("light");
    expect(dataset.accent).toBe("blue");
  });

  it("resolves a stored 'system' against the OS", () => {
    expect(run(serializeSplashAppearance("system", "green")).theme).toBe("light");
  });

  it("leaves dark and neutral when nothing valid is stored", () => {
    for (const stored of [null, "not json", JSON.stringify({ theme: "dark", accent: "#d98a3f" })]) {
      const dataset = run(stored);
      expect(dataset.theme).toBeUndefined();
      expect(dataset.accent).toBeUndefined();
    }
  });
});
