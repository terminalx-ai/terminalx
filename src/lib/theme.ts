import { useSyncExternalStore } from "react";

export type ThemeId = "den" | "slate" | "moss" | "ember";
export type Mode = "system" | "light" | "dark";
export type ResolvedMode = "light" | "dark";

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  darkOnly?: boolean;
}

export const THEMES: ThemeInfo[] = [
  { id: "den", name: "Den" },
  { id: "slate", name: "Slate" },
  { id: "moss", name: "Moss" },
  { id: "ember", name: "Ember", darkOnly: true },
];

export const DEFAULT_THEME: ThemeId = "den";

const THEME_KEY = "raccoon.theme";
const MODE_KEY = "raccoon.mode";

export function coerceTheme(value: unknown): ThemeId {
  return THEMES.some((t) => t.id === value) ? (value as ThemeId) : DEFAULT_THEME;
}

export function coerceMode(value: unknown): Mode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function hasLightMode(id: ThemeId): boolean {
  return !THEMES.find((t) => t.id === id)?.darkOnly;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

interface ThemeState {
  theme: ThemeId;
  mode: Mode;
  resolvedMode: ResolvedMode;
}

const media =
  typeof window !== "undefined" && "matchMedia" in window
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function systemMode(): ResolvedMode {
  return media?.matches ? "dark" : "light";
}

export function resolveMode(theme: ThemeId, mode: Mode): ResolvedMode {
  if (!hasLightMode(theme)) return "dark";
  return mode === "system" ? systemMode() : mode;
}

let state: ThemeState = (() => {
  const theme = coerceTheme(readStorage(THEME_KEY));
  const mode = coerceMode(readStorage(MODE_KEY));
  return { theme, mode, resolvedMode: resolveMode(theme, mode) };
})();

const listeners = new Set<() => void>();

function apply() {
  const root = document.documentElement;
  root.setAttribute("data-theme", state.theme);
  root.setAttribute("data-mode", state.resolvedMode);
}

let nativeTheme: ((t: "light" | "dark" | null) => void) | null = null;
// Hand the native window material the app's own appearance so a light palette
// never composites over a dark blur. `null` hands control back to the OS, which
// is what keeps System mode following the OS for prefers-color-scheme.
import("@tauri-apps/api/window")
  .then((m) => {
    nativeTheme = (t) => {
      try {
        void m.getCurrentWindow().setTheme(t);
      } catch {
        /* not in a webview */
      }
    };
    syncNative();
  })
  .catch(() => {});

function syncNative() {
  nativeTheme?.(state.mode === "system" ? null : state.resolvedMode);
}

function emit() {
  apply();
  syncNative();
  for (const l of listeners) l();
}

export function setTheme(theme: ThemeId) {
  state = { ...state, theme, resolvedMode: resolveMode(theme, state.mode) };
  writeStorage(THEME_KEY, theme);
  emit();
}

export function setMode(mode: Mode) {
  state = { ...state, mode, resolvedMode: resolveMode(state.theme, mode) };
  writeStorage(MODE_KEY, mode);
  emit();
}

media?.addEventListener("change", () => {
  if (state.mode !== "system") return;
  state = { ...state, resolvedMode: resolveMode(state.theme, state.mode) };
  emit();
});

if (typeof document !== "undefined") apply();

export function useTheme(): ThemeState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}
