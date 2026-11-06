import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";
import { isCompactWindow } from "./appWindow";
import { hotkeysSuspended, registerShortcut, runShortcut, subscribeHotkeySuspension } from "./hotkeys";
import { buildNativeMenu } from "./nativeMenu";
import { subscribePrefs } from "./prefs";
import { getSessionStore, openProjectOverview, subscribeSessionStore } from "./sessions";
import { currentKeymap, isShortcutId, SHORTCUT_ACTIONS } from "./shortcuts";

// Serialize replacements, including across StrictMode mounts, so an older
// keymap can never finish after (and overwrite) a newer one.
let menuFlight = Promise.resolve();

export function dispatchNativeMenu(action: string) {
  if (hotkeysSuspended()) return;
  if (isShortcutId(action)) runShortcut(action);
  else if (action.startsWith("recent:")) {
    const path = action.slice("recent:".length);
    if (getSessionStore().projects.some((project) => project.path === path && !project.archived)) openProjectOverview(path);
  }
}

/** Listener first, then publish the menu; cleanup also covers an async listen still in flight. */
export function startNativeMenu(): () => void {
  let stopped = false;
  const cleanups: (() => void)[] = [];
  let previous = "";
  let inputs: { keymap: ReturnType<typeof currentKeymap>; projects: ReturnType<typeof getSessionStore>["projects"]; suspended: boolean } | null = null;
  const sync = () => {
    const keymap = currentKeymap();
    const projects = getSessionStore().projects;
    const suspended = hotkeysSuspended();
    // Streaming tab status changes do not change the native menu.
    if (inputs?.keymap === keymap && inputs.projects === projects && inputs.suspended === suspended) return;
    inputs = { keymap, projects, suspended };
    const groups = buildNativeMenu(keymap, projects, suspended);
    const next = JSON.stringify(groups);
    if (next === previous) return;
    previous = next;
    menuFlight = menuFlight.then(async () => {
      if (stopped) return;
      try {
        await invoke("set_native_menu", { groups });
      } catch (error) {
        previous = "";
        inputs = null;
        console.error("Native menu update failed", error);
      }
    });
  };
  void getCurrentWebviewWindow().listen<string>("native-menu-action", ({ payload }) => {
    if (!stopped) dispatchNativeMenu(payload);
  }).then((unlisten) => {
    if (stopped) { unlisten(); return; }
    cleanups.push(unlisten);
    if (isCompactWindow()) {
      // Native menus can carry only one accelerator. The ordinary dispatcher
      // handles every alternative binding and forwards workbench actions too.
      for (const action of SHORTCUT_ACTIONS) {
        if (action.menu && action.menu.target !== "focused") {
          cleanups.push(registerShortcut(action.id, () => {
            void invoke("forward_menu_action", { action: action.id }).catch((error) => console.error("Menu action forwarding failed", error));
          }));
        }
      }
      return;
    }
    cleanups.push(subscribePrefs(sync), subscribeSessionStore(sync), subscribeHotkeySuspension(sync));
    sync();
  }).catch((error) => console.error("Native menu listener failed", error));
  return () => { stopped = true; cleanups.forEach((cleanup) => cleanup()); };
}

/** Window actions share the ordinary shortcut dispatcher, in both shells. */
export function useNativeMenus() {
  useEffect(() => {
    if (!isTauri()) return;
    let zoom = 1;
    const failed = (error: unknown) => console.error("Window action failed", error);
    const changeZoom = (delta: number | null) => {
      zoom = delta === null ? 1 : Math.max(0.5, Math.min(2, Math.round((zoom + delta) * 10) / 10));
      void getCurrentWebviewWindow().setZoom(zoom).catch(failed);
    };
    const cleanups = [
      registerShortcut("app.newWindow", () => { void invoke("new_chat_window").catch(failed); }),
      registerShortcut("app.closeWindow", () => { void invoke("native_window_action", { action: "close" }).catch(failed); }),
      registerShortcut("app.fullscreen", () => { void invoke("native_window_action", { action: "fullscreen" }).catch(failed); }),
      registerShortcut("app.zoomIn", () => changeZoom(0.1)),
      registerShortcut("app.zoomOut", () => changeZoom(-0.1)),
      registerShortcut("app.zoomReset", () => changeZoom(null)),
      startNativeMenu(),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);
}
