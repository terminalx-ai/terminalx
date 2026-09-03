import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorMessage, type AccountStatus } from "@/lib/api";

interface AccountState {
  status: AccountStatus;
  ready: boolean;
  busy: boolean;
}

const signedOut: AccountStatus = {
  state: "signed-out",
  identity: null,
  expiresAt: null,
  lastError: null,
};

let state: AccountState = { status: signedOut, ready: false, busy: false };
const listeners = new Set<() => void>();
let refreshTimer: number | null = null;

function set(patch: Partial<AccountState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function applyStatus(status: AccountStatus) {
  set({ status, ready: true });
  scheduleRefresh(status);
}

function scheduleRefresh(status: AccountStatus) {
  if (typeof window === "undefined") return;
  if (refreshTimer != null) window.clearTimeout(refreshTimer);
  refreshTimer = null;
  if (status.state !== "signed-in" || status.expiresAt == null) return;

  const untilRefresh = status.expiresAt - Date.now() - 60_000;
  // An offline expired session remains visible and retries gently rather than
  // turning a transient network failure into a local sign-out.
  const delay = Math.min(Math.max(untilRefresh, 60_000), 2_147_000_000);
  refreshTimer = window.setTimeout(() => void refreshAccount(), delay);
}

export function useAccount(): AccountState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

let booted: Promise<void> | null = null;
export function bootAccount(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<AccountStatus>("account_status", (event) => applyStatus(event.payload));
      applyStatus(await api.accountStatus());
    } catch (error) {
      set({ status: { ...signedOut, lastError: errorMessage(error) }, ready: true });
    }
  })());
}

let statusFlight: Promise<void> | null = null;
export function refreshAccount(): Promise<void> {
  if (statusFlight) return statusFlight;
  return (statusFlight = api
    .accountStatus()
    .then(applyStatus)
    .catch((error) => set({ status: { ...state.status, lastError: errorMessage(error) }, ready: true }))
    .finally(() => {
      statusFlight = null;
      scheduleRefresh(state.status);
    }));
}

export async function signIn(): Promise<void> {
  set({ busy: true, status: { ...state.status, lastError: null } });
  try {
    applyStatus(await api.accountSignIn());
  } catch (error) {
    set({ status: { ...state.status, lastError: errorMessage(error) }, ready: true });
  } finally {
    set({ busy: false });
  }
}

export async function signOut(): Promise<void> {
  set({ busy: true });
  try {
    applyStatus(await api.accountSignOut());
  } catch (error) {
    set({ status: { ...state.status, lastError: errorMessage(error) } });
  } finally {
    set({ busy: false });
  }
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
