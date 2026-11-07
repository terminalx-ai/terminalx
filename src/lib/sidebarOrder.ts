import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { errorMessage, invoke } from "@/lib/api";

export interface SidebarOrder {
  custom: boolean;
  sessions: string[];
  projects: string[];
  revision: number;
}
export const DEFAULT_SIDEBAR_ORDER: SidebarOrder = { custom: false, sessions: [], projects: [], revision: 0 };
type Patch = Partial<Pick<SidebarOrder, "custom" | "sessions" | "projects">>;
let state = { ...DEFAULT_SIDEBAR_ORDER, error: null as string | null, pending: false, loaded: false };
let confirmed: SidebarOrder = DEFAULT_SIDEBAR_ORDER;
const queued: Patch[] = [];
const listeners = new Set<() => void>();
export const getSidebarOrder = () => state;

/** Merge only the named slots, including newly encountered rows at the top. */
export function mergeSidebarOrder(saved: readonly string[], requested: readonly string[]): string[] {
  const wanted = [...new Set(requested)];
  const seen = new Set(saved);
  const slots = [...wanted.filter((id) => !seen.has(id)), ...seen];
  const moving = new Set(wanted);
  let at = 0;
  return slots.map((id) => moving.has(id) ? wanted[at++] : id);
}
function publish() {
  const optimistic = queued.reduce<SidebarOrder>((order, patch) => ({ ...order, ...patch,
    custom: confirmed.revision === 0 ? confirmed.custom : patch.custom ?? order.custom,
    sessions: patch.sessions ? mergeSidebarOrder(order.sessions, patch.sessions) : order.sessions,
    projects: patch.projects ? mergeSidebarOrder(order.projects, patch.projects) : order.projects,
  }), confirmed);
  set({ ...optimistic, pending: queued.length > 0 });
}
function set(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
function receive(order: SidebarOrder | null | undefined) {
  if (order && order.revision >= confirmed.revision) { confirmed = order; publish(); }
}
let booted: Promise<void> | undefined;
export function bootSidebarOrder() {
  return booted ??= (async () => {
    await listen<SidebarOrder>("sidebar_order_changed", (event) => receive(event.payload));
    await listen("local_runtime_reattached", () => { void refreshSidebarOrder(); });
    await refreshSidebarOrder();
  })().catch((error) => set({ error: errorMessage(error) }));
}
async function refreshSidebarOrder() {
  try {
    receive(await invoke<SidebarOrder>("sidebar_order"));
    set({ loaded: true, error: null });
  } catch (error) { set({ error: errorMessage(error) }); }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useSidebarOrder() {
  useEffect(() => { void bootSidebarOrder(); }, []);
  return useSyncExternalStore(subscribe, () => state);
}

// Serialize writes from this window. The Rust transaction merges only the rows
// named by a drop; another window's unrelated group is preserved.
let writes = Promise.resolve();
export function saveSidebarOrder(patch: Patch): Promise<void> {
  queued.push(patch);
  set({ error: null });
  publish();
  const write = writes.then(async () => {
    try { receive(await invoke<SidebarOrder>("set_sidebar_order", { patch })); }
    catch (error) { set({ error: `Could not save custom order: ${errorMessage(error)}` }); }
    finally { queued.shift(); publish(); }
  });
  writes = write;
  return write;
}

/** Unknown rows are new: they precede the saved ones, in a stable order. */
export function bySavedOrder<T>(items: readonly T[], saved: readonly string[], key: (item: T) => string, fallback: (a: T, b: T) => number): T[] {
  const rank = new Map(saved.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(key(a)) ?? -1) - (rank.get(key(b)) ?? -1) || fallback(a, b));
}
export function customSessionOrder<T extends { id: string; created: string }>(sessions: readonly T[], order: SidebarOrder): T[] {
  return bySavedOrder(sessions, order.sessions, (s) => s.id, (a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0) || a.id.localeCompare(b.id));
}
