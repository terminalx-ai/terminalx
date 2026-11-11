import { invoke } from "@tauri-apps/api/core";
import { getDraft, setDraft } from "./drafts";
import type { SessionEntry } from "@/types/session";
import type { SelectedSessionTab } from "./terminal";

/** Up to 4,000 UTF-16 code units stay readable in the composer. */
export const TERMINAL_SELECTION_INLINE_LIMIT = 4_000;

export function inlineTerminalSelection(text: string): string | null {
  if (!text.trim()) return "";
  if (text.length > TERMINAL_SELECTION_INLINE_LIMIT) return null;
  // Output can itself contain Markdown fences. Keep it literal inside ours.
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export function terminalChatTarget(session: SessionEntry, selected?: SelectedSessionTab) {
  const agents = session.tabs.filter((tab) => tab.front !== "terminal");
  return agents.find((tab) => selected?.kind === "agent" && tab.id === selected.id)
    ?? agents.find((tab) => tab.id === session.activeTab)
    ?? agents[0];
}

/** Capture the destination before saving, but append to its latest draft afterward. */
export async function addTerminalSelection(sessionId: string, tabId: string, text: string, stillOpen: () => boolean) {
  let addition = inlineTerminalSelection(text);
  if (addition === "") return;
  if (addition === null) {
    const path = await invoke<string>("save_terminal_selection", { sessionId, tabId, text });
    addition = `@${path}`;
  }
  if (!stillOpen()) throw new Error("The destination agent tab is closed. The selection has not been added to a draft.");
  const draft = getDraft(tabId);
  setDraft(tabId, draft ? `${draft}\n\n${addition}` : addition);
}
