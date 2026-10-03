/**
 * Every drawing style names an Excalidraw font family and the CSS name text is
 * measured in. A style whose face is not shipped, or is registered under another
 * name, would measure in one font and draw in a fallback, so labels overflow their
 * boxes. This holds the Rust table (`style.rs`), Excalidraw's own registry and the
 * `excalidrawFonts` plugin in `vite.config.ts` (which decides what ships) together.
 */
import { describe, expect, it } from "vitest";
// `?raw` and import.meta.glob rather than node:fs: the app tsconfig carries no
// Node types, so a node: import type-checks only where a stray node_modules leaks them in.
import styleRs from "../../../../src-tauri/src/apps/canvas/style.rs?raw";
import viteConfig from "../../../../vite.config.ts?raw";
import assetPath from "./assetPath.ts?raw";

const styles = [
  ...styleRs
    .split("pub static STYLES")[1]
    .matchAll(
      /id: "([a-z]+)",\s+name: "[^"]+",\s+summary: "[^"]+",[\s\S]*?font_family: (\d+),\s+font_name: "([^"]+)"/g,
    ),
].map(([, id, family, name]) => ({ id, family: Number(family), name }));

const chunks = Object.values(
  import.meta.glob<string>("../../../../node_modules/@excalidraw/excalidraw/dist/prod/*.js", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
const library = chunks.find((c) => c.includes("EXCALIDRAW_ASSET_PATH")) ?? "";

/** Every shipped face, by its path under Excalidraw's `fonts/` folder. */
const faces = Object.keys(
  import.meta.glob("../../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/*/*.woff2"),
);

/** The folder under `fonts/` that holds each face, as Excalidraw names its files. */
const FOLDER: Record<string, string> = {
  Nunito: "Nunito",
  Excalifont: "Excalifont",
  "Liberation Sans": "Liberation",
  "Comic Shanns": "ComicShanns",
};

describe("style fonts", () => {
  it("finds all four styles in the Rust table", () => {
    expect(styles.map((s) => s.id)).toEqual(["blueprint", "whiteboard", "minimal", "explainer"]);
  });

  it("reads Excalidraw's library and font files", () => {
    expect(library).not.toBe("");
    expect(faces.length).toBeGreaterThan(0);
  });

  it.each(styles)("$id: Excalidraw knows family $family as $name", ({ family, name }) => {
    const registry = library.match(/Virgil:1,[^}]+\}/)?.[0] ?? "";
    const key = /^[A-Za-z]+$/.test(name) ? name : `"${name}"`;
    expect(registry).toContain(`${key}:${family}`);
    expect(registry).not.toMatch(new RegExp(`${key}:${family}[0-9]`));
  });

  it.each(styles)("$id: $name's files ship and are served from the asset path", ({ name }) => {
    const folder = FOLDER[name];
    expect(folder, `no folder recorded for ${name}`).toBeTruthy();
    expect(faces.some((f) => f.includes(`/fonts/${folder}/`))).toBe(true);
    // The plugin skips only the CJK fallback; skipping a style's face would 404 it.
    const skipped = viteConfig.match(/const skip = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
    expect(skipped).not.toContain(folder);
    expect(library).toContain(`fonts/${folder}/`);
  });

  it("points Excalidraw at the bundled folder, not a CDN", () => {
    expect(assetPath).toContain('"/vendor/excalidraw/"');
  });
});
