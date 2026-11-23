import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Which organization this person is setting up cloud workspaces in (25.02).
 * It is the one thing of the setup the phone keeps: choosing the personal
 * organization changes nothing on the server, so only the phone can know it
 * was chosen. How far that organization's setup is, is always read from the
 * server. The choice is an organization's id beside the account's, not a
 * secret; it is dropped when someone signs out or another account signs in.
 */
const KEY = "terminalx:cloud-setup-organization:v1";

interface Choice { userId: string; orgId: string }

let choice: Choice | null = null;
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function load(): Promise<void> {
  return loading ??= AsyncStorage.getItem(KEY).catch(() => null).then((kept) => {
    // A choice made while the kept one was being read is the newer one.
    if (!loaded) choice = parse(kept);
    loaded = true;
    publish();
  });
}

function parse(kept: string | null): Choice | null {
  try {
    const value: unknown = kept ? JSON.parse(kept) : null;
    if (value && typeof value === "object" && "userId" in value && "orgId" in value && typeof value.userId === "string" && typeof value.orgId === "string" && value.userId && value.orgId) return { userId: value.userId, orgId: value.orgId };
  } catch { /* Not ours, or damaged: there is no choice. */ }
  return null;
}

function forget(): void {
  if (!choice) return;
  choice = null;
  void AsyncStorage.removeItem(KEY).catch(() => undefined);
  publish();
}

/** Keep `orgId` as the organization `userId` is setting up. */
export function chooseSetupOrganization(userId: string, orgId: string): void {
  choice = { userId, orgId };
  loaded = true;
  void AsyncStorage.setItem(KEY, JSON.stringify(choice)).catch(() => undefined);
  publish();
}

/**
 * The organization the signed-in person chose to set up, or null. `userId` is
 * undefined until the app knows whether anyone is signed in, and null when
 * nobody is. `ready` is false until what was kept has been read.
 */
export function useSetupChoice(userId: string | null | undefined): { ready: boolean; orgId: string | null } {
  const current = useSyncExternalStore(subscribe, () => choice, () => choice);
  const ready = useSyncExternalStore(subscribe, () => loaded, () => loaded);
  useEffect(() => { void load(); }, []);
  // Signed out, or someone else's: nothing of it stays.
  useEffect(() => { if (ready && userId !== undefined && current && current.userId !== userId) forget(); }, [current, ready, userId]);
  return { ready, orgId: current && userId && current.userId === userId ? current.orgId : null };
}

/** For tests: as a freshly started app. */
export function resetSetupChoiceForTests(): void {
  choice = null;
  loaded = false;
  loading = null;
}
