import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// See apps/tutorial/ui/src/main.tsx for why these are root-relative imports
// rather than a copy of the palette.
import "/src/tokens.css";
import "/apps/shared/app.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
