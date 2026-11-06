import { Channel, invoke } from "@tauri-apps/api/core";
import { getAccount, subscribeAccount } from "@/lib/account";
import { refreshCloudCatalog, refreshCloudFeed } from "@/lib/cloudCatalog";
import { flushReadMarkers, mergeReadMarkers, setReadMarkerAccount, type ReadMarker } from "@/lib/cloudReadMarkers";
import { subscribeInbox, type InboxBatch, type InboxEvent } from "@/lib/desktopInbox";
import { noteOrganizationEvent } from "@/lib/notify";

let started = false;
let active: string | null = null;
let stop: (() => void) | undefined;
const saved = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* memory cursor remains */ } };
function sync() {
  const status = getAccount().status;
  const owner = status.state === "signed-in" && status.desktopInbox === true ? status.context?.account ?? null : null;
  if (owner === active) return;
  stop?.(); stop = undefined; active = owner;
  setReadMarkerAccount(owner);
  if (!owner) return;
  const cursorKey = `terminalx.inbox.${owner}`;
  const deviceKey = "terminalx.inbox.device";
  const deviceId = saved(deviceKey) ?? crypto.randomUUID();
  save(deviceKey, deviceId);
  let refresh = Promise.resolve();
  const refreshCatalog = (orgId?: string) => {
    refresh = refresh.then(async () => {
      if (active !== owner) return;
      // A feed that started before the event may be stale. Await it, then
      // request once more so coalescing cannot hide the invalidation.
      await refreshCloudFeed();
      if (active !== owner) return;
      await refreshCloudFeed();
      if (orgId && !getAccount().status.catalogFeed) await refreshCloudCatalog(orgId);
    }).catch(() => undefined);
    return refresh;
  };
  const event = async (e: InboxEvent) => {
    if (active !== owner) return;
    if (e.type === "read-marker.changed" && e.workspaceId) {
      mergeReadMarkers([{ ...e.payload, orgId: e.orgId, workspaceId: e.workspaceId } as ReadMarker]);
    } else await refreshCatalog(e.orgId);
    if (active === owner && e.notification) noteOrganizationEvent(e.notification);
  };
  stop = subscribeInbox({
    async stream(cursor, receive, signal) {
      const streamId = crypto.randomUUID();
      const channel = new Channel<InboxBatch>();
      channel.onmessage = batch => { if (!signal.aborted) { receive(batch); void flushReadMarkers(); } };
      const cancel = () => { void invoke("desktop_inbox_stop", { streamId }).catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try { await invoke("desktop_inbox_stream", { owner, streamId, cursor, channel }); }
      finally { signal.removeEventListener("abort", cancel); }
    },
    poll: cursor => invoke("desktop_inbox_poll", { owner, cursor }),
    receipt: cursor => invoke("desktop_inbox_receipt", { owner, deviceId, cursor }),
  }, { event, save: cursor => save(cursorKey, cursor), fallback: () => { void refreshCatalog(); } }, saved(cursorKey) ?? "0");
}
export function bootCloudInbox() {
  if (started) return;
  started = true;
  subscribeAccount(sync);
  sync();
}
