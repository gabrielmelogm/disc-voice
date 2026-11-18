import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyAppearance } from "./lib/theme";
import "./styles.css";

applyAppearance();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
