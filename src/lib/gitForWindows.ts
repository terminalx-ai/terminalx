import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";
import { inAppWindow, isCompactWindow } from "./appWindow";
import { showError } from "./errorToasts";
import { isWindows } from "./platform";

export const GIT_FOR_WINDOWS_URL = "https://git-scm.com/download/win";

/**
 * On Windows, says once at start when Git for Windows is missing: git itself, and the `sh.exe` that setup, archive
 * and action scripts run in, come with it. Each of those still says so when it is run; this says it before.
 */
export async function checkGitForWindows(windows = isWindows): Promise<boolean> {
  if (!windows) return false;
  const missing = await invoke<boolean>("posix_shell_missing").catch(() => false);
  if (missing) {
    showError("TerminalX works in git repositories, and its setup and action scripts run in the sh.exe that comes with Git for Windows. Neither was found on this PC.", undefined, {
      title: "Install Git for Windows",
      tone: "warning",
      key: "git-for-windows",
      copy: false,
      actions: [{ label: "Download Git for Windows", icon: "external", primary: true, keepOpen: true, run: () => openUrl(GIT_FOR_WINDOWS_URL) }],
    });
  }
  return missing;
}

/** The main window runs the check once, when it starts. */
export function useGitForWindowsCheck() {
  useEffect(() => {
    if (!inAppWindow() || isCompactWindow()) return;
    void checkGitForWindows();
  }, []);
}
