import { defineConfig } from "vitest/config";

/**
 * Node, not jsdom. three's maths, scene graph and geometry classes need no
 * DOM, and everything that needs WebGL is kept out of the tested modules on
 * purpose (see `engine.ts`), so a test that reaches for `window` is a sign the
 * logic leaked into the wrong file.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
