import { Channel, invoke } from "@tauri-apps/api/core";
import { getAccount, subscribeAccount } from "@/lib/account";
import { invalidateCloudCatalog, refreshCloudReadMarkers } from "@/lib/cloudCatalog";
import { flushReadMarkers, mergeReadMarkers, setReadMarkerAccount, type ReadMarker } from "@/lib/cloudReadMarkers";
import { subscribeInbox, type InboxBatch, type InboxEvent } from "@/lib/desktopInbox";
import { featureFlagEnabled, featureFlags } from "@/lib/featureFlags";
import { noteOrganizationEvent } from "@/lib/notify";

let started = false;
let active: string | null = null;
let stop: (() => void) | undefined;
let enabledOrgs = new Set<string>();
let activation = 0;
let markerRetry: ReturnType<typeof setTimeout> | undefined;
const saved = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* memory cursor remains */ } };
const enabled = (orgId: string) => featureFlagEnabled(getAccount().status, featureFlags.teamEvents, orgId);
function sync() {
  const status = getAccount().status;
  const owner = status.state === "signed-in" && status.desktopInbox === true && status.organizations?.some(org => enabled(org.id)) ? status.context?.account ?? null : null;
  setReadMarkerAccount(owner, enabled);
  const orgs = new Set(owner ? status.organizations?.filter(org => enabled(org.id)).map(org => org.id) : []);
  if (owner !== active || orgs.size !== enabledOrgs.size || [...orgs].some(id => !enabledOrgs.has(id))) {
    const run = ++activation;
    clearTimeout(markerRetry);
    if (owner) {
      const hydrate = () => {
        void refreshCloudReadMarkers().catch(() => {
          if (run === activation) markerRetry = setTimeout(hydrate, 5000);
        });
      };
      hydrate();
    }
  }
  enabledOrgs = orgs;
  if (owner === active) return;
  stop?.(); stop = undefined; active = owner;
  if (!owner) return;
  const cursorKey = `terminalx.inbox.${owner}`;
  const deviceKey = "terminalx.inbox.device";
  const deviceId = saved(deviceKey) ?? crypto.randomUUID();
  save(deviceKey, deviceId);
  let refresh = Promise.resolve();
  const refreshCatalog = (orgId?: string) => {
    refresh = refresh.catch(() => undefined).then(async () => {
      if (active === owner) await invalidateCloudCatalog(orgId);
    });
    return refresh;
  };
  const event = async (e: InboxEvent) => {
    if (active !== owner || !enabled(e.orgId)) return;
    if (e.type === "read-marker.changed" && e.workspaceId) {
      mergeReadMarkers([{ ...e.payload, orgId: e.orgId, workspaceId: e.workspaceId } as ReadMarker]);
    } else await refreshCatalog(e.orgId);
    if (active === owner && enabled(e.orgId) && e.notification) noteOrganizationEvent(e.notification);
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
  }, { event, save: cursor => save(cursorKey, cursor), fallback: () => { void refreshCatalog().catch(() => undefined); } }, saved(cursorKey) ?? "0");
}
export function bootCloudInbox() {
  if (started) return;
  started = true;
  subscribeAccount(sync);
  sync();
}
