import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { floatingWindow, type FloatingStatus, type OpenTarget } from "@/lib/api";
import { isFloatingWindow } from "@/lib/appWindow";

/**
 * The floating chat window, as either window sees it: its settings, whether
 * its system-wide shortcut is registered, whether it is on screen, and which
 * session it shows.
 *
 * The settings are the backend's (it registers the shortcut and makes the
 * window), so both windows mirror them from one event. The session the
 * floating window shows is its own choice; it is written where the main
 * window can read it, so a notification for that session can bring the
 * reader back to the window that has it.
 */
interface State {
  status: FloatingStatus | null;
  /** The floating window is on screen. Only meaningful in the floating window itself. */
  visible: boolean;
  /** The session the floating window shows, in whichever window asks. */
  sessionId: string | null;
}

const SESSION_KEY = "raccoon.floating.session";

function storedSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY) || null;
  } catch {
    return null;
  }
}

let state: State = { status: null, visible: true, sessionId: storedSession() };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function useFloating(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export function getFloating(): State {
  return state;
}

export function subscribeFloating(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The floating window records the session it shows (`null`: the start screen). */
export function setFloatingSession(sessionId: string | null) {
  if (state.sessionId === sessionId) return;
  try {
    if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: this window still knows */
  }
  set({ sessionId });
}

if (typeof window !== "undefined") {
  // The other window changed it.
  window.addEventListener("storage", (event) => {
    if (event.key === SESSION_KEY && event.storageArea === localStorage) set({ sessionId: event.newValue || null });
  });
}

let booted: Promise<void> | null = null;

/**
 * Mirror the window's settings. In the floating window, `onOpen` is called
 * with each session it is asked to show: one asked for before this page had
 * loaded, then every later request.
 */
export function bootFloating(onOpen?: (target: OpenTarget) => void): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<FloatingStatus>("floating_status", (event) => set({ status: event.payload }));
      if (isFloatingWindow()) {
        await listen<boolean>("floating_visible", (event) => set({ visible: event.payload }));
        if (onOpen) await listen<OpenTarget>("floating_open", (event) => onOpen(event.payload));
      }
      set({ status: await floatingWindow.status() });
      if (isFloatingWindow()) {
        set({ visible: await floatingWindow.visible() });
        const pending = await floatingWindow.takePending();
        if (pending && onOpen) onOpen(pending);
      }
    } catch {
      /* outside a webview */
    }
  })());
}

/** Change the window's settings. Rejects, leaving them as they were, when a shortcut cannot be registered at all. */
export async function saveFloatingSettings(patch: { shortcut?: string; alwaysOnTop?: boolean; retentionDays?: number }): Promise<FloatingStatus> {
  const status = await floatingWindow.setSettings(patch);
  set({ status });
  return status;
}

/** Show the floating window, on a session when one is named. */
export function showFloatingWindow(sessionId?: string | null, tabId?: string | null): Promise<void> {
  return floatingWindow.show(sessionId, tabId);
}

export function hideFloatingWindow(): Promise<void> {
  return floatingWindow.hide();
}

/** Tests only. */
export function resetFloating(patch: Partial<State> = {}) {
  booted = null;
  state = { status: null, visible: true, sessionId: null, ...patch };
  for (const listener of listeners) listener();
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
