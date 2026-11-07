import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { errorMessage, invoke } from "@/lib/api";
import { groupSidebarItems } from "@/lib/sidebarSections";
import type { SessionEntry } from "@/types/session";

export interface LocalSection { id: string; name: string; emoji?: string | null; sessions: string[] }
export interface LocalSectionState { revision: number; sections: LocalSection[] }
export type LocalSectionEdit =
  | { kind: "create"; name: string; emoji: string | null; sessionIds?: string[] }
  | { kind: "rename"; id: string; name: string }
  | { kind: "emoji"; id: string; emoji: string | null }
  | { kind: "delete"; id: string }
  | { kind: "reorder"; id: string; by: -1 | 1 }
  | { kind: "move"; sessionIds: string[]; sectionId: string | null };

type SectionDialog = { kind: "create"; sessionIds?: string[] } | { kind: "rename" | "emoji" | "delete"; section: LocalSection } | { kind: "move"; sessionIds: string[] };
let state: LocalSectionState & { error: string | null; dialog: SectionDialog | null } = { revision: 0, sections: [], error: null, dialog: null };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function set(patch: Partial<typeof state>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
export const getLocalSections = () => state;
function receive(saved: LocalSectionState) {
  // A delayed read or another window's earlier event must not undo a newer edit.
  if (saved && saved.revision >= state.revision) set({ ...saved, error: null });
}
export async function refreshLocalSections() { receive(await invoke<LocalSectionState>("local_sections")); }
let booting: Promise<void> | undefined;
export function bootLocalSections(): Promise<void> {
  return booting ??= (async () => {
    try {
      await listen<LocalSectionState>("local_sections_changed", ({ payload }) => receive(payload));
      for (const event of ["session_created", "session_deleted", "local_runtime_reattached"]) {
        await listen(event, () => { void refreshLocalSections().catch((cause) => set({ error: errorMessage(cause) })); });
      }
    } catch { /* A window outside Tauri has no event stream; still try the saved layout. */ }
    try { await refreshLocalSections(); } catch (cause) { set({ error: errorMessage(cause) }); }
  })();
}
export function useLocalSections() {
  useEffect(() => { void bootLocalSections(); }, []);
  return useSyncExternalStore(subscribe, getLocalSections, getLocalSections);
}
export async function editLocalSection(edit: LocalSectionEdit) {
  const saved = await invoke<LocalSectionState>("edit_local_section", { edit });
  receive(saved);
  return saved;
}
/** Report failed menu actions in the sidebar; dialogs keep their own inline error. */
export function runSectionEdit(edit: LocalSectionEdit) {
  void editLocalSection(edit).catch((cause) => set({ error: errorMessage(cause) }));
}
export function openSectionDialog(dialog: SectionDialog) { set({ dialog }); }
export function closeSectionDialog() { set({ dialog: null }); }
export function groupLocalSessions(sessions: readonly SessionEntry[], sections: readonly LocalSection[]) {
  return groupSidebarItems(sessions, sections, (session) => session.id, (section) => section.sessions);
}
