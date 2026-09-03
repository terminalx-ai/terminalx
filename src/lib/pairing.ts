import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorMessage } from "@/lib/api";
import type { PairingConnectionMode, PairingStatus } from "@/types/pairing";

interface PairingState {
  status: PairingStatus;
  ready: boolean;
  busy: boolean;
}

const emptyStatus: PairingStatus = {
  relay: { phase: "off", message: null, attempt: 0 },
  host: null,
  devices: [],
  activePairing: null,
  lastError: null,
};

let state: PairingState = { status: emptyStatus, ready: false, busy: false };
const listeners = new Set<() => void>();

function set(patch: Partial<PairingState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function applyStatus(status: PairingStatus) {
  set({ status, ready: true });
}

export function usePairing(): PairingState {
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
export function bootPairing(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<PairingStatus>("pairing_status", (event) => applyStatus(event.payload));
      applyStatus(await api.pairingStatus());
    } catch (error) {
      set({ status: { ...emptyStatus, lastError: errorMessage(error) }, ready: true });
    }
  })());
}

export async function generatePairing(connectionMode: PairingConnectionMode): Promise<void> {
  set({ busy: true, status: { ...state.status, lastError: null } });
  try {
    applyStatus(await api.pairingGenerate(connectionMode));
  } catch (error) {
    const message = errorMessage(error);
    try {
      const status = await api.pairingStatus();
      set({ status: { ...status, lastError: message }, ready: true });
    } catch {
      set({ status: { ...state.status, lastError: message } });
    }
  } finally {
    set({ busy: false });
  }
}

export async function revokePairing(deviceId: string): Promise<void> {
  set({ busy: true, status: { ...state.status, lastError: null } });
  try {
    applyStatus(await api.pairingRevoke(deviceId));
  } catch (error) {
    set({ status: { ...state.status, lastError: errorMessage(error) } });
  } finally {
    set({ busy: false });
  }
}

export async function setPairingHostName(displayName: string): Promise<void> {
  set({ busy: true, status: { ...state.status, lastError: null } });
  try {
    applyStatus(await api.pairingSetHostName(displayName));
  } catch (error) {
    set({ status: { ...state.status, lastError: errorMessage(error) } });
    throw error;
  } finally {
    set({ busy: false });
  }
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
