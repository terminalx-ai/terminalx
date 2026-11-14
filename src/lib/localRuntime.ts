import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { errorMessage, localRuntime, type LocalRuntimeState } from "@/lib/api";
import { reattachLocalTerminals } from "@/lib/terminal";

/**
 * This window's live connection to the local background runtime (#643).
 *
 * The desktop re-establishes a lost connection by itself (`supervisor.rs`);
 * this follows it. Status is the answer and events only say "ask again", so a
 * queued old disconnect cannot mark a healthy window offline. When the
 * connection this window's terminals were attached over is replaced, they
 * attach again in place, and the stores re-read what they show on
 * `local_runtime_reattached`. Nothing reloads, and nothing sent is sent again.
 */
export interface LocalRuntimeView {
  state: LocalRuntimeState | null;
  /** When `state` was read, so its `downMs` can be aged without asking again. */
  readAt: number;
}

let current: LocalRuntimeView = { state: null, readAt: 0 };
const listeners = new Set<() => void>();
/** The attachment and view connection this window's terminals are on. */
let attachedOver: { generation: number; view: number } | null = null;
/** Read unconnected before the first connected read: terminals made then never attached. */
let missedAttach = false;

function apply(state: LocalRuntimeState) {
  current = { state, readAt: Date.now() };
  for (const listener of listeners) listener();
  if (state.state !== "connected") {
    if (!attachedOver) missedAttach = true;
    return;
  }
  const previous = attachedOver;
  attachedOver = { generation: state.generation, view: state.view };
  const replaced = previous ? previous.generation !== state.generation || previous.view !== state.view : missedAttach;
  if (replaced) reattachLocalTerminals();
}

let reading: Promise<void> | null = null;
let askedAgain = false;
/** Read the status. Asked again while a read is on its way, it reads once more after it. */
export function refreshLocalRuntime(): Promise<void> {
  if (reading) {
    askedAgain = true;
    return reading;
  }
  return (reading = (async () => {
    try {
      do {
        askedAgain = false;
        apply(await localRuntime.status().catch((error: unknown) => ({ state: "unavailable" as const, message: errorMessage(error) })));
      } while (askedAgain);
    } finally {
      reading = null;
    }
  })());
}

let booted: Promise<void> | null = null;
export function bootLocalRuntime(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen("local_runtime_state", () => void refreshLocalRuntime());
    } catch {
      /* outside a webview */
    }
    await refreshLocalRuntime();
  })());
}

/** "Try again": the desktop attempts now whatever it is re-establishing. */
export async function reconnectLocalRuntime(): Promise<void> {
  await localRuntime.reconnect().catch(() => {});
  await refreshLocalRuntime();
}

export function useLocalRuntime(): LocalRuntimeView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}
