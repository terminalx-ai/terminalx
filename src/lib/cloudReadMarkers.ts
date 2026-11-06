import { invoke } from "@tauri-apps/api/core";

export interface ReadMarker { orgId: string; workspaceId: string; sessionId: string; tabId: string; readSeq: number }
const key = (m: ReadMarker) => JSON.stringify([m.orgId, m.workspaceId, m.sessionId, m.tabId]);
const markers = new Map<string, ReadMarker>();
const pending = new Map<string, ReadMarker>();
const listeners = new Set<() => void>();
let owner: string | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let sending = false;
let generation = 0;
const storageKey = (account: string) => `terminalx.read-markers.${account}`;
const valid = (m: ReadMarker) => !!m && [m.orgId, m.workspaceId, m.sessionId, m.tabId].every(v => typeof v === "string" && v.length > 0 && v.length <= 128) && Number.isSafeInteger(m.readSeq) && m.readSeq >= 0;
function persist() {
  if (!owner) return;
  try { localStorage.setItem(storageKey(owner), JSON.stringify([...pending.values()])); } catch { /* memory still retries */ }
}
export function setReadMarkerAccount(next: string | null) {
  if (owner === next) return;
  owner = next;
  generation++;
  clearTimeout(retry);
  markers.clear(); pending.clear(); sending = false;
  if (owner) {
    try {
      const saved: ReadMarker[] = JSON.parse(localStorage.getItem(storageKey(owner)) ?? "[]");
      if (Array.isArray(saved)) for (const m of saved.filter(valid)) { pending.set(key(m), m); markers.set(key(m), m); }
    } catch { /* malformed cache */ }
    void flushReadMarkers();
  }
  for (const listener of listeners) listener();
}
export function subscribeReadMarkers(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function mergeReadMarkers(incoming: readonly ReadMarker[]) {
  let changed = false;
  for (const marker of incoming) {
    if (!valid(marker)) continue;
    const k = key(marker);
    if (!markers.has(k) || markers.get(k)!.readSeq < marker.readSeq) { markers.set(k, marker); changed = true; }
  }
  if (changed) for (const listener of listeners) listener();
}
export function isServerRead(marker: ReadMarker): boolean { return (markers.get(key(marker))?.readSeq ?? -1) >= marker.readSeq; }
export function queueReadMarker(marker: ReadMarker) {
  if (!owner || !valid(marker) || isServerRead(marker)) return;
  pending.set(key(marker), marker);
  mergeReadMarkers([marker]);
  persist();
  void flushReadMarkers();
}
export async function flushReadMarkers() {
  if (!owner || sending || !pending.size) return;
  sending = true;
  const account = owner, run = generation;
  let failed = false;
  try {
    for (const [k, marker] of [...pending]) {
      const saved = await invoke<ReadMarker>("desktop_read_marker", { owner: account, marker });
      if (run !== generation) return;
      mergeReadMarkers([saved]);
      if (pending.get(k) === marker) pending.delete(k);
      persist();
    }
  } catch { failed = true; /* offline: persist and retry for this account */ }
  finally {
    if (run === generation) {
      sending = false;
      if (pending.size) retry = setTimeout(() => void flushReadMarkers(), failed ? 5000 : 0);
    }
  }
}
