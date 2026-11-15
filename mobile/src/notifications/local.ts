import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { readHosts } from "../store/hosts";
import { hostDisplayName, FALLBACK_HOST_LABEL } from "../store/host-name";
import type { HostConnection } from "../transport/connection";
import { present, shouldShow, subscribeFilter, type HostNotification, type SubscribeFilter } from "./filter";
import { deliveryOn, type NotificationSettings } from "./model";
import { notificationPermission, requestNotificationPermission, type PermissionState } from "./permissions";
import { bindConnectionHost, loadNotificationSettings, onNotificationSettingsChanged, setMachineNotifications, updateNotificationSettings } from "./store";

/** One Mac's live notification stream on this phone. */
interface Delivery {
  connection: HostConnection;
  /** Set while subscribed. */
  unsubscribe?: () => void;
  /** The filter subscribed with; null when the Mac takes none (older Mac: empty params). */
  filterKey?: string | null;
}

const notificationQueues = new Map<string, Promise<void>>();
const deliveries = new Map<string, Delivery>();
const watchedConnections = new WeakSet<HostConnection>();

Notifications.setNotificationHandler({
  handleNotification: async (notification) => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: (notification.request.content.data as { silent?: unknown } | undefined)?.silent !== true,
    shouldSetBadge: false,
  }),
});

// A change of choices reaches every connected Mac: it subscribes, resubscribes with the new filter, or stops.
onNotificationSettingsChanged((settings) => {
  for (const [hostId, delivery] of deliveries) void reconcile(hostId, delivery.connection, settings);
});

/**
 * On connecting to a Mac: subscribe and catch up when its notifications are
 * on and iOS allows them. Resolves whether it subscribed.
 */
export async function restoreLocalNotifications(connection: HostConnection, hostId: string): Promise<boolean> {
  bindConnectionHost(connection, hostId);
  // One connection reaches one Mac at a time: a stream for the Mac it reached before is stale.
  for (const [other, delivery] of deliveries) if (other !== hostId && delivery.connection === connection) stop(other);
  deliveries.set(hostId, { ...deliveries.get(hostId), connection });
  watchCapabilities(connection);
  return reconcile(hostId, connection, await loadNotificationSettings(), true);
}

/** The pre-#990 per-Mac switch turned on: asks iOS, then turns on notifications and this Mac. */
export async function enableLocalNotifications(connection: HostConnection, hostId: string): Promise<boolean> {
  if ((await requestNotificationPermission()) !== "granted") return false;
  bindConnectionHost(connection, hostId);
  deliveries.set(hostId, { ...deliveries.get(hostId), connection });
  watchCapabilities(connection);
  await updateNotificationSettings((settings) => ({ ...settings, allow: true, machines: { ...settings.machines, [hostId]: true } }));
  return reconcile(hostId, connection, await loadNotificationSettings(), true);
}

/** The pre-#990 per-Mac switch turned off: this Mac's notifications stop. */
export async function disableLocalNotifications(hostId: string): Promise<void> {
  stop(hostId);
  await setMachineNotifications(hostId, false);
}

/** Whether this Mac's notifications reach the phone (master switch and machine on). */
export async function localNotificationsEnabled(hostId: string): Promise<boolean> {
  return deliveryOn(await loadNotificationSettings(), hostId);
}

/**
 * The master switch. Turning it on asks iOS when it has not been asked; the
 * choice is kept either way, and the screen shows the iOS state it returns.
 */
export async function setNotificationsAllowed(on: boolean): Promise<PermissionState> {
  const permission = on ? await requestNotificationPermission() : await notificationPermission();
  await updateNotificationSettings((settings) => ({ ...settings, allow: on }));
  return permission;
}

export async function handleNotificationEvent(hostId: string, value: unknown): Promise<void> {
  const event = parseNotification(value);
  if (!event) return;
  const settings = await loadNotificationSettings();
  if (!deliveryOn(settings, hostId)) return;
  await serialized(hostId, async () => {
    const watermark = await readWatermark(hostId);
    if (watermark?.epoch === event.epoch && event.seq <= watermark.lastSeenSeq) return;
    await deliver(hostId, event);
    await writeWatermark(hostId, event);
  });
}

/** Subscribe, resubscribe or stop, as the settings and iOS now say. */
async function reconcile(hostId: string, connection: HostConnection, settings: NotificationSettings, catchUp = false): Promise<boolean> {
  if (!deliveryOn(settings, hostId) || (await notificationPermission()) !== "granted") {
    stop(hostId);
    return false;
  }
  const delivery = deliveries.get(hostId);
  if (!delivery || delivery.connection !== connection) return false;
  const filter = (await takesFilters(connection)) ? subscribeFilter(settings, hostId) : null;
  const filterKey = filter ? JSON.stringify(filter) : null;
  if (delivery.unsubscribe && delivery.filterKey === filterKey && !catchUp) return true;
  if (catchUp || !delivery.unsubscribe) await catchUpMissed(hostId, connection, filter);
  // The connection may have moved to another Mac meanwhile.
  if (deliveries.get(hostId)?.connection !== connection) return false;
  delivery.unsubscribe?.();
  delivery.unsubscribe = connection.subscribe("notifications.subscribe", filter ? { filter } : {}, (value) => {
    const event = value && typeof value === "object" && "event" in value ? (value as { event?: unknown }).event : value;
    void handleNotificationEvent(hostId, event);
  });
  delivery.filterKey = filterKey;
  return true;
}

function stop(hostId: string): void {
  const delivery = deliveries.get(hostId);
  delivery?.unsubscribe?.();
  if (delivery) { delete delivery.unsubscribe; delete delivery.filterKey; }
}

async function catchUpMissed(hostId: string, connection: HostConnection, filter: SubscribeFilter | null): Promise<void> {
  await serialized(hostId, async () => {
    const watermark = await readWatermark(hostId);
    const missed = await connection.request<unknown>("notifications.missedSince", { ...(watermark ?? { lastSeenSeq: 0, epoch: null }), ...(filter ? { filter } : {}) });
    if (!missed.ok) return;
    for (const event of notificationList(missed.value)) {
      const current = await readWatermark(hostId);
      if (current?.epoch === event.epoch && event.seq <= current.lastSeenSeq) continue;
      await deliver(hostId, event);
      await writeWatermark(hostId, event);
    }
  });
}

/** Whether the Mac reads a subscribe filter (`sync.capabilities.notificationFilters`). */
async function takesFilters(connection: HostConnection): Promise<boolean> {
  try {
    const result = await connection.request<Record<string, unknown>>("sync.capabilities");
    return result.ok && !!result.value && result.value.notificationFilters === 1;
  } catch {
    return false;
  }
}

/** When the Mac's runtime changes (#730), what it offers may too: subscribe again with or without a filter. */
function watchCapabilities(connection: HostConnection): void {
  if (watchedConnections.has(connection)) return;
  watchedConnections.add(connection);
  connection.onEvent((event) => {
    if (event.method !== "sync.capabilitiesChanged") return;
    void loadNotificationSettings().then((settings) => {
      for (const [hostId, delivery] of deliveries) {
        if (delivery.connection !== connection || !delivery.unsubscribe) continue;
        delete delivery.filterKey;
        void reconcile(hostId, connection, settings);
      }
    });
  });
}

/** Show the notification when the phone's choices let it through. A notification held back still counts as seen. */
async function deliver(hostId: string, event: HostNotification): Promise<void> {
  const settings = await loadNotificationSettings();
  if (!shouldShow(settings, hostId, event, new Date())) return;
  const shown = present(settings, hostId, await machineName(hostId), event);
  await Notifications.scheduleNotificationAsync({
    content: {
      title: shown.title,
      body: shown.body,
      ...(shown.subtitle ? { subtitle: shown.subtitle } : {}),
      sound: shown.sound ? "default" : false,
      data: { ...shown.data, silent: !shown.sound },
    },
    trigger: null,
  });
}

async function machineName(hostId: string): Promise<string> {
  try {
    const host = (await readHosts()).find((item) => item.id === hostId);
    return host ? hostDisplayName(host) : FALLBACK_HOST_LABEL;
  } catch {
    return FALLBACK_HOST_LABEL;
  }
}

function notificationList(value: unknown): HostNotification[] {
  const events = (value as { events?: unknown } | null)?.events;
  return Array.isArray(events) ? events.map(parseNotification).filter((event): event is HostNotification => event !== null).sort((left, right) => left.seq - right.seq) : [];
}

export function parseNotification(value: unknown): HostNotification | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.seq) || typeof record.epoch !== "string" || typeof record.title !== "string" || typeof record.body !== "string") return null;
  const question = parseQuestion(record.question);
  const approval = record.approval && typeof record.approval === "object" && typeof (record.approval as { requestId?: unknown }).requestId === "string" ? { requestId: (record.approval as { requestId: string }).requestId } : null;
  return {
    seq: record.seq as number,
    epoch: record.epoch,
    title: record.title,
    body: record.body,
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(typeof record.tabId === "string" ? { tabId: record.tabId } : {}),
    ...(typeof record.kind === "string" && record.kind ? { kind: record.kind } : {}),
    ...(typeof record.sessionTitle === "string" ? { sessionTitle: record.sessionTitle } : {}),
    ...(question ? { question } : {}),
    ...(approval ? { approval } : {}),
  };
}

function parseQuestion(value: unknown): HostNotification["question"] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { requestId?: unknown; options?: unknown };
  if (typeof record.requestId !== "string") return null;
  const options = Array.isArray(record.options) ? record.options.filter((option): option is { label: string } => !!option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string").map((option) => ({ label: option.label })) : [];
  return { requestId: record.requestId, options };
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
