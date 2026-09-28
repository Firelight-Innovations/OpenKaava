import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { onThemeChanged } from "@openkaava/bridge/theme";
// Root-relative — the shell's own palette and chrome, not a copy of them.
// See `apps/agents/ui/src/main.tsx` for why these two imports are absolute.
import "/src/tokens.css";
import "/apps/shared/app.css";
import "./projects.css";

// Follows the shell's live theme and accent — see
// `packages/bridge/src/theme.ts`. Called once, at module scope, so it is
// already listening by the time the bridge's `hello` handshake completes.
onThemeChanged();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
