import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorMessage } from "@/lib/api";
import type { PairingConnectionMode, PairingStatus } from "@/types/pairing";

interface PairingState {
  status: PairingStatus;
  ready: boolean;
  busy: boolean;
  relayRetrying: boolean;
  relayRetryError: string | null;
  generationError: { connectionMode: PairingConnectionMode; message: string } | null;
  /** The "Pair a phone" dialog is open (from a session, the command palette or Settings → Devices). */
  dialogOpen: boolean;
}

const emptyStatus: PairingStatus = {
  relay: { phase: "off", message: null, attempt: 0 },
  host: null,
  devices: [],
  activePairing: null,
  pendingApproval: null,
  keepAwake: true,
  lastError: null,
};

let state: PairingState = { status: emptyStatus, ready: false, busy: false, relayRetrying: false, relayRetryError: null, generationError: null, dialogOpen: false };
const listeners = new Set<() => void>();

function set(patch: Partial<PairingState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function applyStatus(status: PairingStatus) {
  set({ status, ready: true, ...(status.relay.phase === "connected" ? { relayRetryError: null } : {}) });
}

/** The store as it is now, outside React. */
export function getPairing(): PairingState {
  return state;
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
  set({ busy: true, generationError: null, status: { ...state.status, lastError: null } });
  try {
    applyStatus(await api.pairingGenerate(connectionMode));
  } catch (error) {
    const message = errorMessage(error);
    try {
      const status = await api.pairingStatus();
      set({ status, ready: true, generationError: { connectionMode, message } });
    } catch {
      set({ generationError: { connectionMode, message } });
    }
  } finally {
    set({ busy: false });
  }
}

/** Run one native pairing command that answers with the new status; its failure shows as the status's last error. */
async function command(run: () => Promise<PairingStatus>): Promise<void> {
  set({ busy: true, status: { ...state.status, lastError: null } });
  try {
    applyStatus(await run());
  } catch (error) {
    set({ status: { ...state.status, lastError: errorMessage(error) } });
  } finally {
    set({ busy: false });
  }
}

export function revokePairing(deviceId: string): Promise<void> {
  return command(() => api.pairingRevoke(deviceId));
}

/** The fingerprints match: let the waiting phone finish pairing. */
export function approvePairing(requestId: string): Promise<void> {
  return command(() => api.pairingApprove(requestId));
}

/** Refuse the waiting phone. The Mac discards its device and the code; a new code is needed to try again. */
export function declinePairing(requestId: string): Promise<void> {
  return command(() => api.pairingDecline(requestId));
}

/** End a paired device's live connections without revoking it. */
export function disconnectDevice(deviceId: string): Promise<void> {
  return command(() => api.pairingDisconnect(deviceId));
}

/** Keep this Mac awake while a phone is connected. The switch moves at once and returns if the Mac refuses. */
export async function setKeepAwake(enabled: boolean): Promise<void> {
  const previous = state.status.keepAwake;
  set({ status: { ...state.status, keepAwake: enabled, lastError: null } });
  try {
    applyStatus(await api.pairingSetKeepAwake(enabled));
  } catch (error) {
    set({ status: { ...state.status, keepAwake: previous, lastError: errorMessage(error) } });
  }
}

export function openPairPhone(): void {
  set({ dialogOpen: true });
}

export function closePairPhone(): void {
  set({ dialogOpen: false });
}

export async function retryRelay(): Promise<void> {
  if (state.relayRetrying) return;
  set({ relayRetrying: true, relayRetryError: null });
  try {
    applyStatus(await api.pairingRetryRelay());
  } catch (error) {
    set({ relayRetryError: errorMessage(error) });
  } finally {
    set({ relayRetrying: false });
  }
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
