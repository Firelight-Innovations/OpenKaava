/**
 * Every drawing style names an Excalidraw font family and the CSS name text is
 * measured in. A style whose face is not shipped, or is registered under another
 * name, would measure in one font and draw in a fallback, so labels overflow their
 * boxes. This holds the Rust table (`style.rs`), Excalidraw's own registry and the
 * `excalidrawFonts` plugin in `vite.config.ts` (which decides what ships) together.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const styles = [
  ...read("src-tauri/src/apps/canvas/style.rs")
    .split("pub static STYLES")[1]
    .matchAll(
      /id: "([a-z]+)",\s+name: "[^"]+",\s+summary: "[^"]+",[\s\S]*?font_family: (\d+),\s+font_name: "([^"]+)"/g,
    ),
].map(([, id, family, name]) => ({ id, family: Number(family), name }));

const excalidraw = resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod");
const chunks = readdirSync(excalidraw)
  .filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(resolve(excalidraw, f), "utf8"));
const library = chunks.find((c) => c.includes("EXCALIDRAW_ASSET_PATH")) ?? "";

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

  it.each(styles)("$id: Excalidraw knows family $family as $name", ({ family, name }) => {
    const registry = library.match(/Virgil:1,[^}]+\}/)?.[0] ?? "";
    const key = /^[A-Za-z]+$/.test(name) ? name : `"${name}"`;
    expect(registry).toContain(`${key}:${family}`);
    expect(registry).not.toMatch(new RegExp(`${key}:${family}[0-9]`));
  });

  it.each(styles)("$id: $name's files ship and are served from the asset path", ({ name }) => {
    const folder = FOLDER[name];
    expect(folder, `no folder recorded for ${name}`).toBeTruthy();
    const dir = resolve(excalidraw, "fonts", folder);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).some((f) => f.endsWith(".woff2"))).toBe(true);
    // The plugin skips only the CJK fallback; skipping a style's face would 404 it.
    const skipped = read("vite.config.ts").match(/const skip = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
    expect(skipped).not.toContain(folder);
    expect(library).toContain(`fonts/${folder}/`);
  });

  it("points Excalidraw at the bundled folder, not a CDN", () => {
    expect(read("apps/canvas/ui/src/assetPath.ts")).toContain('"/vendor/excalidraw/"');
  });
});
