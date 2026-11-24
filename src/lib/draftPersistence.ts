import { invoke } from "@tauri-apps/api/core";
import { getDraft, setDraft, subscribeDrafts } from "./drafts";

const SAVE_AFTER_MS = 400;
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let restoring = false;
let started = false;

function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const tabId of pending) {
    void invoke("composer_draft_save", { tabId, text: getDraft(tabId) }).catch(() => undefined);
  }
  pending.clear();
}

/** Keep local tabs' unsent text across a restart. What is already typed always wins. */
export async function startDraftPersistence() {
  if (started) return;
  started = true;
  subscribeDrafts((tabId) => {
    if (restoring) return;
    pending.add(tabId);
    timer ??= setTimeout(flush, SAVE_AFTER_MS);
  });
  // Closing the window gives a page no time to wait on a save, so the pending text is handed over the moment
  // the page is hidden or loses focus, as well as when it is torn down.
  window.addEventListener("pagehide", flush);
  window.addEventListener("blur", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  try {
    const saved = await invoke<Record<string, string>>("composer_drafts_load");
    restoring = true;
    for (const [tabId, text] of Object.entries(saved)) {
      if (!getDraft(tabId) && !pending.has(tabId)) setDraft(tabId, text);
    }
  } catch {
    // Drafts then last as long as this window, as they did before.
  } finally {
    restoring = false;
  }
}
