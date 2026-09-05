import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { browser as browserApi, type BrowserPage } from "@/lib/api";
import { clearSelectedBrowser, setSelectedBrowser } from "@/lib/terminal";

/**
 * The built-in browser's pages, mirrored from the backend page store. The
 * backend is the source of truth: it owns the agent-browser sessions and
 * reconciles with the Chromium window, and announces every change through
 * `browser_pages_changed`. Screencast frames are kept out of the React store
 * (a frame a second per page would re-render everything) and delivered to
 * the one view that asked for them.
 */
export type ScreencastState = "starting" | "live" | "ended" | "error";

export interface BrowserState {
  loaded: boolean;
  pages: BrowserPage[];
  screencast: Record<string, { state: ScreencastState; message?: string }>;
}

export interface Frame {
  data: string;
  width: number;
  height: number;
}

let state: BrowserState = { loaded: false, pages: [], screencast: {} };
const listeners = new Set<() => void>();
function set(patch: Partial<BrowserState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useBrowser(): BrowserState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

export function getBrowserState(): BrowserState {
  return state;
}

/**
 * Pages of one workspace. The backend stores canonical paths; a session's cwd
 * is normally already canonical, and a path that resolved differently on the
 * backend still matches by its trailing segments.
 */
export function pagesFor(pages: BrowserPage[], cwd: string): BrowserPage[] {
  return pages.filter((page) => page.workspacePath != null && sameWorkspace(page.workspacePath, cwd));
}

export function sameWorkspace(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (p: string) => p.replace(/\/+$/, "").replace(/^\/private(?=\/)/, "");
  return strip(a) === strip(b);
}

const frameListeners = new Map<string, Set<(frame: Frame) => void>>();
const lastFrames = new Map<string, Frame>();

export function subscribeFrames(pageId: string, cb: (frame: Frame) => void): () => void {
  let set = frameListeners.get(pageId);
  if (!set) frameListeners.set(pageId, (set = new Set()));
  set.add(cb);
  const last = lastFrames.get(pageId);
  if (last) cb(last);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) frameListeners.delete(pageId);
  };
}

export function lastFrame(pageId: string): Frame | undefined {
  return lastFrames.get(pageId);
}

function receivePages(pages: BrowserPage[]) {
  const ids = new Set(pages.map((page) => page.id));
  const screencast = { ...state.screencast };
  for (const id of Object.keys(screencast)) if (!ids.has(id)) delete screencast[id];
  for (const id of [...lastFrames.keys()]) if (!ids.has(id)) lastFrames.delete(id);
  set({ loaded: true, pages, screencast });
}

let booted: Promise<void> | null = null;
export function bootBrowser(): Promise<void> {
  return (booted ??= boot());
}

async function boot() {
  try {
    receivePages(await browserApi.pages());
  } catch {
    set({ loaded: true });
  }
  try {
    await listen<{ pages: BrowserPage[] }>("browser_pages_changed", (e) => receivePages(e.payload.pages));
    await listen<{ pageId: string; data: string; width: number; height: number }>("browser_frame", (e) => {
      const { pageId, data, width, height } = e.payload;
      const frame = { data, width, height };
      lastFrames.set(pageId, frame);
      const subs = frameListeners.get(pageId);
      if (subs) for (const cb of subs) cb(frame);
    });
    await listen<{ pageId: string; state: ScreencastState; message?: string }>("browser_screencast_state", (e) => {
      const { pageId, state: next, message } = e.payload;
      set({ screencast: { ...state.screencast, [pageId]: { state: next, message } } });
    });
  } catch {
    /* outside a webview */
  }
}

export async function refreshBrowserPages() {
  receivePages(await browserApi.pages());
}

/** Open a page in the session's workspace and select it. */
export async function openBrowserTab(sessionId: string, cwd: string, url?: string | null): Promise<string> {
  await bootBrowser();
  const opened = await browserApi.openTab(cwd, url ?? null);
  setSelectedBrowser(sessionId, opened.browserPageId);
  return opened.browserPageId;
}

export async function closeBrowserPage(sessionId: string, pageId: string) {
  clearSelectedBrowser(sessionId, pageId);
  await browserApi.closePage(pageId);
}

/** Select a page in the app; `focus` also raises its Chromium window. */
export async function activateBrowserPage(sessionId: string, pageId: string, focus = false) {
  setSelectedBrowser(sessionId, pageId);
  await browserApi.activatePage(pageId, focus).catch((error) => console.error("browser activate failed", error));
}

export async function navigateBrowserPage(pageId: string, action: "goto" | "back" | "forward" | "reload", url?: string | null) {
  return browserApi.navigate(pageId, action, url ?? null);
}

export async function setScreencast(pageId: string, live: boolean) {
  if (live) set({ screencast: { ...state.screencast, [pageId]: { state: "starting" } } });
  try {
    await browserApi.screencast(pageId, live);
    if (!live) set({ screencast: { ...state.screencast, [pageId]: { state: "ended" } } });
  } catch (error) {
    set({ screencast: { ...state.screencast, [pageId]: { state: "error", message: error instanceof Error ? error.message : String(error) } } });
  }
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
