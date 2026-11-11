import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export const PRIVACY_MESSAGE = "Turned off by data privacy mode";
export interface DataPrivacy { enabled: boolean; managed: boolean; ready: boolean; error?: string }

// Startup waits for the native policy before starting account/cloud work.
// Native transports enforce it independently, including before the webview.
let state: DataPrivacy = { enabled: false, managed: false, ready: false };
const listeners = new Set<() => void>();
let generation = 0;
let writing = false;
export const getDataPrivacy = () => state;
export const privacyEnabled = () => state.enabled;
export function subscribeDataPrivacy(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useDataPrivacy = () => useSyncExternalStore(subscribeDataPrivacy, getDataPrivacy, getDataPrivacy);

function apply(value: Omit<DataPrivacy, "ready">) {
  if (typeof value?.enabled !== "boolean" || typeof value?.managed !== "boolean") throw new Error("Could not read data privacy mode");
  if (state.ready && value.enabled === state.enabled && value.managed === state.managed && value.error === state.error) return;
  state = { ...value, ready: true };
  for (const listener of listeners) listener();
}

export async function refreshDataPrivacy() {
  if (writing) return;
  const asked = ++generation;
  try {
    const value = await invoke<Omit<DataPrivacy, "ready">>("data_privacy_status");
    if (asked === generation) apply(value);
  } catch (error) {
    if (asked === generation) unavailable(error);
  }
}

function unavailable(error: unknown) {
  // Gate UI actions, but do not represent an unknown native policy as applied.
  state = { enabled: true, managed: state.managed, ready: false, error: `Could not verify data privacy mode: ${String(error)}` };
  for (const listener of listeners) listener();
}

export async function setDataPrivacy(enabled: boolean) {
  if (writing) return;
  writing = true;
  ++generation;
  try {
    apply(await invoke<Omit<DataPrivacy, "ready">>("data_privacy_set", { enabled }));
  } catch (error) {
    unavailable(error);
    throw error;
  } finally {
    writing = false;
  }
}

let booted: Promise<void> | null = null;
export function bootDataPrivacy() {
  return (booted ??= refreshDataPrivacy().then(() => {
    // Profiles can change while the app is running, including while unfocused.
    window.addEventListener("focus", () => void refreshDataPrivacy());
    window.setInterval(() => void refreshDataPrivacy(), 2_000);
  }));
}

/** Prevent even a queued UI action from reaching a disabled feature. */
export function privacyBlocksCommand(command: string): boolean {
  if (!privacyEnabled()) return false;
  if (["account_status", "account_sign_out", "pairing_status", "cloud_remote_detach", "cloud_port_unforward", "session_guest_leave", "cloud_catalog_load", "cloud_catalog_save"].includes(command)) return false;
  return /^(account_|organization_|cloud_|pairing_|session_share|session_join|session_guest|guest_)/.test(command);
}
