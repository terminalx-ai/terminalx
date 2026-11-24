import type { ReadMarker } from "@/lib/cloudInbox";

type Writer = (orgId: string, workspaceId: string, readAt: string, sessionId?: string) => Promise<ReadMarker | undefined>;
const markers = new Map<string, number>();
const workspaceRevisions = new Map<string, number>();
const listeners = new Set<() => void>();
let owner: string | null = null;
let generation = 0;
let writer: Writer | null = null;
const key = (org: string, workspace: string, session: string) => JSON.stringify([org, workspace, session]);
const emit = () => { for (const listener of listeners) listener(); };
export function subscribeCloudReadMarkers(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** No email fallback: an unknown native account/profile cannot inherit another identity's markers. */
export function configureCloudReadMarkers(account: string | null, send: Writer | null) {
  ++generation;
  const changed = owner !== account || account === null;
  owner = account;
  writer = send;
  if (changed) {
    markers.clear();
    workspaceRevisions.clear();
  }
  // Marker cache is deliberately launch-local. Catalog and durable inbox replay restore authorized markers.
  emit();
}
/** Readiness enables writes without discarding catalog markers received during startup. */
export function enableCloudReadMarkerWrites(account: string, send: Writer) {
  if (owner === account) writer = send;
}
export function reconcileCloudReadMarker(org: string, workspace: string, marker: ReadMarker) {
  if (!owner || typeof marker.sessionId !== "string") return;
  const at = Date.parse(marker.readAt);
  const id = key(org, workspace, marker.sessionId);
  if (!Number.isFinite(at) || at <= (markers.get(id) ?? -Infinity)) return;
  markers.set(id, at);
  emit();
}
export function cloudActivityRead(org: string, workspace: string, session: string, activity: string | null | undefined): boolean {
  const at = activity ? Date.parse(activity) : NaN;
  // Session markers and whole-workspace markers are independent, never substitute one for the other.
  return Number.isFinite(at) && (markers.get(key(org, workspace, session)) ?? -Infinity) >= at;
}
export function forgetCloudReadMarkers(workspace: string) {
  workspaceRevisions.set(workspace, (workspaceRevisions.get(workspace) ?? 0) + 1);
  for (const id of markers.keys()) if (JSON.parse(id)[1] === workspace) markers.delete(id);
  emit();
}
export async function writeCloudReadMarker(org: string, workspace: string, session: string, activity: string | null | undefined) {
  if (!owner || !writer || !activity || !/^[A-Za-z0-9._:@-]{1,128}$/.test(session)) return;
  const at = Date.parse(activity);
  if (!Number.isFinite(at) || at > Date.now()) return;
  const token = generation;
  const revision = workspaceRevisions.get(workspace);
  try {
    const marker = await writer(org, workspace, new Date(at).toISOString(), session);
    if (marker && token === generation && revision === workspaceRevisions.get(workspace)) reconcileCloudReadMarker(org, workspace, marker);
  } catch { /* Local/runtime unread behavior survives unavailable or denied SaaS writes. */ }
}
