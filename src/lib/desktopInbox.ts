import { phase2Ready } from "@/lib/phase2Readiness";
import { useSyncExternalStore } from "react";
import { cloudPresence } from "@/lib/cloudPresence";
import { invoke, type DesktopInboxEvent } from "@/lib/api";
import { getAccount, subscribeAccount } from "@/lib/account";
import { privacyEnabled, subscribeDataPrivacy, PRIVACY_MESSAGE } from "@/lib/dataPrivacy";
import { CloudInboxSubscriber, type InboxStorage, type InboxTransport } from "@/lib/cloudInbox";
import { configureCloudReadMarkers, enableCloudReadMarkerWrites, reconcileCloudReadMarker } from "@/lib/cloudReadMarkers";
import { invalidateCloudInboxWorkspace, resyncCloudInboxCatalog, getCloudCatalog, subscribeCloudCatalog } from "@/lib/cloudCatalog";

/** Exact commands implemented by the shared contracts worker. Use the existing
 * privacy-aware invoke wrapper; tokens and account fencing remain native.
 * Older builds without readiness leave the inbox disabled. */
function inboxInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // Older invoke wrappers do not classify desktop_inbox commands as cloud work.
  if (privacyEnabled()) return Promise.reject(new Error(PRIVACY_MESSAGE));
  return invoke<T>(command, args);
}
export const desktopInboxTransport: InboxTransport = {
  phase2DesktopContractsAvailable: () => inboxInvoke<boolean>("phase2_desktop_contracts_available"),
  desktopInbox: (after, waitMs) => inboxInvoke("desktop_inbox", { after, waitMs }),
  desktopInboxStream: (after, lastEventId) => inboxInvoke("desktop_inbox_stream", { after, lastEventId: lastEventId ?? null }),
  desktopInboxReceipts: (eventIds) => inboxInvoke("desktop_inbox_receipts", { eventIds }),
  cloudWorkspaceReadMarker: (orgId, workspaceId, readAt, sessionId) =>
    inboxInvoke("cloud_workspace_read_marker", { orgId, workspaceId, readAt, sessionId: sessionId ?? null }),
};
const transport = desktopInboxTransport;
let stop: (() => void) | null = null;
export function applyDesktopInboxEvent(event: DesktopInboxEvent) {
  switch (event.type) {
    case "workspace.share-removed":
      invalidateCloudInboxWorkspace(event.workspaceId, undefined, true);
      break;
    case "workspace.presence-changed":
      cloudPresence.hint(event.organizationId);
      invalidateCloudInboxWorkspace(event.workspaceId, event.organizationId);
      break;
    case "workspace.reassigned":
      invalidateCloudInboxWorkspace(event.workspaceId, event.organizationId);
      void takeReassignedNotice(event);
      break;
    case "workspace.share-added":
      invalidateCloudInboxWorkspace(event.workspaceId, event.organizationId);
      break;
    case "workspace.read-marker-changed":
      reconcileCloudReadMarker(event.organizationId, event.workspaceId, event.payload);
      // Hints are coalesced/budgeted; the payload need not be the latest PUT.
      invalidateCloudInboxWorkspace(event.workspaceId, event.organizationId);
      break;
  }
  // Accepted events are access hints and self read markers. None is a completion/attention
  // event: existing runtime attention alone drives notify.ts and the macOS notification hook.
}
export interface ReassignedNotice { id: string; organizationId: string; workspaceId: string; name: string; actorId: string; previousOwnerId: string; note?: string }
let notices: ReassignedNotice[] = [];
const noticeListeners = new Set<() => void>();
function publishNotices(next: ReassignedNotice[]) { notices = next; for (const listener of noticeListeners) listener(); }
function noticeScope() {
  const status = getAccount().status;
  return !privacyEnabled() && status.state === "signed-in" && status.context ? `${status.context.account}:${status.context.revision}` : null;
}
type ReassignedEvent = Extract<DesktopInboxEvent, { type: "workspace.reassigned" }>;
const pendingReassigned = new Map<string, { scope: string; event: ReassignedEvent; at: number }>();
function flushReassignedNotices() {
  const scope = noticeScope();
  const catalog = getCloudCatalog();
  for (const [id, pending] of pendingReassigned) {
    if (pending.scope !== scope) { pendingReassigned.delete(id); continue; }
    const event = pending.event;
    const org = catalog.orgs[event.organizationId];
    // A cached row or a catalog asked before the hint cannot authorize note display.
    if (!catalog.viewerUserId || org?.source !== "live" || org.error || org.requestedAt == null || org.requestedAt < pending.at) continue;
    pendingReassigned.delete(id);
    const item = org.workspaces.find((row) => row.workspace.id === event.workspaceId);
    if (item?.workspace.createdBy !== catalog.viewerUserId || notices.some((notice) => notice.id === id)) continue;
    const { actorId, previousOwnerId, note } = event.payload;
    if (!actorId || !previousOwnerId) continue;
    publishNotices([...notices, { id, organizationId: event.organizationId, workspaceId: event.workspaceId, name: item.workspace.name, actorId, previousOwnerId, ...(typeof note === "string" ? { note: note.slice(0, 500) } : {}) }].slice(-10));
  }
}
async function takeReassignedNotice(event: ReassignedEvent) {
  const scope = noticeScope();
  if (!scope) return;
  // Keep only this account's bounded pending delivery, never render before reauthorization.
  if (pendingReassigned.size >= 100) pendingReassigned.delete(pendingReassigned.keys().next().value!);
  pendingReassigned.set(event.id, { scope, event, at: Date.now() });
  await Promise.resolve(resyncCloudInboxCatalog()).catch(() => {});
  if (scope === noticeScope()) flushReassignedNotices();
}
export function getReassignedNotices() { return notices; }
export function useReassignedNotices() { return useSyncExternalStore((listener) => { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; }, () => notices); }
export function dismissReassignedNotice(id: string) { publishNotices(notices.filter((notice) => notice.id !== id)); }
export function bootDesktopInbox() {
  if (stop) return;
  const storage: InboxStorage = {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  };
  const subscriber = new CloudInboxSubscriber(transport, storage, applyDesktopInboxEvent, resyncCloudInboxCatalog);
  let identity: string | null = null;
  let revision: string | null = null;
  let generation = 0;
  let eventOrgs: string | null = null;
  const sync = () => {
    const status = getAccount().status;
    const next = !privacyEnabled() && status.state === "signed-in" ? status.context?.account ?? null : null;
    const nextRevision = next ? status.context?.revision ?? null : null;
    const nextEventOrgs = status.phase2Readiness
      ? JSON.stringify(Object.keys(status.phase2Readiness).filter((org) => phase2Ready(status, org, "events")).sort())
      : null;
    if (next === identity && nextRevision === revision && nextEventOrgs === eventOrgs) return;
    eventOrgs = nextEventOrgs;
    const token = ++generation;
    pendingReassigned.clear(); publishNotices([]);
    // Clear durable delivery state on an actual identity change; context changes fence in-flight work.
    subscriber.stop(identity !== next);
    if (identity && identity !== next) {
      // Readiness may still be pending, so the subscriber may not have loaded this account yet.
      try { storage.removeItem(`terminalx.inbox.v1:${encodeURIComponent(identity)}`); } catch { /* Account keys remain isolated. */ }
    }
    identity = next;
    revision = nextRevision;
    // Catalog polling can answer before readiness; its authorized markers must be retained
    // even when inbox replay has already checkpointed those marker events on a prior launch.
    configureCloudReadMarkers(next, null);
    if (!next || eventOrgs === "[]") return;
    void Promise.resolve().then(() => transport.phase2DesktopContractsAvailable()).then((ready) => {
      if (token !== generation || !ready) return;
      enableCloudReadMarkerWrites(next, (org, workspace, at, session) => {
        const status = getAccount().status;
        if (status.phase2Readiness && !phase2Ready(status, org, "events")) return Promise.resolve(undefined);
        return transport.cloudWorkspaceReadMarker(org, workspace, at, session);
      });
      subscriber.start(next);
    }).catch(() => { /* Held or older native build: catalog polling continues unchanged. */ });
  };
  const catalog = subscribeCloudCatalog(flushReassignedNotices);
  const account = subscribeAccount(sync);
  const privacy = subscribeDataPrivacy(sync);
  stop = () => { ++generation; catalog(); account(); privacy(); subscriber.stop(); configureCloudReadMarkers(null, null); };
  sync();
}
export function resetDesktopInbox() { stop?.(); stop = null; pendingReassigned.clear(); publishNotices([]); }
