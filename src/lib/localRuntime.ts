import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { errorMessage, localRuntime, type LocalRuntimeOutdated, type LocalRuntimeRestart, type LocalRuntimeState, type LocalRuntimeWorkItem } from "@/lib/api";
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
 * That event also comes when the connection stayed up but some events could
 * not be delivered over it (#716, `missedEvents`): the same re-read covers it.
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

/**
 * Restart a runtime that stopped answering (#661). The desktop attaches a
 * fresh one, and terminals attach again in place as after any reconnect. One
 * that can be handed over keeps its agents and terminals running unless `how`
 * says otherwise (#765); any other is stopped with them. `epoch` is the
 * runtime this window found not responding: one another window already
 * replaced is left alone. Throws why it was not restarted, with nothing
 * stopped: a `LocalRuntimeRestartRefused` when it could have been. `stop`,
 * with `stoppingUnkept`, is what that refusal showed: only that stops.
 */
export async function restartLocalRuntime(epoch: string | null, how?: LocalRuntimeRestart, stop: LocalRuntimeWorkItem[] = []): Promise<void> {
  try {
    await localRuntime.restart(epoch, how, stop);
  } finally {
    await refreshLocalRuntime();
  }
}

/**
 * "Restart now" for a runtime older than this app (#730), and terminals
 * attach again in place. One that can be handed over keeps its agents and
 * terminals running but what of `stop`, what the window showed, its handover
 * cannot carry (#765): anything else it cannot carry is refused, to be shown
 * in turn. Any other is replaced without waiting for its agents' turns,
 * which stop with it. `epoch` is the runtime this window was told about: one
 * already replaced is left alone. Throws why it could not be replaced.
 */
export async function replaceLocalRuntime(epoch: string, stop: LocalRuntimeWorkItem[] = []): Promise<void> {
  try {
    await localRuntime.replace(epoch, stop);
  } finally {
    await refreshLocalRuntime();
  }
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

/**
 * The runtime the app came with, while it is not yet the one running (#766):
 * an older runtime waiting to be replaced (or failed to be), or one being
 * replaced. The status bar shows it, in place of a card in every window.
 */
export type RuntimeSwitch =
  | { kind: "waiting"; epoch: string; outdated: LocalRuntimeOutdated }
  | { kind: "updating"; from: string | null; to: string };

export function runtimeSwitchOf(state: LocalRuntimeState | null): RuntimeSwitch | null {
  if (state?.state === "updating") return { kind: "updating", from: state.from, to: state.to };
  if (state?.state === "connected" && state.outdated) return { kind: "waiting", epoch: state.epoch, outdated: state.outdated };
  return null;
}

export function useRuntimeSwitch(): RuntimeSwitch | null {
  return runtimeSwitchOf(useLocalRuntime().state);
}
