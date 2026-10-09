/**
 * Which window of the app this page is.
 *
 * The app has two: `main`, the workbench, and `floating`, the compact chat
 * window. Both load the same page and the same stores, and the backend is the
 * source of truth for both. What differs is the shell drawn around a session,
 * and which window owns the things there must be only one of (the dock badge,
 * desktop banners).
 */
export type AppWindow = "main" | "floating";

interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } };
}

function read(): AppWindow {
  if (typeof window === "undefined") return "main";
  // Tauri stamps the label before any script runs, so this is known at once.
  const label = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (label) return label === "floating" ? "floating" : "main";
  // Outside Tauri (a browser preview, a test) the page can say which it is.
  try {
    return new URLSearchParams(window.location.search).get("window") === "floating" ? "floating" : "main";
  } catch {
    return "main";
  }
}

let current: AppWindow | null = null;

export function appWindow(): AppWindow {
  return (current ??= read());
}

export function isFloatingWindow(): boolean {
  return appWindow() === "floating";
}

/** Tests only: pretend to be a window, or read it again with `null`. */
export function setAppWindowForTest(label: AppWindow | null) {
  current = label;
}
