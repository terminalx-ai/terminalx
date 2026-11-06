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
let enabled = (_orgId: string) => true;
const storageKey = (account: string) => `terminalx.read-markers.${account}`;
const valid = (m: ReadMarker) => !!m && [m.orgId, m.workspaceId, m.sessionId, m.tabId].every(v => typeof v === "string" && v.length > 0 && v.length <= 128) && Number.isSafeInteger(m.readSeq) && m.readSeq >= 0;
function persist() {
  if (!owner) return;
  try { localStorage.setItem(storageKey(owner), JSON.stringify([...pending.values()])); } catch { /* memory still retries */ }
}
export function setReadMarkerAccount(next: string | null, enabledForOrg: (orgId: string) => boolean = () => true) {
  enabled = enabledForOrg;
  if (owner === next) { void flushReadMarkers(); return; }
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
    if (!owner || !enabled(marker.orgId) || !valid(marker)) continue;
    const k = key(marker);
    if (!markers.has(k) || markers.get(k)!.readSeq < marker.readSeq) { markers.set(k, marker); changed = true; }
  }
  if (changed) for (const listener of listeners) listener();
}
export function isServerRead(marker: ReadMarker): boolean { return !!owner && enabled(marker.orgId) && (markers.get(key(marker))?.readSeq ?? -1) >= marker.readSeq; }
export function queueReadMarker(marker: ReadMarker) {
  if (!owner || !enabled(marker.orgId) || !valid(marker) || isServerRead(marker)) return;
  pending.set(key(marker), marker);
  mergeReadMarkers([marker]);
  persist();
  void flushReadMarkers();
}
export async function flushReadMarkers() {
  if (!owner || sending || ![...pending.values()].some(marker => enabled(marker.orgId))) return;
  sending = true;
  const account = owner, run = generation;
  let failed = false;
  try {
    for (const [k, marker] of [...pending]) {
      if (!enabled(marker.orgId)) continue;
      try {
        const saved = await invoke<ReadMarker>("desktop_read_marker", { owner: account, marker });
        if (run !== generation) return;
        mergeReadMarkers([saved]);
        if (pending.get(k) === marker) pending.delete(k);
      } catch (error) {
        if (run !== generation) return;
        // Revoked/deleted workspaces cannot accept this read. Other tabs still
        // need to sync, including while this entry has a temporary failure.
        if (/desktop_inbox_http_(400|403|404|410)\b/.test(String(error))) {
          if (pending.get(k) === marker) pending.delete(k);
        } else failed = true;
      }
      persist();
    }
  }
  finally {
    if (run === generation) {
      sending = false;
      if ([...pending.values()].some(marker => enabled(marker.orgId))) retry = setTimeout(() => void flushReadMarkers(), failed ? 5000 : 0);
    }
  }
}
