import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import type { HostConnection } from "../transport/connection";

export interface HostNotification { seq: number; epoch: string; title: string; body: string; sessionId?: string; tabId?: string }

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function enableLocalNotifications(connection: HostConnection, hostId: string): Promise<boolean> {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;
  const watermark = await readWatermark(hostId);
  const missed = await connection.request<unknown>("notifications.missedSince", watermark ?? { lastSeenSeq: 0, epoch: null });
  if (missed.ok) {
    const events = notificationList(missed.value);
    for (const event of events) await showNotification(event);
    if (events.length) await writeWatermark(hostId, events[events.length - 1]!);
  }
  return (await connection.request("notifications.subscribe")).ok;
}

export async function handleNotificationEvent(hostId: string, value: unknown): Promise<void> {
  const event = parseNotification(value);
  if (!event) return;
  const watermark = await readWatermark(hostId);
  if (watermark?.epoch === event.epoch && event.seq <= watermark.lastSeenSeq) return;
  await showNotification(event);
  await writeWatermark(hostId, event);
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
