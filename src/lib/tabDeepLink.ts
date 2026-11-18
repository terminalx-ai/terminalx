/**
 * Links to a chat tab (PRO-381): `terminalx://tab/<session-id>/<tab-id>`, the
 * tab menu's "Copy link to this tab". The native side builds a link with this
 * build's own scheme (`tab_link_for`) and, when one is opened, checks its
 * shape and keeps `{ sessionId, tabId }` until the webview takes it
 * (`tab_link_take`), pinging `tab_link_requested`; a link that launched the
 * app is taken at start, once the sessions are read.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { showError } from "@/lib/errorToasts";
import { activatePeer } from "@/lib/sessionTabs";
import { getSessionStore, selectSession, subscribeSessionStore } from "@/lib/sessions";

export const TAB_LINK_REQUESTED = "tab_link_requested";
export const TAB_LINK_TAKE = "tab_link_take";

/** A tab link as the native side validated it. */
export interface TabDeepLink {
  sessionId: string;
  tabId: string;
}

/** The link that opens `tabId` of `sessionId`, in this build's scheme. */
export function tabLinkFor(sessionId: string, tabId: string): Promise<string> {
  return invoke<string>("tab_link_for", { sessionId, tabId });
}

/** `{ sessionId, tabId }` and nothing else, or null: what the command returned is checked again here. */
export function asTabDeepLink(value: unknown): TabDeepLink | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("sessionId") || !keys.includes("tabId")) return null;
  const { sessionId, tabId } = value as Record<string, unknown>;
  return typeof sessionId === "string" && typeof tabId === "string" ? { sessionId, tabId } : null;
}

/** Once the sessions are read: a link that launched the app arrives before them. */
function whenLoaded(): Promise<void> {
  if (getSessionStore().loaded) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = subscribeSessionStore(() => {
      if (!getSessionStore().loaded) return;
      stop();
      resolve();
    });
  });
}

/** Open the tab a link names, or say it is gone (a closed tab, a deleted session, another Mac's link). */
export async function followTabDeepLink(link: TabDeepLink): Promise<boolean> {
  await whenLoaded();
  const session = getSessionStore().sessions.find((candidate) => candidate.id === link.sessionId);
  const tab = session?.tabs.find((candidate) => candidate.id === link.tabId);
  if (!session || !tab) {
    showError("", undefined, { title: "No open chat matches that link", key: "tab-link" });
    return false;
  }
  if (getSessionStore().selectedSessionId !== session.id) selectSession(session.id);
  activatePeer(session.id, { kind: "agent", id: tab.id });
  return true;
}

/**
 * Follow tab links for as long as the returned stop is not called: the one
 * that launched the app, then each one that arrives (as `bootSettingDeepLinks`).
 */
export function bootTabDeepLinks(): () => void {
  const take = () =>
    void invoke<unknown>(TAB_LINK_TAKE)
      .then((value) => {
        const link = asTabDeepLink(value);
        if (link) return followTabDeepLink(link);
      })
      .catch(() => undefined);
  const subscription = listen(TAB_LINK_REQUESTED, take).then(
    (unlisten) => { take(); return unlisten; },
    () => { take(); return () => undefined; },
  );
  return () => void subscription.then((unlisten) => unlisten());
}
