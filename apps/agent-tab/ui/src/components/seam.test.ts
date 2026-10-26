/**
 * The rule that keeps a swap to one line: a component reaches another only
 * through `useSlots()`, never by importing it, and no component talks to the
 * host. Checked on the source, since a direct import still renders fine.
 *
 * The source is read through `import.meta.glob`, not `node:fs`: the app's
 * tsconfig has no Node types, and CI has none to lend it.
 */
import { describe, expect, it } from "vitest";
import { defaultSlots } from "./registry";

const sources = import.meta.glob(["./*.tsx", "!./*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const modules = import.meta.glob(["./*.tsx", "!./*.test.tsx"], { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

/** Each component file, by name, with its source. */
const components = Object.entries(sources)
  .map(([path, source]) => [path.slice(2), source] as const)
  .filter(([file]) => file !== "registry.tsx");

/** Local imports a component may make: the registry, its types, its CSS. */
const ALLOWED = /^\.\/(registry|types|[\w-]+\.css)$/;

describe("components", () => {
  it.each(components)("%s imports no sibling component and no RPC", (_file, source) => {
    const imports = [...source.matchAll(/from\s+"([^"]+)"|import\s+"([^"]+)"/g)].map(
      (m) => m[1] ?? m[2],
    );
    const siblings = imports.filter((path) => path.startsWith("./") && !ALLOWED.test(path));
    expect(siblings).toEqual([]);
    const host = imports.filter((path) => /rpc|@veistra\/bridge|\/model$/.test(path));
    expect(host).toEqual([]);
  });

  it("are all in the registry", () => {
    const registry = sources["./registry.tsx"];
    expect(registry).toBeTruthy();
    expect(components.length).toBeGreaterThan(0);
    for (const [file] of components) {
      expect(registry, file).toContain(`from "./${file.replace(/\.tsx$/, "")}"`);
    }
  });

  it("are all mapped by a slot in defaultSlots", () => {
    const mapped = new Set<unknown>(Object.values(defaultSlots));
    for (const [file] of components) {
      const exported = Object.values(modules[`./${file}`] ?? {});
      expect(
        exported.some((value) => mapped.has(value)),
        file,
      ).toBe(true);
    }
  });
});
