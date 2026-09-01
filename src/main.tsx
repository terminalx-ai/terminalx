import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/app.css";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";

window.addEventListener("error", (e) => {
  void invoke("frontend_log", { level: "error", message: `${e.message} @ ${e.filename}:${e.lineno}` }).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  void invoke("frontend_log", { level: "error", message: `unhandled: ${String(e.reason?.message ?? e.reason)} ${String(e.reason?.stack ?? "").split("\n")[1] ?? ""}` }).catch(() => {});
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
