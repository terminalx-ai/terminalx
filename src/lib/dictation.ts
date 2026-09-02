import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyFinal, applyPartial, EMPTY_BUFFER, spokenText, type DictationBuffer } from "./dictationText";

/**
 * Dictation into the composer. The Rust side owns the microphone and Apple's
 * on-device recogniser; this store mirrors its state and carries the text to
 * whichever composer is listening. One dictation at a time.
 *
 * The store folds the recogniser's results together itself and publishes the
 * whole of what has been heard, not the newest piece of it. A composer can
 * then rebuild its draft from scratch on every change, so a render that is
 * dropped, coalesced, or arrives late costs a moment rather than a phrase.
 */
export type DictationPhase = "idle" | "starting" | "listening" | "finishing";

export interface DictationState {
  phase: DictationPhase;
  /**
   * Everything recognised in this dictation so far, as one string. It survives
   * the end of the dictation and is cleared when the next one starts, so a
   * final result that lands in the same tick as the stop is never missed.
   */
  text: string;
  /** Which dictation this is. A composer follows only the one it started. */
  session: number;
  /** Which composer (tab id) the text belongs to. */
  target: string | null;
  error: string | null;
  available: boolean | null;
  /** Human name of the engine dictation will use, for the mic tooltip. */
  engine: string;
}

let state: DictationState = { phase: "idle", text: "", session: 0, target: null, error: null, available: null, engine: "Apple" };
/** The segments behind `state.text`; see `./dictationText`. */
let buffer: DictationBuffer = EMPTY_BUFFER;
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

interface DictationEvent {
  kind: "partial" | "final" | "error" | "stopped" | "listening" | "transcribing";
  text?: string;
  message?: string;
}

/**
 * Every event, into the app log. Dictation goes wrong in the field — a
 * recogniser that stops sending, a segment that arrives in a shape nobody
 * expected — so the reader's log has to show what the webview was actually
 * handed, next to what Rust says it emitted.
 */
function trace(e: DictationEvent) {
  const text = e.text ?? "";
  const head = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  const detail = e.kind === "error" ? ` ${e.message ?? ""}` : ` len=${text.length} ${JSON.stringify(head)}`;
  void invoke("frontend_log", { level: "debug", message: `dictation ${e.kind}${detail}` }).catch(() => {});
}

let subscribed = false;
async function subscribe() {
  if (subscribed) return;
  subscribed = true;
  try {
    await listen<DictationEvent>("dictation", (e) => {
      const p = e.payload;
      trace(p);
      switch (p.kind) {
        case "listening":
          set({ phase: "listening", error: null });
          break;
        case "transcribing":
          set({ phase: "finishing" });
          break;
        case "partial":
          buffer = applyPartial(buffer, p.text ?? "");
          set({ text: spokenText(buffer) });
          break;
        case "final":
          buffer = applyFinal(buffer, p.text ?? "");
          set({ text: spokenText(buffer) });
          break;
        case "error":
          set({ phase: "idle", error: p.message ?? "Dictation failed.", target: null });
          break;
        case "stopped":
          set({ phase: "idle", target: null });
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

/**
 * Start listening for `target`. The session number comes back at once — before
 * anything can be recognised — so the composer that asked for the dictation can
 * tell its own text from a later one's. `null` if a dictation is already going.
 */
export function startDictation(target: string): number | null {
  if (state.phase !== "idle") return null;
  buffer = EMPTY_BUFFER;
  const session = state.session + 1;
  set({ phase: "starting", text: "", session, target, error: null });
  void (async () => {
    // The listener is in place before the microphone is, so no result can
    // arrive before there is somewhere for it to go.
    await subscribe();
    if (state.session !== session) return;
    try {
      await invoke("dictation_start");
    } catch (e) {
      set({ phase: "idle", target: null, error: String(e) });
    }
  })();
  return session;
}

/** Stop listening; the last utterance is committed when the recogniser finishes it. */
export async function stopDictation() {
  if (state.phase === "idle") return;
  set({ phase: "finishing" });
  try {
    await invoke("dictation_stop");
  } catch (e) {
    set({ phase: "idle", target: null, error: String(e) });
  }
}

export function clearDictationError() {
  set({ error: null });
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
