import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Root-relative, which Vite resolves against the project root — the same
// palette the shell and the splash window draw from. An app is part of this
// product, not a guest in it, so it takes the tokens rather than restating
// them; a second copy of the palette is a second thing to forget to update.
import "/src/tokens.css";
import "/apps/shared/app.css";
import "./agents.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
