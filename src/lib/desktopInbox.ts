import { phase2Ready } from "@/lib/phase2Readiness";
import { useSyncExternalStore } from "react";
import { cloudPresence } from "@/lib/cloudPresence";
import { invoke, type DesktopInboxEvent } from "@/lib/api";
import { getAccount, subscribeAccount } from "@/lib/account";
import { privacyEnabled, subscribeDataPrivacy, PRIVACY_MESSAGE } from "@/lib/dataPrivacy";
import { CloudInboxSubscriber, type InboxStorage, type InboxTransport } from "@/lib/cloudInbox";
import { configureCloudReadMarkers, enableCloudReadMarkerWrites, reconcileCloudReadMarker } from "@/lib/cloudReadMarkers";
import { invalidateCloudInboxWorkspace, resyncCloudInboxCatalog, getCloudCatalog, subscribeCloudCatalog, liveCloudOrgIds } from "@/lib/cloudCatalog";
import { notifyOrganizationEvent } from "@/lib/notify";

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
      for (const [id, pending] of pendingNotices) {
        if (pending.event.workspaceId === event.workspaceId) pendingNotices.delete(id);
      }
      if (notices.some((notice) => notice.workspaceId === event.workspaceId)) {
        publishNotices(notices.filter((notice) => notice.workspaceId !== event.workspaceId));
      }
      invalidateCloudInboxWorkspace(event.workspaceId, undefined, true);
      break;
    case "workspace.presence-changed":
      cloudPresence.hint(event.organizationId);
      invalidateCloudInboxWorkspace(event.workspaceId, event.organizationId);
      break;
    case "workspace.reassigned":
    case "workspace.share-added":
      invalidateCloudInboxWorkspace(event.workspaceId, event.organizationId);
      break;
    case "workspace.read-marker-changed":
      reconcileCloudReadMarker(event.organizationId, event.workspaceId, event.payload);
      // Hints are coalesced/budgeted; the payload need not be the latest PUT.
      invalidateCloudInboxWorkspace(event.workspaceId, event.organizationId);
      break;
  }
}
export interface ReassignedNotice { id: string; organizationId: string; workspaceId: string; name: string; actorId: string; previousOwnerId: string; note?: string }
let notices: ReassignedNotice[] = [];
const noticeListeners = new Set<() => void>();
function publishNotices(next: ReassignedNotice[]) { notices = next; for (const listener of noticeListeners) listener(); }
type NoticeEvent = Exclude<DesktopInboxEvent, { type: "workspace.share-removed" | "workspace.read-marker-changed" }>;
interface PendingNotice {
  event: NoticeEvent;
  earliestRequest: number;
  current: () => boolean;
  committed: boolean;
  delivering: boolean;
}
const pendingNotices = new Map<string, PendingNotice>();

// Undefined waits for a fresh answer; null means the current answer denies delivery.
function authorizedWorkspace({ event, current, earliestRequest }: PendingNotice) {
  if (!current()) return null;
  const catalog = getCloudCatalog();
  const org = catalog.orgs[event.organizationId];
  if (catalog.revision !== getAccount().status.context?.revision ||
      org?.source !== "live" || org.error || org.requestedAt == null || org.requestedAt < earliestRequest) return undefined;
  const workspace = org.workspaces.find((row) => row.workspace.id === event.workspaceId)?.workspace;
  if (workspace?.orgId !== event.organizationId || workspace.you?.role === "none") return null;
  if (event.type === "workspace.reassigned") {
    if (!catalog.viewerUserId) return undefined;
    return workspace.createdBy === catalog.viewerUserId ? workspace : null;
  }
  return workspace.accessMode === "organization" ? workspace : null;
}

function flushInboxNotices() {
  for (const [id, pending] of pendingNotices) {
    if (!pending.current()) { pendingNotices.delete(id); continue; }
    if (!pending.committed || pending.delivering) continue;
    const workspace = authorizedWorkspace(pending);
    if (workspace === null) pendingNotices.delete(id);
    if (!workspace) continue;
    const { event } = pending;
    pending.delivering = true;
    if (event.type === "workspace.reassigned") {
      const { actorId, previousOwnerId, note } = event.payload;
      publishNotices([...notices, { id, organizationId: event.organizationId, workspaceId: event.workspaceId, name: workspace.name, actorId, previousOwnerId, ...(typeof note === "string" ? { note: note.slice(0, 500) } : {}) }].slice(-10));
    }
    const authorized = () => pendingNotices.get(id) === pending && !!authorizedWorkspace(pending);
    void notifyOrganizationEvent(event.type === "workspace.reassigned" ? "reassigned" : "share-added", authorized).finally(() => {
      if (pendingNotices.get(id) === pending) pendingNotices.delete(id);
    });
  }
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
  let identity: string | null = null;
  let revision: string | null = null;
  let generation = 0;
  let eventOrgs: string | null = null;
  const subscriber = new CloudInboxSubscriber(transport, storage, (event) => {
    const account = identity;
    const token = generation;
    const canNotify = event.type === "workspace.share-added" || event.type === "workspace.reassigned";
    const earliestRequest = canNotify
      ? Math.max(Date.now(), (getCloudCatalog().orgs[event.organizationId]?.requestedAt ?? -1) + 1)
      : 0;
    applyDesktopInboxEvent(event);
    if (!account || !canNotify) return;
    if (event.type === "workspace.reassigned" && (!event.payload.actorId || !event.payload.previousOwnerId)) return;
    const current = () => {
      const status = getAccount().status;
      return token === generation && !privacyEnabled() && status.context?.account === account && status.context.revision === revision
        && liveCloudOrgIds(status).includes(event.organizationId) && phase2Ready(status, event.organizationId, "events")
        && (event.type !== "workspace.reassigned" || phase2Ready(status, event.organizationId, "followReassign"));
    };
    if (!current() || pendingNotices.has(event.id)) return;
    if (pendingNotices.size >= 100) pendingNotices.delete(pendingNotices.keys().next().value!);
    const pending: PendingNotice = { event, current, earliestRequest, committed: false, delivering: false };
    pendingNotices.set(event.id, pending);
    // The subscriber persists receipts and its checkpoint synchronously after apply.
    // Wait for a successful durable write before any best-effort external effect.
    void Promise.resolve().then(() => {
      if (pendingNotices.get(event.id) !== pending || !current()) return;
      const saved = JSON.parse(storage.getItem(`terminalx.inbox.v1:${encodeURIComponent(account)}`) ?? "null");
      if (!saved || (BigInt(saved.cursor) < BigInt(event.id) && !saved.seen.includes(event.id))) {
        pendingNotices.delete(event.id);
        return;
      }
      pending.committed = true;
      flushInboxNotices();
      if (pendingNotices.get(event.id) === pending && !pending.delivering) {
        return resyncCloudInboxCatalog().then(flushInboxNotices);
      }
    }).catch(() => {
      if (!pending.committed && pendingNotices.get(event.id) === pending) pendingNotices.delete(event.id);
    });
  }, resyncCloudInboxCatalog);
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
    pendingNotices.clear(); publishNotices([]);
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
  const catalog = subscribeCloudCatalog(flushInboxNotices);
  const account = subscribeAccount(sync);
  const privacy = subscribeDataPrivacy(sync);
  stop = () => { ++generation; catalog(); account(); privacy(); subscriber.stop(); configureCloudReadMarkers(null, null); };
  sync();
}
export function resetDesktopInbox() { stop?.(); stop = null; pendingNotices.clear(); publishNotices([]); }
