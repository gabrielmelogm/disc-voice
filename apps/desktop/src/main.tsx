import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { TitleBar } from "./components/TitleBar";
import { applyAppearance } from "./lib/theme";
import "./styles.css";

applyAppearance();

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
