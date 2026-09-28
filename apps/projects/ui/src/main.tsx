import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Root-relative — the shell's own palette and chrome, not a copy of them.
// See `apps/agents/ui/src/main.tsx` for why these two imports are absolute.
import "/src/tokens.css";
import "/apps/shared/app.css";
import "./projects.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
