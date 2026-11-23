import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { errorMessage, invoke } from "@/lib/api";
import { getPrefs, setPrefs } from "@/lib/prefs";

/**
 * The cloud projects pinned on this computer, per organization, by repository
 * identity (#1403). They were the window's `cloudPinned` preference, which a
 * paired phone could not read; they are kept by the app now, where the phone
 * reads and changes them too. What a window's preferences hold is moved over
 * when this loads, and then cleared there: the first launch's, and any an
 * older build run since has pinned there, as it still keeps them.
 */
export interface CloudPins {
  orgs: Record<string, string[]>;
  adopted: boolean;
}

type Edit =
  | { kind: "set"; orgId: string; identity: string; pinned: boolean }
  | { kind: "adopt"; orgs: Record<string, string[]> }
  | { kind: "forget"; orgIds: string[] };

const EMPTY: Record<string, string[]> = {};
let pinned: Record<string, string[]> = EMPTY;
let error: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function publish(next: Record<string, string[]>) {
  pinned = next;
  notify();
}

function setError(next: string | null) {
  if (next === error) return;
  error = next;
  notify();
}

/** Only a reply shaped as the app's pins replaces what is shown. */
function receive(value: unknown): CloudPins | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { orgs?: unknown; adopted?: unknown };
  if (!record.orgs || typeof record.orgs !== "object") return null;
  const orgs: Record<string, string[]> = {};
  for (const [orgId, list] of Object.entries(record.orgs as Record<string, unknown>)) {
    if (Array.isArray(list)) orgs[orgId] = list.filter((entry): entry is string => typeof entry === "string");
  }
  publish(orgs);
  return { orgs, adopted: record.adopted === true };
}

async function edit(change: Edit): Promise<CloudPins | null> {
  return receive(await invoke<CloudPins>("edit_cloud_pins", { edit: change }));
}

/**
 * The window's pins go to the app, then leave the preferences: on the first
 * launch, and on a later one only when they hold a pin, which an older build
 * run since set there (it keeps pins in the preferences still). Moving adds and
 * never removes, so a pin set either way is kept.
 */
async function adoptWindowPins(saved: CloudPins | null) {
  // Not read: nothing is moved, and the preferences keep what they hold for the next launch.
  if (!saved) return;
  const window = getPrefs().cloudPinned ?? {};
  const held = Object.values(window).some((list) => list.length > 0);
  if ((held || !saved.adopted) && !(await edit({ kind: "adopt", orgs: window }))) return;
  if (held) setPrefs({ cloudPinned: {} });
}

let listening: Promise<void> | undefined;
/** Heard once per window, however often the first read is tried again. */
function listenOnce(): Promise<void> {
  return listening ??= (async () => {
    await listen<CloudPins>("cloud_pins_changed", (event) => { receive(event.payload); });
    await listen("local_runtime_reattached", () => {
      void invoke<CloudPins>("cloud_pins").then((value) => { if (receive(value)) setError(null); }, () => undefined);
    });
  })().catch((cause) => {
    listening = undefined;
    throw cause;
  });
}

let booted: Promise<void> | undefined;
export function bootCloudPins(): Promise<void> {
  return booted ??= (async () => {
    await listenOnce();
    const saved = receive(await invoke<CloudPins>("cloud_pins"));
    await adoptWindowPins(saved);
    setError(null);
  })().catch((cause) => {
    setError(errorMessage(cause));
    booted = undefined;
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The pinned cloud projects by organization, as the app keeps them. */
export function useCloudPins(): Record<string, string[]> {
  useEffect(() => { void bootCloudPins(); }, []);
  return useSyncExternalStore(subscribe, () => pinned);
}

export const getCloudPins = () => pinned;
export const cloudPinsError = () => error;

/** Why the pins could not be read, until a read succeeds; null while they are shown as kept. */
export function useCloudPinsError(): string | null {
  return useSyncExternalStore(subscribe, () => error);
}

/** Pin or unpin a cloud project; every window and paired phone hears of it. */
export async function setCloudProjectPinned(orgId: string, identity: string, pin: boolean): Promise<void> {
  await edit({ kind: "set", orgId, identity, pinned: pin });
}

/** Forget the pins of organizations `keep` does not name, as their other preferences are forgotten. */
export async function pruneCloudPins(keep: (orgId: string) => boolean): Promise<void> {
  const gone = Object.keys(pinned).filter((orgId) => !keep(orgId));
  if (gone.length) await edit({ kind: "forget", orgIds: gone });
}
