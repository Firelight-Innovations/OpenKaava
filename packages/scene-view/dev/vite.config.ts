import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A stand-alone page for looking at `<SceneView>` before an app uses it:
 * `pnpm --filter @kaava/scene-view harness`. Not part of the app build and
 * not on port 1420, which belongs to `pnpm app`. `strictPort` is off, as it is
 * for `pnpm dev:agent`, so parallel agents step up instead of colliding.
 */
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  assetsInclude: ["**/*.glb"],
  server: {
    port: 1440,
    strictPort: false,
    fs: { allow: [resolve(here, "../../..")] },
  },
});
