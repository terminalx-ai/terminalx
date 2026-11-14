import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Glass mode (the desktop tinted through the window) and macOS Reduce
 * transparency (PRO-336). WebKit does not implement
 * `prefers-reduced-transparency`, so the app reads the setting from AppKit
 * (src-tauri/src/transparency.rs): index.html stamps it before the first
 * paint from the global the native side installs, and this keeps it current
 * while the app runs.
 */

/** The event the native side sends when the setting changes, with its new value. */
export const REDUCE_TRANSPARENCY_CHANGED = "reduce_transparency_changed";

/** Glass on a Mac unless Reduce transparency is on; with it on, nothing blurs (app.css). */
export function applyReduceTransparency(root: HTMLElement, reduce: boolean, mac = navigator.platform.startsWith("Mac")) {
  root.toggleAttribute("data-reduce-transparency", reduce);
  root.toggleAttribute("data-glass", mac && !reduce);
}

/**
 * Follow the setting: ask once (a window opened after launch carries the
 * launch value in its global), then on every change.
 */
export function followReduceTransparency(root = document.documentElement) {
  const apply = (reduce: unknown) => {
    if (typeof reduce === "boolean") applyReduceTransparency(root, reduce);
  };
  void invoke<boolean>("reduce_transparency").then(apply, (error) => console.warn("read Reduce transparency", error));
  void listen<boolean>(REDUCE_TRANSPARENCY_CHANGED, (event) => apply(event.payload)).catch((error) => console.warn("follow Reduce transparency", error));
}
