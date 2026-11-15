import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnection } from "../transport/connection";

const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  permission: { granted: true, status: "granted" } as { granted: boolean; status: string },
  asked: 0,
  scheduled: [] as { content: Record<string, unknown> }[],
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
vi.mock("react-native", () => ({ Linking: { openSettings: vi.fn(async () => undefined) } }));
vi.mock("expo-notifications", () => ({
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: async () => fake.permission,
  requestPermissionsAsync: async () => { fake.asked++; fake.permission = { granted: true, status: "granted" }; return fake.permission; },
  scheduleNotificationAsync: async (request: { content: Record<string, unknown> }) => { fake.scheduled.push(request); return "id"; },
}));

const HOSTS = "terminalx:mobile:hosts:v1";

interface FakeMac {
  connection: HostConnection;
  subscribes: { params: unknown; listener: (value: unknown) => void; closed: boolean }[];
  missed: unknown[];
  capabilities: Record<string, unknown>;
  missedEvents: unknown[];
  emit: (method: string) => void;
}

function mac(capabilities: Record<string, unknown> = {}): FakeMac {
  const events = new Set<(event: { method: string }) => void>();
  const state: FakeMac = {
    subscribes: [], missed: [], capabilities, missedEvents: [],
    emit: (method) => { for (const listener of events) listener({ method }); },
    connection: {} as HostConnection,
  };
  state.connection = {
    request: vi.fn(async (method: string, params: unknown) => {
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

  it("does not subscribe while iOS has notifications off", async () => {
    fake.storage.set("terminalx:notifications-enabled:mac", "enabled");
    fake.permission = { granted: false, status: "denied" };
    const state = mac({ notificationFilters: 1 });
    const { local } = await modules();
    await expect(local.restoreLocalNotifications(state.connection, "mac")).resolves.toBe(false);
    expect(state.subscribes).toEqual([]);
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
    expect(fake.scheduled.map((request) => request.content)).toEqual([{ title: "Done", body: "Finished", subtitle: "TerminalX · Studio MacBook", sound: "default", data: { hostId: "mac", sessionId: "s-1", tabId: "t-1", kind: "finished", detailsHidden: false, silent: false } }]);
    expect(JSON.parse(fake.storage.get("terminalx:notifications:mac")!)).toEqual({ lastSeenSeq: 3, epoch: "e" });
    // A live event already seen is not shown again; a new one is.
    live(state)[0]!.listener({ event: { seq: 3, epoch: "e", title: "Done", body: "Finished", kind: "finished" } });
    live(state)[0]!.listener({ event: { seq: 4, epoch: "e", title: "Old Mac", body: "No kind", sessionId: "s-1", tabId: "t-1" } });
    await flush(); await flush();
    expect(fake.scheduled.map((request) => request.content.title)).toEqual(["Done", "Old Mac"]);
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
