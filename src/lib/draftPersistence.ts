import { invoke } from "@tauri-apps/api/core";
import { getDraft, setDraft, subscribeDrafts } from "./drafts";
import { dismissErrorKey, showError } from "./errorToasts";

const SAVE_AFTER_MS = 400;
/** A save that failed is tried again after this long, while the text is still unsaved. */
const RETRY_AFTER_MS = 5_000;
/** Failed saves in a row before the person is told, so one passing hiccup says nothing. */
const TELL_AFTER = 2;
const SAVE_KEY = "draft-save";
const LOAD_KEY = "draft-load";
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let restoring = false;
let started = false;
let failures = 0;

function schedule(ms: number) {
  timer ??= setTimeout(flush, ms);
}

function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const tabs = [...pending];
  pending.clear();
  for (const tabId of tabs) {
    void invoke("composer_draft_save", { tabId, text: getDraft(tabId) }).then(saved, () => unsaved(tabId));
  }
}

function saved() {
  if (failures === 0) return;
  failures = 0;
  dismissErrorKey(SAVE_KEY);
}

/** Kept to save again: the text it saves is whatever the tab holds then. */
function unsaved(tabId: string) {
  pending.add(tabId);
  failures += 1;
  schedule(RETRY_AFTER_MS);
  if (failures === TELL_AFTER) {
    showError("Couldn’t save your unsent text. It stays in this window and is tried again; copy it somewhere safe before you quit TerminalX", undefined, {
      key: SAVE_KEY,
      tone: "warning",
      actions: [{ label: "Try again", icon: "retry", primary: true, run: flush }],
    });
  }
}

async function restore() {
  try {
    const saved = await invoke<Record<string, string>>("composer_drafts_load");
    dismissErrorKey(LOAD_KEY);
    restoring = true;
    for (const [tabId, text] of Object.entries(saved)) {
      if (!getDraft(tabId) && !pending.has(tabId)) setDraft(tabId, text);
    }
  } catch (cause) {
    // Drafts then last as long as this window, as they did before; the person is told, and may read them again.
    showError("Couldn’t bring back unsent text from last time", cause, {
      key: LOAD_KEY,
      tone: "warning",
      actions: [{ label: "Try again", icon: "retry", primary: true, run: () => void restore() }],
    });
  } finally {
    restoring = false;
  }
}

/** Keep local tabs' unsent text across a restart. What is already typed always wins. */
export async function startDraftPersistence() {
  if (started) return;
  started = true;
  subscribeDrafts((tabId) => {
    if (restoring) return;
    pending.add(tabId);
    schedule(SAVE_AFTER_MS);
  });
  // Closing the window gives a page no time to wait on a save, so the pending text is handed over the moment
  // the page is hidden or loses focus, as well as when it is torn down.
  window.addEventListener("pagehide", flush);
  window.addEventListener("blur", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  await restore();
}
