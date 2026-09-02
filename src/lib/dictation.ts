import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Dictation into the composer. The Rust side owns the microphone and Apple's
 * on-device recogniser; this store mirrors its state and carries partial
 * transcripts to whichever composer is listening. One dictation at a time.
 */
export type DictationPhase = "idle" | "starting" | "listening" | "finishing";

export interface DictationState {
  phase: DictationPhase;
  /** Text recognised so far for the current utterance; replaced, not appended. */
  partial: string;
  /** Which composer (tab id) the text belongs to. */
  target: string | null;
  error: string | null;
  available: boolean | null;
  /** Human name of the engine dictation will use, for the mic tooltip. */
  engine: string;
}

let state: DictationState = { phase: "idle", partial: "", target: null, error: null, available: null, engine: "Apple" };
const listeners = new Set<() => void>();
function set(patch: Partial<DictationState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useDictation(): DictationState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

/** Called with the committed text each time an utterance ends. */
type Sink = (text: string) => void;
let sink: Sink | null = null;

interface DictationEvent {
  kind: "partial" | "final" | "error" | "stopped" | "listening" | "transcribing";
  text?: string;
  message?: string;
}

let subscribed = false;
async function subscribe() {
  if (subscribed) return;
  subscribed = true;
  try {
    await listen<DictationEvent>("dictation", (e) => {
      const p = e.payload;
      switch (p.kind) {
        case "listening":
          set({ phase: "listening", error: null });
          break;
        case "transcribing":
          set({ phase: "finishing", partial: "" });
          break;
        case "partial":
          set({ partial: p.text ?? "" });
          break;
        case "final": {
          const text = (p.text ?? state.partial).trim();
          if (text && sink) sink(text);
          set({ partial: "" });
          break;
        }
        case "error":
          set({ phase: "idle", partial: "", error: p.message ?? "Dictation failed.", target: null });
          break;
        case "stopped":
          set({ phase: "idle", partial: "", target: null });
          break;
      }
    });
  } catch {
    /* outside a webview */
  }
}

export async function dictationAvailable(): Promise<boolean> {
  if (state.available != null) return state.available;
  try {
    const ok = await invoke<boolean>("dictation_available");
    set({ available: ok });
    void refreshDictationEngine();
    return ok;
  } catch {
    set({ available: false });
    return false;
  }
}

/** Re-read which engine is selected; the settings tab calls this after a change. */
export async function refreshDictationEngine() {
  try {
    const [settings, models] = await Promise.all([
      invoke<{ model: string }>("transcription_settings"),
      invoke<{ id: string; name: string; installed: boolean }[]>("transcription_models"),
    ]);
    const m = models.find((x) => x.id === settings.model);
    set({ engine: m && m.installed ? m.name : "Apple" });
  } catch {
    /* outside a webview */
  }
}

/** Start listening for `target`; recognised text flows to `onText`. */
export async function startDictation(target: string, onText: Sink) {
  await subscribe();
  if (state.phase !== "idle") return;
  sink = onText;
  set({ phase: "starting", partial: "", target, error: null });
  try {
    await invoke("dictation_start");
  } catch (e) {
    sink = null;
    set({ phase: "idle", target: null, error: String(e) });
  }
}

/** Stop listening; the last utterance is committed when the recogniser finishes it. */
export async function stopDictation() {
  if (state.phase === "idle") return;
  set({ phase: "finishing" });
  try {
    await invoke("dictation_stop");
  } catch (e) {
    set({ phase: "idle", partial: "", target: null, error: String(e) });
  }
}

export function clearDictationError() {
  set({ error: null });
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
