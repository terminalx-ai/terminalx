import { getAccount, subscribeAccount } from "@/lib/account";
import type { AccountStatus } from "@/lib/api";
import { findCloudWorkspace, getCloudCatalog, liveCloudOrgIds, subscribeCloudCatalog } from "@/lib/cloudCatalog";
import { isArchived } from "@/lib/cloudLifecycle";
import { getSessionStore, selectCloudSession, subscribeSessionStore } from "@/lib/sessions";
import { isCloudKey, parseCloudWorkspaceKey } from "@/types/target";

/**
 * The cloud session the window last showed, brought back after a relaunch
 * (PRO-23). Kept per account on this Mac, so another account's sidebar never
 * opens on it. Restoring only selects the session, as a click on its row
 * does: nothing connects, attaches or wakes beyond what its view does.
 *
 * It is restored once the account is known and the catalog (the saved one
 * is enough) lists the workspace, and only if nothing was chosen meanwhile.
 * Its unsent draft comes back with the tab's cache (`@/lib/cloudAgents`).
 */

const STORAGE_KEY = "terminalx.cloudSelection";

function readAll(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function remember(owner: string, key: string | null) {
  const all = readAll();
  if ((all[owner] ?? null) === key) return;
  if (key) all[owner] = key;
  else delete all[owner];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage refused: the next launch opens on the start screen, as before.
  }
}

function ownerOf(status: AccountStatus): string | null {
  return status.state === "signed-in" ? (status.identity?.email ?? null) : null;
}

/** A session key (`cloud:<org>:<workspace>:<session>`), or null for anything else. */
function cloudSessionOf(key: string | null): string | null {
  return key && isCloudKey(key) && parseCloudWorkspaceKey(key)?.sessionId ? key : null;
}

let booted: (() => void) | null = null;

/** Follow the selection, and restore the remembered one once. Idempotent. */
export function bootCloudSelection() {
  if (booted) return;
  const start = getSessionStore();
  // Untouched since launch: the start screen, nothing chosen.
  const untouched = () => {
    const now = getSessionStore();
    return now.navigationVersion === start.navigationVersion && !now.selectedSessionId && now.view === "new" && !now.cloudSessionPreset && !now.newSessionPreset && !now.selectedCloudWorkspace;
  };
  let restoring = true;
  // Undefined: what is shown now is written whatever it is.
  let last: string | null | undefined = start.selectedSessionId;

  const restore = () => {
    if (!untouched()) {
      // Something else was chosen first: that is what the window shows now.
      restoring = false;
      last = undefined;
      return;
    }
    const { status, ready } = getAccount();
    if (!ready) return;
    const owner = ownerOf(status);
    const key = owner ? cloudSessionOf(readAll()[owner] ?? null) : null;
    const parsed = key ? parseCloudWorkspaceKey(key) : null;
    // Signed out, nothing remembered, or its organization is not shown now.
    if (!owner || !key || !parsed || !liveCloudOrgIds(status).includes(parsed.orgId)) return void (restoring = false);
    const org = getCloudCatalog().orgs[parsed.orgId];
    const item = org ? findCloudWorkspace(getCloudCatalog(), parsed.orgId, parsed.workspaceId) : null;
    if (!item) {
      // This launch's list answered without it: gone, so forgotten.
      if (org?.source === "live" && !org.error) {
        restoring = false;
        remember(owner, null);
      }
      return;
    }
    restoring = false;
    if (!isArchived(item.workspace)) selectCloudSession(key);
  };

  const follow = () => {
    if (restoring) restore();
    if (restoring) return;
    const selected = getSessionStore().selectedSessionId;
    if (selected === last) return;
    last = selected;
    const owner = ownerOf(getAccount().status);
    if (owner) remember(owner, cloudSessionOf(selected));
  };

  const stops = [subscribeSessionStore(follow), subscribeAccount(follow), subscribeCloudCatalog(follow)];
  booted = () => {
    for (const stop of stops) stop();
  };
  follow();
}

/** For tests: stop following, so the next boot is a fresh launch. */
export function resetCloudSelection() {
  booted?.();
  booted = null;
}
