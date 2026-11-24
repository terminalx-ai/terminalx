import { phase2Ready } from "@/lib/phase2Readiness";
import { useSyncExternalStore } from "react";
import { cloudPresence } from "@/lib/cloudPresence";
import { api, invoke, type CloudWorkspace, type DesktopInboxEvent } from "@/lib/api";
import { getAccount, subscribeAccount } from "@/lib/account";
import { privacyEnabled, subscribeDataPrivacy, PRIVACY_MESSAGE } from "@/lib/dataPrivacy";
import { CloudInboxSubscriber, validInboxCursor, type InboxStorage, type InboxTransport } from "@/lib/cloudInbox";
import { configureCloudReadMarkers, enableCloudReadMarkerWrites, reconcileCloudReadMarker } from "@/lib/cloudReadMarkers";
import { cloudOrgArg, getCloudCatalog, invalidateCloudInboxWorkspace, liveCloudOrgIds, resyncCloudInboxCatalog, subscribeCloudCatalog, type OrgCatalog } from "@/lib/cloudCatalog";
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
type NoticeEvent = DesktopInboxEvent & { type: "workspace.share-added" | "workspace.reassigned" };
function isNoticeEvent(event: DesktopInboxEvent): event is NoticeEvent {
  return event.type === "workspace.share-added" || event.type === "workspace.reassigned";
}

interface PendingNotice {
  event: NoticeEvent;
  current: () => boolean;
  initialRows: OrgCatalog["workspaces"] | undefined;
  requiresLiveRow: boolean;
  confirmation?: CloudWorkspace;
  delivering?: boolean;
}
// Published notices outlive the permission request and keep their own access check.
const noticeAccess = new WeakMap<ReassignedNotice, PendingNotice>();
const pendingNotices = new Map<string, PendingNotice>();

function readableWorkspace(workspace: CloudWorkspace | undefined, orgId: string): workspace is CloudWorkspace {
  return workspace?.orgId === orgId && workspace.accessMode === "organization"
    && workspace.state !== "destroyed" && !workspace.deletedAt
    && (workspace.you?.role === "manager" || workspace.you?.role === "driver" || workspace.you?.role === "viewer");
}

function confirmedWorkspace(pending: PendingNotice) {
  const { event, current, initialRows, confirmation } = pending;
  if (!current()) return null;
  const catalog = getCloudCatalog();
  const org = catalog.orgs[event.organizationId];
  if (org?.error || (initialRows && !org)) return null;
  if (pending.requiresLiveRow && org?.source !== "live") return null;
  const viewer = catalog.revision === getAccount().status.context?.revision ? catalog.viewerUserId : undefined;
  // A live refresh since the event can withdraw access even before the list request answers.
  let workspace = confirmation;
  if (org?.source === "live" && (pending.requiresLiveRow || org.workspaces !== initialRows)) {
    // Subsequent checks must keep consulting the live rows, even if the org disappears.
    pending.requiresLiveRow = true;
    pending.initialRows = undefined;
    const latest = org.workspaces.find((row) => row.workspace.id === event.workspaceId)?.workspace;
    if (!readableWorkspace(latest, event.organizationId)) return null;
    if (event.type === "workspace.reassigned" && viewer && latest.createdBy !== viewer) return null;
    workspace = latest;
  }
  if (!confirmation) return undefined;
  if (event.type === "workspace.reassigned") {
    if (!viewer) return undefined;
    if (confirmation.createdBy !== viewer) return null;
  }
  return workspace;
}

function flushInboxNotices() {
  const visible = notices.filter((notice) => {
    const access = noticeAccess.get(notice);
    return access && confirmedWorkspace(access);
  });
  if (visible.length !== notices.length) publishNotices(visible);
  for (const [id, pending] of pendingNotices) {
    const workspace = confirmedWorkspace(pending);
    if (workspace === null || (pending.delivering && !workspace)) pendingNotices.delete(id);
    if (!workspace || pending.delivering) continue;
    pending.delivering = true;
    const { event } = pending;
    if (event.type === "workspace.reassigned") {
      const { actorId, previousOwnerId, note } = event.payload;
      const notice = { id, organizationId: event.organizationId, workspaceId: event.workspaceId, name: workspace.name, actorId, previousOwnerId, ...(typeof note === "string" ? { note: note.slice(0, 500) } : {}) };
      noticeAccess.set(notice, pending);
      publishNotices([...notices, notice].slice(-10));
    }
    const authorized = () => pendingNotices.get(id) === pending && !!confirmedWorkspace(pending);
    void notifyOrganizationEvent(event.type === "workspace.reassigned" ? "reassigned" : "share-added", authorized).finally(() => {
      if (pendingNotices.get(id) === pending) pendingNotices.delete(id);
    });
  }
}

async function confirmInboxNotices(orgId: string, batch: PendingNotice[]) {
  try {
    // This response belongs to a request issued after the inbox delivery was saved.
    // Cached rows, publication order and millisecond timestamps cannot prove that.
    const { workspaces, tombstones } = await api.cloudWorkspaces(cloudOrgArg(orgId));
    const deleted = new Set(tombstones?.map((workspace) => workspace.id));
    for (const pending of batch) {
      const { id, workspaceId } = pending.event;
      if (pendingNotices.get(id) !== pending) continue;
      const workspace = workspaces.find((row) => row.workspace.id === workspaceId)?.workspace;
      if (!deleted.has(workspaceId) && readableWorkspace(workspace, orgId)) pending.confirmation = workspace;
      else pendingNotices.delete(id);
    }
    flushInboxNotices();
    if (batch.some((pending) => pending.event.type === "workspace.reassigned" && !pending.delivering
      && pendingNotices.get(pending.event.id) === pending)) {
      // A full catalog feed supplies the native viewer ID for the reassignment owner check.
      await resyncCloudInboxCatalog();
      flushInboxNotices();
    }
  } catch {
    for (const pending of batch) {
      if (pendingNotices.get(pending.event.id) === pending && !pending.delivering) pendingNotices.delete(pending.event.id);
    }
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
  let queued: PendingNotice[] | null = null;
  const subscriber = new CloudInboxSubscriber(transport, storage, (event) => {
    const account = identity;
    const revisionAtEvent = revision;
    const token = generation;
    const initialRows = isNoticeEvent(event) ? getCloudCatalog().orgs[event.organizationId]?.workspaces : undefined;
    applyDesktopInboxEvent(event);
    if (!account || !isNoticeEvent(event)) return;
    if (event.type === "workspace.reassigned" && (!event.payload.actorId || !event.payload.previousOwnerId)) return;
    const current = () => {
      const status = getAccount().status;
      return token === generation && !privacyEnabled() && status.context?.account === account
        && status.context.revision === revisionAtEvent && liveCloudOrgIds(status).includes(event.organizationId)
        && phase2Ready(status, event.organizationId, "events")
        && (event.type !== "workspace.reassigned" || phase2Ready(status, event.organizationId, "followReassign"));
    };
    if (!current()) return;
    if (pendingNotices.size >= 100) pendingNotices.delete(pendingNotices.keys().next().value!);
    const pending: PendingNotice = { event, current, initialRows, requiresLiveRow: false };
    pendingNotices.set(event.id, pending);
    if (queued) {
      queued.push(pending);
      return;
    }
    const batch = [pending];
    queued = batch;
    // The subscriber saves the event IDs synchronously after apply. Check the
    // durable IDs before starting any best-effort banner work.
    void Promise.resolve().then(() => {
      if (queued === batch) queued = null;
      if (token !== generation) return;
      let cursor: unknown;
      let seen: unknown;
      try {
        const saved = JSON.parse(storage.getItem(`terminalx.inbox.v1:${encodeURIComponent(account)}`) ?? "null");
        cursor = saved?.cursor;
        seen = saved?.seen;
      } catch { /* A failed or unreadable checkpoint cannot authorize a banner. */ }
      const byOrg = new Map<string, PendingNotice[]>();
      for (const notice of batch) {
        const { id, organizationId } = notice.event;
        if (pendingNotices.get(id) !== notice) continue;
        const saved = validInboxCursor(cursor) && (BigInt(id) <= BigInt(cursor) || (Array.isArray(seen) && seen.includes(id)));
        if (!notice.current() || !saved) {
          pendingNotices.delete(id);
          continue;
        }
        const group = byOrg.get(organizationId);
        if (group) group.push(notice);
        else byOrg.set(organizationId, [notice]);
      }
      for (const [orgId, notices] of byOrg) void confirmInboxNotices(orgId, notices);
    });
  }, resyncCloudInboxCatalog);
  const sync = () => {
    const status = getAccount().status;
    const next = !privacyEnabled() && status.state === "signed-in" ? status.context?.account ?? null : null;
    const nextRevision = next ? status.context?.revision ?? null : null;
    const nextEventOrgs = status.phase2Readiness
      ? JSON.stringify(Object.keys(status.phase2Readiness).filter((org) => phase2Ready(status, org, "events")).sort())
      : null;
    if (next === identity && nextRevision === revision && nextEventOrgs === eventOrgs) {
      flushInboxNotices();
      return;
    }
    eventOrgs = nextEventOrgs;
    const token = ++generation;
    queued = null;
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
