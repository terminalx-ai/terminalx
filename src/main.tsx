import { bootDataPrivacy } from "./lib/dataPrivacy";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/app.css";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import { keepShellUnscrolled } from "./lib/shellScroll";
import { installAppContextMenu } from "./lib/contextMenu";
import { bootSettingsFile } from "./lib/settingsFile";

window.addEventListener("error", (e) => {
  void invoke("frontend_log", { level: "error", message: `${e.message} @ ${e.filename}:${e.lineno}` }).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  void invoke("frontend_log", { level: "error", message: `unhandled: ${String(e.reason?.message ?? e.reason)} ${String(e.reason?.stack ?? "").split("\n")[1] ?? ""}` }).catch(() => {});
});

keepShellUnscrolled();
installAppContextMenu();
// Finish the migration before controls can save a new choice, so its reply
// cannot replace a choice made while the old localStorage copy was in flight.
void bootDataPrivacy().then(() => bootSettingsFile()).then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
