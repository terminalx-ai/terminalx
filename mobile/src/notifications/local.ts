import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import type { HostConnection } from "../transport/connection";

export interface HostNotification { seq: number; epoch: string; title: string; body: string; sessionId?: string; tabId?: string }

const notificationQueues = new Map<string, Promise<void>>();
const notificationSubscriptions = new Map<string, () => void>();

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function enableLocalNotifications(connection: HostConnection, hostId: string): Promise<boolean> {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;
  await AsyncStorage.setItem(preferenceKey(hostId), "enabled");
  const enabled = await subscribeAndCatchUp(connection, hostId);
  if (!enabled) await AsyncStorage.removeItem(preferenceKey(hostId));
  return enabled;
}

export async function restoreLocalNotifications(connection: HostConnection, hostId: string): Promise<boolean> {
  if (!(await localNotificationsEnabled(hostId))) return false;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return false;
  return subscribeAndCatchUp(connection, hostId);
}

export async function disableLocalNotifications(hostId: string): Promise<void> {
  notificationSubscriptions.get(hostId)?.();
  notificationSubscriptions.delete(hostId);
  await AsyncStorage.removeItem(preferenceKey(hostId));
}

export async function localNotificationsEnabled(hostId: string): Promise<boolean> {
  return (await AsyncStorage.getItem(preferenceKey(hostId))) === "enabled";
}

export async function handleNotificationEvent(hostId: string, value: unknown): Promise<void> {
  const event = parseNotification(value);
  if (!event || !(await localNotificationsEnabled(hostId))) return;
  await serialized(hostId, async () => {
    const watermark = await readWatermark(hostId);
    if (watermark?.epoch === event.epoch && event.seq <= watermark.lastSeenSeq) return;
    await showNotification(event);
    await writeWatermark(hostId, event);
  });
}

async function subscribeAndCatchUp(connection: HostConnection, hostId: string): Promise<boolean> {
  await serialized(hostId, async () => {
    const watermark = await readWatermark(hostId);
    const missed = await connection.request<unknown>("notifications.missedSince", watermark ?? { lastSeenSeq: 0, epoch: null });
    if (!missed.ok) return;
    const events = notificationList(missed.value);
    for (const event of events) {
      const current = await readWatermark(hostId);
      if (current?.epoch === event.epoch && event.seq <= current.lastSeenSeq) continue;
      await showNotification(event);
      await writeWatermark(hostId, event);
    }
  });
  notificationSubscriptions.get(hostId)?.();
  notificationSubscriptions.set(hostId, connection.subscribe("notifications.subscribe", {}, (value) => {
    const event = value && typeof value === "object" && "event" in value ? (value as { event?: unknown }).event : value;
    void handleNotificationEvent(hostId, event);
  }));
  return true;
}

async function showNotification(event: HostNotification): Promise<void> {
  await Notifications.scheduleNotificationAsync({ content: { title: event.title, body: event.body, data: { sessionId: event.sessionId ?? "", tabId: event.tabId ?? "" } }, trigger: null });
}

function notificationList(value: unknown): HostNotification[] {
  const events = (value as { events?: unknown } | null)?.events;
  return Array.isArray(events) ? events.map(parseNotification).filter((event): event is HostNotification => event !== null).sort((left, right) => left.seq - right.seq) : [];
}

function parseNotification(value: unknown): HostNotification | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.seq) || typeof record.epoch !== "string" || typeof record.title !== "string" || typeof record.body !== "string") return null;
  return { seq: record.seq as number, epoch: record.epoch, title: record.title, body: record.body, ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}), ...(typeof record.tabId === "string" ? { tabId: record.tabId } : {}) };
}

async function readWatermark(hostId: string): Promise<{ lastSeenSeq: number; epoch: string } | null> {
  try {
    const raw = await AsyncStorage.getItem(`terminalx:notifications:${hostId}`);
    const value = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    return value && Number.isSafeInteger(value.lastSeenSeq) && typeof value.epoch === "string" ? { lastSeenSeq: value.lastSeenSeq as number, epoch: value.epoch } : null;
  } catch {
    return null;
  }
}

const writeWatermark = (hostId: string, event: HostNotification) => AsyncStorage.setItem(`terminalx:notifications:${hostId}`, JSON.stringify({ lastSeenSeq: event.seq, epoch: event.epoch }));
const preferenceKey = (hostId: string) => `terminalx:notifications-enabled:${hostId}`;

async function serialized(hostId: string, action: () => Promise<void>): Promise<void> {
  const previous = notificationQueues.get(hostId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  notificationQueues.set(hostId, next);
  try {
    await next;
  } finally {
    if (notificationQueues.get(hostId) === next) notificationQueues.delete(hostId);
  }
}
