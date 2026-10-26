import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    // Fixed and strict so this never silently drifts onto the orchestrator's
    // own dev server port (1420) if that one's busy — veistra-tool.toml's
    // `dev-url` points at this exact port.
    port: 5174,
    strictPort: true,
  },
});
