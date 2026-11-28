import { endPairingInstance } from "./pairing-instance";
import { clearTranscriptCaches } from "../data/transcript-cache";
import { canonicalHttpsOrigin, canonicalRelayCellUrl, DirectEndpointsSchema } from "../pairing/contracts";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";

/** Where the paired machines are kept (no credentials: those are in the keychain). */
export const HOSTS_KEY = "terminalx:mobile:hosts:v1";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const relaySchema = z.object({
  v: z.literal(1),
  directorUrl: z.string().refine(canonicalHttpsOrigin),
  cellUrl: z.string().refine(canonicalRelayCellUrl),
  assignmentEpoch: z.number().int().nonnegative(),
  relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  e2eeFraming: z.literal(2),
});

const hostSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  // PRO-87 (see host-name.ts): the computer's own name, and a name typed on this phone. Both optional: entries saved before them still load.
  hostName: z.string().min(1).max(256).optional(),
  customName: z.string().min(1).max(256).optional(),
  // PRO-359: what the computer said of itself on the last connection. `headless`: no TerminalX window runs there (a server). Optional: older computers do not say.
  headless: z.boolean().optional(),
  platform: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
  publicKeyB64: z.string().min(1),
  directEndpoints: DirectEndpointsSchema.optional(),
  endpoint: z.string().min(1),
  relay: relaySchema.optional(),
  lastConnectedAt: z.number().int().nonnegative(),
  // PRO-314: when the Mac disconnected this phone (`pairing.disconnected`). Set, the app does not connect to it by itself; cleared once the person reconnects.
  disconnectedOnMacAt: z.number().int().nonnegative().optional(),
  provenance: z.discriminatedUnion("kind", [z.object({ kind: z.literal("explicit") }), z.object({ kind: z.literal("automatic"), userId: z.string().min(1) })]),
});

const credentialSchema = z.object({
  v: z.literal(1),
  deviceToken: z.string().min(1),
  current: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), version: z.number().int().positive(), expiresAt: z.number().int().nonnegative() }).optional(),
  grace: z.object({ token: z.string(), hash: z.string(), version: z.number().int().positive(), expiresAt: z.number().int().nonnegative() }).optional(),
  pending: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), reqId: z.string().min(1) }).optional(),
});

export type StoredHost = z.infer<typeof hostSchema>;
export type HostCredential = z.infer<typeof credentialSchema>;

/** Where a host list that is not JSON at all is copied, once, before anything is written over it. */
export const UNREADABLE_HOSTS_KEY = `${HOSTS_KEY}:unreadable`;

/**
 * The stored hosts this version can read, and the entries it cannot (a newer
 * version's, or a damaged one). One unreadable entry used to make the whole
 * list read as empty, and the next save then erased every pairing.
 */
async function readStored(): Promise<{ hosts: StoredHost[]; unreadable: unknown[] }> {
  const raw = await AsyncStorage.getItem(HOSTS_KEY);
  if (!raw) return { hosts: [], unreadable: [] };
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    entries = null;
  }
  if (!Array.isArray(entries)) {
    // Nothing in it can be kept beside new pairings: keep the whole of it aside instead.
    if (!(await AsyncStorage.getItem(UNREADABLE_HOSTS_KEY))) await AsyncStorage.setItem(UNREADABLE_HOSTS_KEY, raw);
    return { hosts: [], unreadable: [] };
  }
  const hosts: StoredHost[] = [];
  const unreadable: unknown[] = [];
  for (const entry of entries) {
    const parsed = hostSchema.safeParse(entry);
    if (parsed.success) hosts.push(parsed.data);
    else unreadable.push(entry);
  }
  return { hosts, unreadable };
}

/** Save `hosts` with the entries this version could not read, unchanged, after them. */
async function writeStored(hosts: StoredHost[], unreadable: unknown[]): Promise<void> {
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify([...hosts, ...unreadable]));
}

let changes: Promise<unknown> = Promise.resolve();

/**
 * Change the stored list, one change at a time: each reads what the one
 * before it wrote, so two at once (a pairing and a rename) both land.
 */
function changeHosts<T>(change: (hosts: StoredHost[]) => { hosts: StoredHost[]; result: T } | Promise<{ hosts: StoredHost[]; result: T }>): Promise<T> {
  const run = changes.then(async () => {
    const stored = await readStored();
    const next = await change(stored.hosts);
    await writeStored(next.hosts, stored.unreadable);
    return next.result;
  });
  changes = run.catch(() => undefined);
  return run;
}

export async function readHosts(): Promise<StoredHost[]> {
  return (await readStored()).hosts;
}

export async function readHostCredential(hostId: string): Promise<HostCredential | null> {
  const raw = await SecureStore.getItemAsync(credentialKey(hostId), OPTIONS).catch(() => null);
  if (!raw) return null;
  const parsed = credentialSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function savePairedHost(host: StoredHost, credential: HostCredential): Promise<void> {
  const validatedHost = hostSchema.parse(host);
  const validatedCredential = credentialSchema.parse(credential);
  await SecureStore.setItemAsync(credentialKey(host.id), JSON.stringify(validatedCredential), OPTIONS);
  const before = await changeHosts((hosts) => {
    // Pairing the same computer again keeps what it is called here: a name typed on this phone always, its own name unless a newer one came with the pairing.
    const previous = hosts.find((item) => item.id === host.id || item.publicKeyB64 === host.publicKeyB64);
    const named = { ...validatedHost, ...(previous?.customName ? { customName: previous.customName } : {}), ...(validatedHost.hostName ?? previous?.hostName ? { hostName: validatedHost.hostName ?? previous?.hostName } : {}) };
    return { hosts: [...hosts.filter((item) => item.id !== host.id && item.publicKeyB64 !== host.publicKeyB64), named], result: previous };
  });
  endPairingInstance(host.id);
  if (before && before.id !== host.id) endPairingInstance(before.id);
}

export async function writeHostCredential(hostId: string, credential: HostCredential): Promise<void> {
  await SecureStore.setItemAsync(credentialKey(hostId), JSON.stringify(credentialSchema.parse(credential)), OPTIONS);
}

/**
 * Save a host's connection details. Its names are not this function's to
 * change: the connection holds its own copy of the host for as long as it
 * runs, and writing that copy back must not undo a rename made meanwhile.
 * Names change only through [`setHostNames`].
 */
export async function updateStoredHost(host: StoredHost): Promise<void> {
  const { hostName: _hostName, customName: _customName, headless: _headless, platform: _platform, ...validated } = hostSchema.parse(host);
  // What the computer says of itself is kept as last stored: the connection's copy may predate it.
  const kept = (item: StoredHost) => ({ ...(item.hostName ? { hostName: item.hostName } : {}), ...(item.customName ? { customName: item.customName } : {}), ...(item.headless !== undefined ? { headless: item.headless } : {}), ...(item.platform ? { platform: item.platform } : {}) });
  await changeHosts((hosts) => ({ hosts: hosts.map((item) => item.id === host.id ? { ...validated, ...kept(item) } : item), result: undefined }));
}

/** Keep what the computer said of itself (PRO-359). Returns the stored host, or null when it is no longer paired. */
export async function setHostKind(hostId: string, kind: { headless: boolean; platform: string | null }): Promise<StoredHost | null> {
  return changeHosts((hosts) => {
    const current = hosts.find((item) => item.id === hostId);
    if (!current) return { hosts, result: null };
    const { platform: _platform, ...rest } = current;
    const next = hostSchema.parse({ ...rest, headless: kind.headless, ...(kind.platform ? { platform: kind.platform } : {}) });
    return { hosts: hosts.map((item) => item.id === hostId ? next : item), result: next };
  });
}

/**
 * Change what a computer is called (PRO-87): `hostName` is what it calls
 * itself, `customName` what this phone calls it (null clears it). Returns
 * the stored host, or null when it is no longer paired.
 */
export async function setHostNames(hostId: string, change: { hostName?: string; customName?: string | null }): Promise<StoredHost | null> {
  return changeHosts((hosts) => {
    const current = hosts.find((item) => item.id === hostId);
    if (!current) return { hosts, result: null };
    const { customName: previousCustom, ...rest } = current;
    const customName = change.customName === undefined ? previousCustom : change.customName ?? undefined;
    const next = hostSchema.parse({ ...rest, ...(change.hostName ? { hostName: change.hostName } : {}), ...(customName ? { customName } : {}) });
    return { hosts: hosts.map((item) => item.id === hostId ? next : item), result: next };
  });
}

export async function removeHost(hostId: string): Promise<void> {
  await clearTranscriptCaches(hostId);
  await changeHosts((hosts) => ({ hosts: hosts.filter((host) => host.id !== hostId), result: undefined }));
  endPairingInstance(hostId);
  await SecureStore.deleteItemAsync(credentialKey(hostId), OPTIONS).catch(() => undefined);
}

export async function removeAutomaticHosts(userId: string): Promise<void> {
  const automatic = await changeHosts((hosts) => {
    const automatic = hosts.filter((host) => host.provenance.kind === "automatic" && host.provenance.userId === userId);
    return { hosts: hosts.filter((host) => !automatic.includes(host)), result: automatic };
  });
  automatic.forEach((host) => endPairingInstance(host.id));
  await Promise.all(automatic.map((host) => clearTranscriptCaches(host.id)));
  await Promise.all(automatic.map((host) => SecureStore.deleteItemAsync(credentialKey(host.id), OPTIONS).catch(() => undefined)));
}

const credentialKey = (hostId: string) => `terminalx.mobile-relay.credentials.${hostId}`;
