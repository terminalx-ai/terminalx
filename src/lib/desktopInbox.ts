import { invoke } from "@/lib/api";
import { getAccount, subscribeAccount } from "@/lib/account";
import { privacyEnabled, subscribeDataPrivacy, PRIVACY_MESSAGE } from "@/lib/dataPrivacy";
import { CloudInboxSubscriber, type InboxEvent, type InboxStorage, type InboxTransport } from "@/lib/cloudInbox";
import { configureCloudReadMarkers, enableCloudReadMarkerWrites, reconcileCloudReadMarker } from "@/lib/cloudReadMarkers";
import { invalidateCloudInboxWorkspace, resyncCloudInboxCatalog } from "@/lib/cloudCatalog";

/** Exact commands implemented by the shared contracts worker. Use the existing
 * privacy-aware invoke wrapper; tokens and account fencing remain native.
 * The native readiness command holds production activation, including older builds. */
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
export function applyDesktopInboxEvent(event: InboxEvent) {
  switch (event.type) {
    case "workspace.share-removed":
      invalidateCloudInboxWorkspace(event.workspaceId, undefined, true);
      break;
    case "workspace.share-added":
    case "workspace.reassigned":
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
  const sync = () => {
    const status = getAccount().status;
    const next = !privacyEnabled() && status.state === "signed-in" ? status.context?.account ?? null : null;
    const nextRevision = next ? status.context?.revision ?? null : null;
    if (next === identity && nextRevision === revision) return;
    const token = ++generation;
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
    if (!next) return;
    void Promise.resolve().then(() => transport.phase2DesktopContractsAvailable()).then((ready) => {
      if (token !== generation || !ready) return;
      enableCloudReadMarkerWrites(next, (org, workspace, at, session) => transport.cloudWorkspaceReadMarker(org, workspace, at, session));
      subscriber.start(next);
    }).catch(() => { /* Held or older native build: catalog polling continues unchanged. */ });
  };
  const account = subscribeAccount(sync);
  const privacy = subscribeDataPrivacy(sync);
  stop = () => { ++generation; account(); privacy(); subscriber.stop(); configureCloudReadMarkers(null, null); };
  sync();
}
export function resetDesktopInbox() { stop?.(); stop = null; }
