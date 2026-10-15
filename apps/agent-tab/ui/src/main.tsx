import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { onThemeChanged } from "@openkaava/bridge/theme";
// See apps/tutorial/ui/src/main.tsx for why these are root-relative imports
// rather than a copy of the palette.
import "/src/tokens.css";
import "/apps/shared/app.css";

// Follows the shell's live theme and accent (handoff §2.1.2).
onThemeChanged();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
