/**
 * Links to a chat tab (PRO-381): `terminalx://tab/<session-id>/<tab-id>`, the
 * tab menu's "Copy link to this tab". The native side builds a link with this
 * build's own scheme (`tab_link_for`) and, when one is opened, checks its
 * shape and hands `{ sessionId, tabId }` to the one link router
 * (`desktopLinks.ts`); a link that launched the app is followed once the
 * sessions are read.
 */
import { invoke } from "@tauri-apps/api/core";
import { showError } from "@/lib/errorToasts";
import { activatePeer } from "@/lib/sessionTabs";
import { getSessionStore, selectSession, subscribeSessionStore } from "@/lib/sessions";

/** A tab link as the native side validated it. */
export interface TabDeepLink {
  sessionId: string;
  tabId: string;
}

/** The link that opens `tabId` of `sessionId`, in this build's scheme. */
export function tabLinkFor(sessionId: string, tabId: string): Promise<string> {
  return invoke<string>("tab_link_for", { sessionId, tabId });
}

/** Once the sessions are read: a link that launched the app arrives before them. */
export function whenSessionsLoaded(): Promise<void> {
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
  await whenSessionsLoaded();
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
