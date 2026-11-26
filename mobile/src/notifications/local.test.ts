import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnection } from "../transport/connection";

const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  permission: { granted: true, status: "granted" } as { granted: boolean; status: string },
  asked: 0,
  scheduled: [] as { content: Record<string, unknown>; trigger?: unknown }[],
  os: "ios",
  channels: [] as string[],
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => fake.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void fake.storage.set(key, value),
    removeItem: async (key: string) => void fake.storage.delete(key),
    getAllKeys: async () => [...fake.storage.keys()],
  },
}));
vi.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: async () => null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "client-id" }));
vi.mock("react-native", () => ({ Linking: { openSettings: vi.fn(async () => undefined) }, Platform: { get OS() { return fake.os; } } }));
vi.mock("expo-notifications", () => ({
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: async () => fake.permission,
  requestPermissionsAsync: async () => { fake.asked++; fake.permission = { granted: true, status: "granted" }; return fake.permission; },
  scheduleNotificationAsync: async (request: { content: Record<string, unknown> }) => { fake.scheduled.push(request); return "id"; },
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  setNotificationChannelAsync: async (id: string) => { fake.channels.push(id); return null; },
}));

const HOSTS = "terminalx:mobile:hosts:v1";

interface FakeMac {
  connection: HostConnection;
  subscribes: { params: unknown; listener: (value: unknown) => void; closed: boolean }[];
  missed: unknown[];
  capabilities: Record<string, unknown>;
  missedEvents: unknown[];
  emit: (method: string) => void;
  /** Hold the next request of a method until the test releases it. */
  gates: Map<string, Promise<void>>;
}

function mac(capabilities: Record<string, unknown> = {}): FakeMac {
  const events = new Set<(event: { method: string }) => void>();
  const state: FakeMac = {
    subscribes: [], missed: [], capabilities, missedEvents: [], gates: new Map(),
    emit: (method) => { for (const listener of events) listener({ method }); },
    connection: {} as HostConnection,
  };
  state.connection = {
    request: vi.fn(async (method: string, params: unknown) => {
      const gate = state.gates.get(method);
      if (gate) { state.gates.delete(method); await gate; }
      if (method === "sync.capabilities") return { ok: true, value: state.capabilities };
      if (method === "notifications.missedSince") { state.missed.push(params); return { ok: true, value: { events: state.missedEvents } }; }
      if (method === "sessions.create") return { ok: true, value: { sessionId: "s-new", tabId: "t-new", title: "Hi", sent: { status: "sent", queued: false } } };
      return { ok: false, refusal: { code: "unknown", message: method } };
    }),
    subscribe: vi.fn((_method: string, params: unknown, listener: (value: unknown) => void) => {
      const entry = { params, listener, closed: false };
      state.subscribes.push(entry);
      return () => { entry.closed = true; };
    }),
    onEvent: (listener: (event: { method: string }) => void) => { events.add(listener); return () => events.delete(listener); },
  } as unknown as HostConnection;
  return state;
}

function gate(state: FakeMac, method: string): () => void {
  let release = () => undefined as void;
  state.gates.set(method, new Promise<void>((resolve) => { release = resolve; }));
  return () => release();
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const live = (state: FakeMac) => state.subscribes.filter((entry) => !entry.closed);

async function modules() {
  vi.resetModules();
  const store = await import("./store");
  const local = await import("./local");
  return { store, local };
}

beforeEach(() => {
  fake.storage.clear();
  fake.permission = { granted: true, status: "granted" };
  fake.asked = 0;
  fake.scheduled = [];
  fake.channels = [];
});

describe("migration from the per-Mac switch", () => {
  it("keeps a Mac that was on, with the master on and default kinds; other paired Macs stay off", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    fake.storage.set(HOSTS, JSON.stringify([{ id: "mac" }, { id: "mini" }]));
    const { store } = await modules();
    const settings = await store.loadNotificationSettings();
    expect(settings.allow).toBe(true);
    expect(settings.machines).toEqual({ mac: true, mini: false });
    expect(settings.kinds.question && settings.kinds.finished && !settings.kinds.pr_merged).toBe(true);
    expect(fake.storage.get("terminalx:notifications-enabled:mac")).toBe("enabled");
  });

  it("starts with everything off when no Mac had it on", async () => {
    fake.storage.set(HOSTS, JSON.stringify([{ id: "mac" }]));
    const { store } = await modules();
    expect((await store.loadNotificationSettings()).allow).toBe(false);
  });

  it("runs once: a later start reads the saved choices, not the old switches", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    let { store } = await modules();
    await store.updateNotificationSettings((settings) => ({ ...settings, allow: false }));
    ({ store } = await modules());
    expect((await store.loadNotificationSettings()).allow).toBe(false);
    // Two first reads at once migrate once.
    fake.storage.delete(store.SETTINGS_KEY);
    ({ store } = await modules());
    const [first, second] = await Promise.all([store.loadNotificationSettings(), store.loadNotificationSettings()]);
    expect(first).toBe(second);
    expect(first.allow).toBe(true);
  });

  it("keeps both of two changes made at once", async () => {
    const { store } = await modules();
    await Promise.all([
      store.setSessionOverride("mac", "s-2", "mute"),
      store.recordStartedSession("mac", "s-new"),
      store.updateNotificationSettings((settings) => ({ ...settings, allow: true })),
    ]);
    const settings = await store.loadNotificationSettings();
    expect([settings.allow, settings.perSession, settings.started]).toEqual([true, { mac: { "s-2": "mute" } }, { mac: ["s-new"] }]);
    expect(JSON.parse(fake.storage.get(store.SETTINGS_KEY)!)).toEqual(settings);
  });

  it("asks iOS when the master switch is turned on", async () => {
    fake.permission = { granted: false, status: "undetermined" };
    const { store, local } = await modules();
    await expect(local.setNotificationsAllowed(true)).resolves.toBe("granted");
    expect(fake.asked).toBe(1);
    expect((await store.loadNotificationSettings()).allow).toBe(true);
    fake.permission = { granted: false, status: "denied" };
    await expect(local.setNotificationsAllowed(true)).resolves.toBe("denied");
    expect(fake.asked).toBe(1);
  });
});

describe("subscribing", () => {
  it("sends the filter to a Mac that takes one, and to missedSince", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    const state = mac({ notificationFilters: 1 });
    const { local } = await modules();
    await expect(local.restoreLocalNotifications(state.connection, "mac")).resolves.toBe(true);
    const filter = { kinds: ["question", "approval", "finished", "failed", "pr_checks_failed"], sessions: { scope: "all" }, overrides: {} };
    expect(state.missed).toEqual([{ lastSeenSeq: 0, epoch: null, filter }]);
    expect(live(state).map((entry) => entry.params)).toEqual([{ filter }]);
  });

  it("sends empty params to an older Mac", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    const state = mac();
    const { local } = await modules();
    await local.restoreLocalNotifications(state.connection, "mac");
    expect(state.missed).toEqual([{ lastSeenSeq: 0, epoch: null }]);
    expect(live(state).map((entry) => entry.params)).toEqual([{}]);
  });

  it("resubscribes when the choices change, and stops when the machine is turned off", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    const state = mac({ notificationFilters: 1 });
    const { store, local } = await modules();
    await local.restoreLocalNotifications(state.connection, "mac");
    await store.setSessionOverride("mac", "s-2", "mute");
    await flush();
    expect(live(state).map((entry) => entry.params)).toEqual([{ filter: { kinds: ["question", "approval", "finished", "failed", "pr_checks_failed"], sessions: { scope: "all" }, overrides: { "s-2": "mute" } } }]);
    expect(state.missed).toHaveLength(1);
    await store.setMachineNotifications("mac", false);
    await flush();
    expect(live(state)).toEqual([]);
    expect(await local.localNotificationsEnabled("mac")).toBe(false);
    await store.setMachineNotifications("mac", true);
    await flush(); await flush();
    expect(live(state)).toHaveLength(1);
  });

  it("still registers the stream when the Mac is disconnected, and changes made offline do not throw", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    const state = mac({ notificationFilters: 1 });
    (state.connection.request as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Host is disconnected"));
    const { store, local } = await modules();
    await expect(local.restoreLocalNotifications(state.connection, "mac")).resolves.toBe(true);
    expect(live(state).map((entry) => entry.params)).toEqual([{}]);
    await store.setSessionOverride("mac", "s-2", "mute");
    await local.refreshLocalNotifications();
    await flush(); await flush();
    expect(live(state)).toHaveLength(1);
    expect(fake.storage.has("terminalx:notifications:mac")).toBe(false);
  });

  it("does not subscribe while iOS has notifications off", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    fake.permission = { granted: false, status: "denied" };
    const state = mac({ notificationFilters: 1 });
    const { local } = await modules();
    await expect(local.restoreLocalNotifications(state.connection, "mac")).resolves.toBe(false);
    expect(state.subscribes).toEqual([]);
    // Turned on in iOS Settings, then back in the app: it subscribes without reconnecting.
    fake.permission = { granted: true, status: "granted" };
    await expect(local.refreshLocalNotifications()).resolves.toBe("granted");
    expect(live(state)).toHaveLength(1);
    // And off again: it stops.
    fake.permission = { granted: false, status: "denied" };
    await expect(local.refreshLocalNotifications()).resolves.toBe("denied");
    expect(live(state)).toEqual([]);
  });
});

describe("one connection moving between Macs", () => {
  const both = () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    fake.storage.set("terminalx:notifications-enabled:mini", "enabled");
  };

  it("drops the old Mac's entry: later changes and refreshes do not subscribe it again under the old host", async () => {
    both();
    const state = mac({ notificationFilters: 1 });
    const { store, local } = await modules();
    await local.restoreLocalNotifications(state.connection, "mac");
    await local.restoreLocalNotifications(state.connection, "mini");
    expect(live(state)).toHaveLength(1);
    // A change for the old Mac, one for every Mac, and a foreground refresh.
    await store.setSessionOverride("mac", "s-2", "mute");
    await store.updateNotificationSettings((settings) => ({ ...settings, kinds: { ...settings.kinds, pr_merged: true } }));
    await flush(); await flush();
    await local.refreshLocalNotifications();
    await flush();
    // Only mini's stream, with mini's filter (no mac override), resubscribed once for the new kind.
    expect(live(state).map((entry) => entry.params)).toEqual([{ filter: { kinds: ["question", "approval", "finished", "failed", "pr_checks_failed", "pr_merged"], sessions: { scope: "all" }, overrides: {} } }]);
    expect(state.missed).toHaveLength(2);
    // What the connection now delivers is mini's: its watermark moves, mac's does not.
    live(state)[0]!.listener({ event: { seq: 7, epoch: "m", title: "Done", body: "Finished", kind: "finished", sessionId: "s-1", tabId: "t-1" } });
    await flush(); await flush();
    expect(JSON.parse(fake.storage.get("terminalx:notifications:mini")!)).toEqual({ lastSeenSeq: 7, epoch: "m" });
    expect(fake.storage.has("terminalx:notifications:mac")).toBe(false);
    expect(fake.scheduled.map((request) => (request.content.data as { hostId: string }).hostId)).toEqual(["mini"]);
  });

  it("does not keep a catch-up the old Mac answered after the connection moved", async () => {
    both();
    const state = mac();
    const release = gate(state, "notifications.missedSince");
    state.missedEvents = [{ seq: 3, epoch: "e", title: "Done", body: "Finished", sessionId: "s-1", tabId: "t-1" }];
    const { local } = await modules();
    const first = local.restoreLocalNotifications(state.connection, "mac");
    await flush();
    const second = local.restoreLocalNotifications(state.connection, "mini");
    release();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(fake.storage.has("terminalx:notifications:mac")).toBe(false);
    expect(live(state)).toHaveLength(1);
    expect(fake.scheduled.map((request) => (request.content.data as { hostId: string }).hostId)).toEqual(["mini"]);
  });

  it("subscribes with the latest choices when an earlier resubscribe answers late", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    const state = mac({ notificationFilters: 1 });
    const { store, local } = await modules();
    await local.restoreLocalNotifications(state.connection, "mac");
    const release = gate(state, "sync.capabilities");
    await store.setSessionOverride("mac", "s-2", "mute");
    await store.setSessionOverride("mac", "s-2", "default");
    release();
    await flush(); await flush(); await flush();
    expect(live(state).map((entry) => entry.params)).toEqual([{ filter: { kinds: ["question", "approval", "finished", "failed", "pr_checks_failed"], sessions: { scope: "all" }, overrides: {} } }]);
  });
});

describe("delivery", () => {
  it("filters on the phone for an older Mac and still moves the watermark past what it held back", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    fake.storage.set(HOSTS, JSON.stringify([{ id: "mac", label: "Paired Mac", hostName: "Studio MacBook", publicKeyB64: "key", endpoint: "ws://mac.local", lastConnectedAt: 1, provenance: { kind: "explicit" } }]));
    fake.storage.set("terminalx:notifications:mac", JSON.stringify({ lastSeenSeq: 1, epoch: "e" }));
    const state = mac();
    state.missedEvents = [
      { seq: 1, epoch: "e", title: "seen before", body: "", sessionId: "s-1", tabId: "t-1" },
      { seq: 2, epoch: "e", title: "Limit", body: "Reached a usage limit", sessionId: "s-1", tabId: "t-1", kind: "usage_limit" },
      { seq: 3, epoch: "e", title: "Done", body: "Finished", sessionId: "s-1", tabId: "t-1", kind: "finished" },
    ];
    const { local } = await modules();
    await local.restoreLocalNotifications(state.connection, "mac");
    expect(fake.scheduled.map((request) => request.content)).toEqual([{ title: "Done", body: "Finished", subtitle: "Studio MacBook", threadIdentifier: "mac:s-1", sound: "default", data: { hostId: "mac", sessionId: "s-1", tabId: "t-1", kind: "finished", detailsHidden: false, silent: false } }]);
    expect(fake.scheduled[0]!.trigger).toBeNull();
    expect(JSON.parse(fake.storage.get("terminalx:notifications:mac")!)).toEqual({ lastSeenSeq: 3, epoch: "e" });
    // A live event already seen is not shown again; a new one is.
    live(state)[0]!.listener({ event: { seq: 3, epoch: "e", title: "Done", body: "Finished", kind: "finished" } });
    live(state)[0]!.listener({ event: { seq: 4, epoch: "e", title: "Old Mac", body: "No kind", sessionId: "s-1", tabId: "t-1" } });
    await flush(); await flush();
    expect(fake.scheduled.map((request) => request.content.title)).toEqual(["Done", "Old Mac"]);
  });

  it("sends Android notifications on the channel that sounds, Android sounding by channel rather than by notification", async () => {
    fake.os = "android";
    try {
      fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
      fake.storage.set(HOSTS, JSON.stringify([{ id: "mac", label: "Paired Mac", hostName: "Studio MacBook", publicKeyB64: "key", endpoint: "ws://mac.local", lastConnectedAt: 1, provenance: { kind: "explicit" } }]));
      fake.storage.set("terminalx:notifications:mac", JSON.stringify({ lastSeenSeq: 0, epoch: "e" }));
      const state = mac();
      state.missedEvents = [{ seq: 1, epoch: "e", title: "Done", body: "Finished", sessionId: "s-1", tabId: "t-1", kind: "finished" }];
      const { local } = await modules();
      await local.restoreLocalNotifications(state.connection, "mac");
      expect(fake.scheduled.map((request) => request.trigger)).toEqual([{ channelId: "alerts" }]);
      expect(fake.channels.sort()).toEqual(["alerts", "quiet"]);
    } finally {
      fake.os = "ios";
    }
  });

  it("keeps the old exports working: enable turns on the master and the machine, disable turns the machine off", async () => {
    const state = mac();
    const { store, local } = await modules();
    await expect(local.enableLocalNotifications(state.connection, "mac")).resolves.toBe(true);
    expect((await store.loadNotificationSettings()).allow).toBe(true);
    expect(live(state)).toHaveLength(1);
    await local.disableLocalNotifications("mac");
    expect(live(state)).toEqual([]);
    expect((await store.loadNotificationSettings()).machines.mac).toBe(false);
  });
});

describe("sessions started from this phone", () => {
  it("are recorded when host-api creates one", async () => {
    const state = mac({ sessionCreate: 1 });
    const { store, local } = await modules();
    const { HostApi } = await import("../data/host-api");
    await local.restoreLocalNotifications(state.connection, "mac");
    const created = await new HostApi(state.connection).createSession({ where: { quick: true }, agent: "claude", model: "", text: "Hi" });
    expect(created).toMatchObject({ created: true, sessionId: "s-new" });
    expect((await store.loadNotificationSettings()).started).toEqual({ mac: ["s-new"] });
    expect(JSON.parse(fake.storage.get(store.SETTINGS_KEY)!).started).toEqual({ mac: ["s-new"] });
  });
});

// PRO-479: a Mac that offers its bots is asked for their questions too, and its notice keeps what answers it.
describe("a bot's question", () => {
  it("is asked for while the Mac offers bots, and again without when Bots is switched off", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    const state = mac({ notificationFilters: 1, bots: 1 });
    const { local } = await modules();
    await local.restoreLocalNotifications(state.connection, "mac");
    expect((live(state)[0]?.params as { filter: { kinds: string[] } }).filter.kinds).toContain("bot_question");
    state.capabilities = { notificationFilters: 1 };
    state.emit("sync.capabilitiesChanged");
    await flush();
    await flush();
    expect(live(state)).toHaveLength(1);
    expect((live(state)[0]?.params as { filter: { kinds: string[] } }).filter.kinds).not.toContain("bot_question");
  });

  it("reads the notice's bot, item, question and answers, and shows it", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    const state = mac({ notificationFilters: 1, bots: 1 });
    const { local } = await modules();
    const notice = { seq: 7, epoch: "e", kind: "bot_question", title: "Sentry asks", body: "Fix now or file it?", sessionId: "home", tabId: "t", botQuestion: { botId: "b1", number: 4, question: "q1", answers: ["Fix it now", "File an issue", 7], recommended: 5 } };
    expect(local.parseNotification(notice)?.botQuestion).toEqual({ botId: "b1", number: 4, question: "q1", answers: ["Fix it now", "File an issue"] });
    expect(local.parseNotification({ ...notice, botQuestion: { botId: "", number: 4, question: "q1" } })?.botQuestion).toBeUndefined();
    await local.restoreLocalNotifications(state.connection, "mac");
    live(state)[0]?.listener({ event: { ...notice, botQuestion: { ...notice.botQuestion, answers: ["Fix it now", "File an issue"], recommended: 0 } } });
    await flush();
    await flush();
    const shown = fake.scheduled.at(-1) as { content: { title: string; data: Record<string, unknown> } };
    expect(shown.content.title).toBe("Sentry asks");
    expect(shown.content.data).toMatchObject({ kind: "bot_question", botId: "b1", number: 4, question: "q1", answers: ["Fix it now", "File an issue"], recommended: 0, sessionId: "home" });
  });
});
