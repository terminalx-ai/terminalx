import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";

const HOSTS_KEY = "terminalx:mobile:hosts:v1";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const relaySchema = z.object({
  v: z.literal(1),
  directorUrl: z.string().url(),
  cellUrl: z.string().url(),
  assignmentEpoch: z.number().int().nonnegative(),
  relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  e2eeFraming: z.literal(2),
});

const hostSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  publicKeyB64: z.string().min(1),
  endpoint: z.string().min(1),
  relay: relaySchema.optional(),
  lastConnectedAt: z.number().int().nonnegative(),
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

export async function readHosts(): Promise<StoredHost[]> {
  const raw = await AsyncStorage.getItem(HOSTS_KEY);
  if (!raw) return [];
  const parsed = z.array(hostSchema).safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
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
  const hosts = await readHosts();
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify([...hosts.filter((item) => item.id !== host.id && item.publicKeyB64 !== host.publicKeyB64), validatedHost]));
}

export async function writeHostCredential(hostId: string, credential: HostCredential): Promise<void> {
  await SecureStore.setItemAsync(credentialKey(hostId), JSON.stringify(credentialSchema.parse(credential)), OPTIONS);
}

export async function updateStoredHost(host: StoredHost): Promise<void> {
  const validated = hostSchema.parse(host);
  const hosts = await readHosts();
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.map((item) => item.id === host.id ? validated : item)));
}

export async function removeHost(hostId: string): Promise<void> {
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify((await readHosts()).filter((host) => host.id !== hostId)));
  await SecureStore.deleteItemAsync(credentialKey(hostId), OPTIONS).catch(() => undefined);
}

export async function removeAutomaticHosts(userId: string): Promise<void> {
  const hosts = await readHosts();
  const automatic = hosts.filter((host) => host.provenance.kind === "automatic" && host.provenance.userId === userId);
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.filter((host) => !automatic.includes(host))));
  await Promise.all(automatic.map((host) => SecureStore.deleteItemAsync(credentialKey(host.id), OPTIONS).catch(() => undefined)));
}

const credentialKey = (hostId: string) => `terminalx.mobile-relay.credentials.${hostId}`;
