// @vitest-environment jsdom
//
// `splash.html` is standalone and cannot import `tokens.css`, so its copies of
// the tokens and its head script are checked from here. jsdom is for the script.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SPLASH_APPEARANCE_KEY,
  serializeSplashAppearance,
} from "../shell/settings/splashAppearance";
import splash from "../../splash.html?raw";
import tokens from "../tokens.css?raw";
import tauriConf from "../../src-tauri/tauri.conf.json?raw";

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
const SPLASH_ONLY = new Set(["--accent"]);

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

describe("splash.html lockup and band", () => {
  // The mark is drawn by the art now, so the old placeholder slot is gone; what
  // stands in for it is the SVG the art falls back to when it cannot draw.
  it("keeps the mark as an SVG fallback, hidden until the art gives up", () => {
    expect(splash).toMatch(/<svg class="splash__mark"[^>]*\shidden>/);
    expect(splash).not.toMatch(/class="splash__logo"/);
  });

  it("sets the wordmark as written, in a face that has the lowercase and the TM", () => {
    expect(splash).toContain(
      '<p class="splash__wordmark">OpenKaava<span class="splash__tm">™</span></p>',
    );
    const wordmark = /\.splash__wordmark \{([^}]*)\}/.exec(splash)?.[1] ?? "";
    expect(wordmark).not.toContain("text-transform");
    expect(splash).toMatch(/U\+0061-007A, U\+2122\s+the wordmark/);
  });

  // OpenKaava is the trademark; the company beside it is not.
  it("sets the company without a trademark sign", () => {
    expect(splash).toContain('<span class="splash__company">Veistra</span>');
  });

  // package.json is the one source of the version: tauri.conf.json reads it,
  // and getVersion() answers with what was compiled in. A number written into
  // the splash would be a second copy that check-version.mjs does not see.
  it("shows the app's own version rather than a number of its own", () => {
    expect(splash).toContain('<span class="splash__version"></span>');
    expect(splash).toMatch(/\.getVersion\(\)/);
    expect(splash).not.toMatch(/Version \d+\.\d+/);
    expect(JSON.parse(tauriConf).version).toBe("../package.json");
  });

  it("fetches nothing: no image, no stylesheet, no script by URL", () => {
    expect(splash).not.toMatch(/<img[\s>]/);
    expect(splash).not.toMatch(/<link[\s>]/);
    expect(splash).not.toMatch(/<script[^>]*\ssrc=/);
  });
});

describe("splash.html art", () => {
  const artScript = /<script id="splash-art">([\s\S]*?)<\/script>/.exec(splash)?.[1] ?? "";

  /** A 2D context that accepts every call and draws nothing. */
  const blankContext = new Proxy(
    {},
    { get: () => () => undefined, set: () => true },
  ) as unknown as CanvasRenderingContext2D;

  interface Art {
    working(step: number, total: number): void;
    finalizing(): void;
    ready(): void;
    fail(): void;
  }

  function mount(): Art {
    document.body.innerHTML = '<canvas class="splash__art"></canvas>';
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(blankContext);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
    return new Function(`${artScript}; return splashArt;`)() as Art;
  }

  it("is present", () => {
    expect(artScript).not.toBe("");
  });

  it("follows boot through every phase without throwing", () => {
    const art = mount();
    for (let step = 0; step <= 5; step++) art.working(step, 5);
    art.finalizing();
    art.ready();
  });

  it("stops on failure, and a total other than five is fine", () => {
    const art = mount();
    art.working(2, 3);
    art.fail();
    art.working(3, 3);
  });

  describe("the progress bar", () => {
    const barScript = /<script id="splash-bar">([\s\S]*?)<\/script>/.exec(splash)?.[1] ?? "";

    function mountBar(): Art {
      document.body.innerHTML = '<div class="splash__bar"><canvas></canvas></div>';
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(blankContext);
      vi.stubGlobal("requestAnimationFrame", () => 0);
      window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
      return new Function(`${barScript}; return splashBar;`)() as Art;
    }

    it("is present", () => {
      expect(barScript).not.toBe("");
    });

    it("follows boot through every phase, and stops on failure", () => {
      const bar = mountBar();
      for (let step = 0; step <= 5; step++) bar.working(step, 5);
      bar.finalizing();
      bar.ready();
      const failing = mountBar();
      failing.working(2, 3);
      failing.fail();
    });
  });
});
