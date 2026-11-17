// The setup check's first message (PRO-370, 12.07): the flow creates the
// "Setup check" workspace without a prompt, and once its first agent tab is
// known the message waits in that tab's composer, unsent, with a coach mark
// on Send. Nothing is sent for the person. The entry is kept on this Mac so
// an app restart before the tab is known still puts the draft there.

import { useSyncExternalStore } from "react";
import { findCloudWorkspace, getCloudCatalog, subscribeCloudCatalog } from "@/lib/cloudCatalog";
import { getDraft, setDraft } from "@/lib/drafts";
import { getSessionStore, selectCloudSession } from "@/lib/sessions";
import { cloudSessionKey, cloudWorkspaceKey } from "@/types/target";

interface Entry {
  orgId: string;
  workspaceId: string;
  text: string;
  tabId: string | null;
  coachDismissed: boolean;
  createdAt: number;
}

const KEY = "terminalx.setup-check-draft.v1";
/** A launch that never reports its tab within a day is not waited on. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function load(): Entry[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is Entry =>
            !!entry && typeof entry === "object" && typeof entry.orgId === "string" && typeof entry.workspaceId === "string" && typeof entry.text === "string" && typeof entry.createdAt === "number",
        )
      : [];
  } catch {
    return [];
  }
}

let entries = load();
const listeners = new Set<() => void>();

function store(next: Entry[]) {
  entries = next.filter((entry) => entry.tabId !== null || Date.now() - entry.createdAt < MAX_AGE_MS);
  try {
    if (entries.length) globalThis.localStorage?.setItem(KEY, JSON.stringify(entries));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* storage unavailable: kept for this run only */
  }
  for (const listener of listeners) listener();
}

/** The check message: install what each repository needs, run its tests and the app, and write down what changed. */
export function setupCheckMessage(repositories: readonly string[]): string {
  const names = repositories.map((fullName) => fullName.split("/").pop() ?? fullName);
  const list = names.length < 2 ? (names[0] ?? "each repository") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Set up this computer for development. Install what each repository needs, then check that tests and the app run in ${list}. Write what you changed to SETUP.md.`;
}

const following = new Map<string, () => void>();

/** Wait for the workspace's first agent tab, put the message in its composer and open it. */
function follow(entry: Entry, open: boolean) {
  const id = `${entry.orgId}:${entry.workspaceId}`;
  if (following.has(id) || entry.tabId) return;
  const check = () => {
    const item = findCloudWorkspace(getCloudCatalog(), entry.orgId, entry.workspaceId);
    const launch = item?.workspace.launch;
    if (!item || !launch?.tabId || !launch.sessionId) return;
    stop();
    if (!getDraft(launch.tabId)) setDraft(launch.tabId, entry.text);
    store(entries.map((other) => (other.orgId === entry.orgId && other.workspaceId === entry.workspaceId ? { ...other, tabId: launch.tabId! } : other)));
    // Opened only while the person is still on this workspace (or asked to open it just now).
    const selected = getSessionStore().selectedCloudWorkspace;
    if (open || selected === cloudWorkspaceKey(entry.orgId, entry.workspaceId)) selectCloudSession(cloudSessionKey(entry.orgId, entry.workspaceId, launch.sessionId));
  };
  const unsubscribe = subscribeCloudCatalog(check);
  const stop = () => {
    unsubscribe();
    following.delete(id);
  };
  following.set(id, stop);
  check();
}

/** Called once the setup check workspace is created. */
export function startSetupCheckDraft(orgId: string, workspaceId: string, text: string): void {
  const entry: Entry = { orgId, workspaceId, text, tabId: null, coachDismissed: false, createdAt: Date.now() };
  store([...entries.filter((other) => !(other.orgId === orgId && other.workspaceId === workspaceId)), entry]);
  follow(entry, true);
}

let booted = false;
/** After a restart: go on waiting for tabs not known yet, without opening anything. */
function boot() {
  if (booted) return;
  booted = true;
  for (const entry of entries) if (!entry.tabId) follow(entry, false);
}

/** Whether `tabId`'s composer shows the "Send this to check your new computer" coach mark. */
export function useSetupCheckCoach(tabId: string): { show: boolean; dismiss: () => void } {
  boot();
  const entry = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => entries.find((item) => item.tabId === tabId) ?? null,
  );
  return {
    show: Boolean(entry && !entry.coachDismissed),
    dismiss: () => store(entries.map((item) => (item.tabId === tabId ? { ...item, coachDismissed: true } : item))),
  };
}
