import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { onThemeChanged } from "@openkaava/bridge/theme";
// Root-relative, which Vite resolves against the project root — the same
// palette the shell and the splash window draw from. An app is part of this
// product, not a guest in it, so it takes the tokens rather than restating
// them; a second copy of the palette is a second thing to forget to update.
import "/src/tokens.css";
import "/apps/shared/app.css";
// This app's own tokens (PRD §13) and shell styling (PRD §17 Wave 2) — see
// `./tokens.css` and `./shell/shell.css`'s own header comments. `App.tsx`
// imports the shell stylesheet directly, following `apps/files/ui`'s
// component-level pattern (`explorer/Explorer.tsx` imports its own CSS).
import "./tokens.css";

// Follows the shell's live theme and accent — see
// `packages/bridge/src/theme.ts`. This only stamps `data-theme` and the
// `--accent*` trio on `<html>`; Schematify's own `--kv-*` palette (PRD §13,
// `./tokens.css`) does not yet read either, so this is a no-op here until
// that file is rebuilt to react to them.
onThemeChanged();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
