import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { TitleBar } from "./components/TitleBar";
import { preventDefaultContextMenu } from "./lib/contextMenu";
import { preventFileNavigation } from "./lib/files";
import { applyAppearance } from "./lib/theme";
import "./styles.css";

applyAppearance();
preventFileNavigation();
// In development the menu stays, for "Inspect".
if (import.meta.env.PROD) preventDefaultContextMenu();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="window-frame">
      <TitleBar />
      <div className="window-content">
        <App />
      </div>
    </div>
  </React.StrictMode>,
);
