import { useSyncExternalStore } from "react";
import { devWorkspaceConnection, workspaceTargetKey, type CloudWorkspaceConnection } from "@/lib/api";
import { detachCloudTerminals, errorCode } from "@/lib/cloudTerminals";
import { getSessionStore, selectCloudWorkspace } from "@/lib/sessions";

/**
 * Debug builds only: one cloud session attached to a local
 * `terminalx-serve --relay-link` runtime by its pairing code. It is not an
 * organization's workspace and is in no catalog; the sidebar's Development
 * section opens it and the main slot shows it under {@link DEV_RUNTIME_KEY}.
 */
export const DEV_RUNTIME_KEY = "dev-runtime";

// Debug builds; off under the test runner, which is also a "dev" build, so
// every other test sees the sidebar a release build draws.
let available: boolean = import.meta.env.DEV && import.meta.env.MODE !== "test";

/** Whether this build offers the development runtime at all. */
export function devRuntimeAvailable(): boolean {
  return available;
}

/** Tests of the Development section turn it on. */
export function setDevRuntimeAvailable(next: boolean) {
  available = next;
}

let connection: CloudWorkspaceConnection | null = null;
const listeners = new Set<() => void>();

function set(next: CloudWorkspaceConnection | null) {
  connection = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDevRuntime(): CloudWorkspaceConnection | null {
  return connection;
}

export function useDevRuntime(): CloudWorkspaceConnection | null {
  return useSyncExternalStore(subscribe, getDevRuntime, () => null);
}

/** Attach by pairing code and show the runtime; the error code is thrown for the caller to show. */
export async function attachDevRuntime(pairingCode: string): Promise<void> {
  if (!available) throw Object.assign(new Error("debug builds only"), { code: "dev_runtime_unavailable" });
  let next: CloudWorkspaceConnection;
  try {
    next = await devWorkspaceConnection(pairingCode.trim());
  } catch (error) {
    throw Object.assign(new Error(errorCode(error)), { code: errorCode(error) });
  }
  detachDevRuntime();
  set(next);
  selectCloudWorkspace(DEV_RUNTIME_KEY);
}

/** Close the connection; the runtime and its shells keep running where they are. */
export function detachDevRuntime() {
  const current = connection;
  if (!current) return;
  detachCloudTerminals(workspaceTargetKey(current.target));
  current.close();
  set(null);
  if (getSessionStore().selectedCloudWorkspace === DEV_RUNTIME_KEY) selectCloudWorkspace(null);
}
