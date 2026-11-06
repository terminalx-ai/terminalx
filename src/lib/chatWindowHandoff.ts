import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { appWindow } from "./appWindow";
import { getDraft, setDraft, snapshotDrafts } from "./drafts";
import { hasWindowDrafts } from "./windowDrafts";

const REQUEST = "chat-window-drafts";
const RESULT = "chat-window-drafts-result";
interface Request { id: string; source: string; drafts: [string, string][] }
interface Result { id: string; error?: string }

/** Installed by the main window once its session index and open-session listener are ready. */
export function listenForChatWindowDrafts(): Promise<() => void> {
  return listen<Request>(REQUEST, ({ payload }) => {
    const result: Result = { id: payload.id };
    try {
      // Check every tab before writing any: neither window's existing text may be lost.
      if (payload.drafts.some(([tabId, text]) => getDraft(tabId) && getDraft(tabId) !== text)) {
        throw new Error("The main window already has a different unsent draft. Your drafts remain in this window; send or clear the other draft before trying again.");
      }
      for (const [tabId, text] of payload.drafts) {
        if (text && !getDraft(tabId)) setDraft(tabId, text);
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    void emitTo(payload.source, RESULT, result).catch((error) => console.error("Draft handoff reply failed", error));
  }, { target: { kind: "WebviewWindow", label: "main" } });
}

/** Never destroy the only copy of a draft: the destination must acknowledge it first. */
export async function openChatWindowInMain(sessionId: string, tabId: string | null): Promise<void> {
  // A new-session form has no destination tab. Image queues, pending reads
  // and unresolved sends also remain in their source composer. Open the
  // workbench without closing that view or copying only part of its prompt.
  if (!sessionId || hasWindowDrafts()) {
    await invoke("chat_window_open_in_main", { sessionId, tabId, closeSource: false });
    return;
  }
  const drafts = snapshotDrafts();
  if (drafts.size) {
    const id = crypto.randomUUID();
    let receive: (result: Result) => void = () => {};
    const unlisten = await listen<Result>(RESULT, ({ payload }) => {
      if (payload.id === id) receive(payload);
    }, { target: { kind: "WebviewWindow", label: appWindow() } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The main window did not accept your drafts. This window has been kept open; please try again.")), 10_000);
        receive = (result) => result.error ? reject(new Error(result.error)) : resolve();
        void emitTo("main", REQUEST, { id, source: appWindow(), drafts: [...drafts] } satisfies Request).catch(reject);
      });
    } finally {
      clearTimeout(timer);
      unlisten();
    }
  }
  const current = snapshotDrafts();
  if (current.size !== drafts.size || [...drafts].some(([key, text]) => current.get(key) !== text)) {
    throw new Error("Your draft changed while opening the main window. This window has been kept open with your edits; please try again.");
  }
  // An image may have arrived while main was acknowledging the text.
  await invoke("chat_window_open_in_main", { sessionId, tabId, closeSource: !hasWindowDrafts() });
}
