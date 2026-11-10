import { useEffect, useSyncExternalStore } from "react";
import type { ChangedFile } from "@/types/session";

export const VIEWED_TTL = 30 * 24 * 60 * 60 * 1000;
export const VIEWED_KEY = "changes-viewed:v1";
type Mark = { blobHash: string; viewedAt: number };
export type ViewedMarks = Record<string, Mark>;
const keyFor = (workspace: string, path: string) => JSON.stringify([workspace, path]);

/** Stores identities only: no file contents, and no extension of the TTL on reads. */
export function createViewedStore(storage?: Pick<Storage, "getItem" | "setItem">, now = Date.now) {
  let marks: ViewedMarks = {};
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  let persistent = !!storage;
  const persist = () => {
    try { storage?.setItem(VIEWED_KEY, JSON.stringify(marks)); persistent = !!storage; }
    catch { persistent = false; /* Keep working in memory if storage is full or unavailable. */ }
  };
  const valid = (value: unknown): value is Mark => {
    const mark = value as Mark | null;
    return !!mark && typeof mark.blobHash === "string" && !!mark.blobHash && Number.isFinite(mark.viewedAt)
      && mark.viewedAt <= now() && now() - mark.viewedAt < VIEWED_TTL;
  };
  const read = (): ViewedMarks => {
    if (!persistent) return marks;
    let serialized: string | null;
    try { serialized = storage!.getItem(VIEWED_KEY); }
    catch { persistent = false; return marks; }
    try {
      const saved: unknown = JSON.parse(serialized ?? "{}");
      return Object.fromEntries(Object.entries(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}).filter(([, value]) => valid(value)));
    } catch { return {}; }
  };
  const reload = () => {
    marks = read();
    persist();
    emit();
  };
  reload();
  return {
    getSnapshot: () => marks,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload,
    prune: () => {
      const next = Object.fromEntries(Object.entries(read()).filter(([, value]) => valid(value)));
      if (JSON.stringify(next) === JSON.stringify(marks)) return;
      marks = next;
      persist();
      emit();
    },
    set: (workspace: string, path: string, blobHash: string | null) => {
      const next = Object.fromEntries(Object.entries(read()).filter(([, value]) => valid(value)));
      const key = keyFor(workspace, path);
      if (blobHash) next[key] = { blobHash, viewedAt: now() };
      else delete next[key];
      marks = next;
      persist();
      emit();
    },
  };
}

export function viewedStatus(marks: ViewedMarks, workspace: string, file: Pick<ChangedFile, "path" | "blobHash">, now = Date.now()) {
  const mark = marks[keyFor(workspace, file.path)];
  const valid = !!mark && now - mark.viewedAt < VIEWED_TTL && mark.viewedAt <= now && !!file.blobHash;
  return { viewed: valid && mark.blobHash === file.blobHash, changed: valid && mark.blobHash !== file.blobHash };
}

let store: ReturnType<typeof createViewedStore> | undefined;
function viewedStore() {
  if (!store) {
    let storage: Storage | undefined;
    try { storage = localStorage; } catch { /* Storage may be unavailable. */ }
    store = createViewedStore(storage);
  }
  return store;
}

export function useViewedChanges(workspace: string) {
  const store = viewedStore();
  const marks = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    store.prune();
    const onStorage = (event: StorageEvent) => { if (event.key === VIEWED_KEY || event.key === null) store.reload(); };
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(store.prune, 60_000);
    return () => { window.removeEventListener("storage", onStorage); window.clearInterval(timer); };
  }, [store]);
  return { status: (file: ChangedFile) => viewedStatus(marks, workspace, file),
    set: (file: ChangedFile, viewed: boolean) => { if (file.blobHash) store.set(workspace, file.path, viewed ? file.blobHash : null); } };
}
