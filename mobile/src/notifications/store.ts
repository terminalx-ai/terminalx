import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";
import { defaultSettings, parseSettings, withOverride, withStartedSession, type NotificationSettings, type SessionOverride } from "./model";

export const SETTINGS_KEY = "terminalx:notification-settings:v1";
/** Before #990: one switch per Mac, "enabled" when on. */
export const LEGACY_PREFIX = "terminalx:notifications-enabled:";
const HOSTS_KEY = "terminalx:mobile:hosts:v1";

let current: NotificationSettings | null = null;
let loading: Promise<NotificationSettings> | null = null;
let writing: Promise<void> = Promise.resolve();
const listeners = new Set<(settings: NotificationSettings) => void>();

/** The settings, read (and migrated, once) on first use. */
export function loadNotificationSettings(): Promise<NotificationSettings> {
  if (current) return Promise.resolve(current);
  loading ??= readOrMigrate().then((settings) => {
    if (current) return current;
    current = settings;
    // A screen that rendered before the first read shows the settings now.
    for (const listener of [...listeners]) listener(settings);
    return current;
  }).finally(() => { loading = null; });
  return loading;
}

/** The settings read so far; null before the first read. */
export function notificationSettingsSnapshot(): NotificationSettings | null {
  return current;
}

/** Change the settings; they are saved in order, and every listener hears the new value. */
export async function updateNotificationSettings(change: (settings: NotificationSettings) => NotificationSettings): Promise<NotificationSettings> {
  const loaded = await loadNotificationSettings();
  // Applied to the latest value, not the one this call read before waiting:
  // two changes made at once (a switch and a started session) both stay.
  const next = change(current ?? loaded);
  current = next;
  const json = JSON.stringify(next);
  writing = writing.catch(() => undefined).then(() => AsyncStorage.setItem(SETTINGS_KEY, json));
  for (const listener of [...listeners]) listener(next);
  await writing;
  return next;
}

export function onNotificationSettingsChanged(listener: (settings: NotificationSettings) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For screens: the current settings (null while first read), re-rendered on every change. */
export function useNotificationSettings(): NotificationSettings | null {
  useEffect(() => { void loadNotificationSettings().catch(() => undefined); }, []);
  return useSyncExternalStore(onNotificationSettingsChanged, notificationSettingsSnapshot, notificationSettingsSnapshot);
}

export const setSessionOverride = (hostId: string, sessionId: string, mode: SessionOverride) =>
  updateNotificationSettings((settings) => withOverride(settings, hostId, sessionId, mode));

export const setMachineNotifications = (hostId: string, on: boolean) =>
  updateNotificationSettings((settings) => ({ ...settings, machines: { ...settings.machines, [hostId]: on } }));

/**
 * Read the saved settings; the first time, build them from the per-Mac
 * switches of before #990. A Mac whose switch was on stays on (and so does the
 * master switch); a paired Mac whose switch was off stays off. With no switch
 * on anywhere, everything starts off. The old values are left in place, so
 * an older app version still reads them. Saving the result makes this run once.
 */
async function readOrMigrate(): Promise<NotificationSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (raw !== null) {
    try {
      return parseSettings(JSON.parse(raw));
    } catch {
      return defaultSettings();
    }
  }
  const settings = defaultSettings();
  const keys = AsyncStorage.getAllKeys ? await AsyncStorage.getAllKeys() : [];
  const enabled: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    if ((await AsyncStorage.getItem(key)) === "enabled") enabled.push(key.slice(LEGACY_PREFIX.length));
  }
  if (enabled.length) {
    settings.allow = true;
    for (const hostId of await pairedHostIds()) settings.machines[hostId] = false;
    for (const hostId of enabled) settings.machines[hostId] = true;
  }
  if (current) return current;
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

/** Ids of the Macs paired on this phone, read without the pairing store (it brings the keychain with it). */
async function pairedHostIds(): Promise<string[]> {
  try {
    const hosts = JSON.parse((await AsyncStorage.getItem(HOSTS_KEY)) ?? "[]") as unknown;
    return Array.isArray(hosts) ? hosts.map((host) => (host as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

// Which Mac a connection currently reaches, set when notifications are restored on connecting.
const connectionHosts = new WeakMap<object, string>();

export function bindConnectionHost(connection: object, hostId: string): void {
  connectionHosts.set(connection, hostId);
}

export function connectionHost(connection: object): string | null {
  return connectionHosts.get(connection) ?? null;
}

/** A session this phone started: it counts as one of "Sessions I started or follow". */
export async function recordStartedSession(hostId: string, sessionId: string): Promise<void> {
  await updateNotificationSettings((settings) => withStartedSession(settings, hostId, sessionId));
}

/** For a session started over `connection` (host-api's createSession), when the connection's Mac is known. */
export async function recordStartedSessionOn(connection: object, sessionId: string): Promise<void> {
  const hostId = connectionHost(connection);
  if (hostId) await recordStartedSession(hostId, sessionId);
}

/** Tests only: forget what was read, as a fresh app start would. */
export function resetNotificationSettingsForTests(): void {
  current = null;
  loading = null;
  writing = Promise.resolve();
  listeners.clear();
}
