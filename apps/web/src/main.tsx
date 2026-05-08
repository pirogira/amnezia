import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="app-shell">
      <App />
    </div>
  </React.StrictMode>,
);
