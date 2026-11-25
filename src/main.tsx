import { bootDataPrivacy } from "./lib/dataPrivacy";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/app.css";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import { keepShellUnscrolled } from "./lib/shellScroll";
import { installAppContextMenu } from "./lib/contextMenu";
import { bootSettingsFile } from "./lib/settingsFile";
import { followReduceTransparency } from "./lib/glass";
import { startDraftPersistence } from "./lib/draftPersistence";
import { AppErrorScreen, ErrorBoundary } from "./components/ErrorBoundary";

window.addEventListener("error", (e) => {
  void invoke("frontend_log", { level: "error", message: `${e.message} @ ${e.filename}:${e.lineno}` }).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  void invoke("frontend_log", { level: "error", message: `unhandled: ${String(e.reason?.message ?? e.reason)} ${String(e.reason?.stack ?? "").split("\n")[1] ?? ""}` }).catch(() => {});
});

keepShellUnscrolled();
followReduceTransparency();
installAppContextMenu();
// Finish the migration before controls can save a new choice, so its reply
// cannot replace a choice made while the old localStorage copy was in flight.
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
void bootDataPrivacy().then(() => bootSettingsFile()).then(() => {
  void startDraftPersistence();
  root.render(
    <React.StrictMode>
      <ErrorBoundary label="TerminalX" fallback={(error) => <AppErrorScreen error={error} />}>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}).catch((error: unknown) => {
  // A boot step that failed would otherwise leave the window blank for good.
  void invoke("frontend_log", { level: "error", message: `startup failed: ${String((error as Error | undefined)?.stack ?? error)}` }).catch(() => {});
  root.render(<AppErrorScreen error={error} />);
});
