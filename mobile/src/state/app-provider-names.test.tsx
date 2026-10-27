// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The app's wiring of saved hosts, names, reconnect and unpair, over a fake connection and real storage.
const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  credentialRead: null as null | (() => Promise<string | null>),
  stage: null as null | ((stage: string, attempt: number) => void),
  connected: null as null | (() => void),
  describe: vi.fn(),
  summaries: vi.fn(),
  forgetPairing: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  paired: null as any,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getAllKeys: async () => [...fake.storage.keys()],
    multiRemove: async (keys: string[]) => { for (const key of keys) fake.storage.delete(key); },
    getItem: async (key: string) => fake.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void fake.storage.set(key, value),
    removeItem: async (key: string) => void fake.storage.delete(key),
  },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => fake.credentialRead ? fake.credentialRead() : fake.storage.get(`secure:${key}`) ?? null,
  setItemAsync: async (key: string, value: string) => void fake.storage.set(`secure:${key}`, value),
  deleteItemAsync: async (key: string) => void fake.storage.delete(`secure:${key}`),
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("../auth/native", () => ({ beginSignIn: vi.fn(), finishSignIn: vi.fn(), readSession: async () => null, refreshStoredSession: vi.fn(), signOut: vi.fn() }));
vi.mock("../auth/protocol", () => ({ isAuthCallbackUrl: () => false }));
vi.mock("../notifications/local", () => ({ handleNotificationEvent: vi.fn(), restoreLocalNotifications: vi.fn() }));
vi.mock("../pairing/account", () => ({ discoverMachines: vi.fn(), pairDiscoveredMachine: vi.fn(), signOutPairing: vi.fn() }));
vi.mock("../pairing/errors", () => ({ pairingStep: (_step: string, work: () => unknown) => work() }));
vi.mock("../pairing/parse", async (original) => ({ ...(await original<typeof import("../pairing/parse")>()), parsePairingCodeOrThrow: () => ({}) }));
vi.mock("../pairing/pair", () => ({
  recoverPendingPairing: async () => null,
  pairFromOffer: async ({ label }: { label: string }) => {
    const { savePairedHost } = await import("../store/hosts");
    const host = { ...fake.paired, label };
    await savePairedHost(host, { v: 1, deviceToken: "token" });
    return host;
  },
}));
vi.mock("../transport/connection", () => ({
  HostConnection: class {
    start = fake.start;
    stop = fake.stop;
    restart = fake.restart;
    onStage(listener: (stage: string, attempt: number) => void) { fake.stage = listener; return () => undefined; }
    onLog() { return () => undefined; }
    onEvent() { return () => undefined; }
    onConnected(listener: () => void) { fake.connected = listener; return () => undefined; }
  },
}));
vi.mock("../data/host-api", () => ({
  HostApi: class { resetConnection() {}
    describe = fake.describe;
    forgetPairing = fake.forgetPairing;
    summaries = fake.summaries;
  },
}));

const { AppProvider, useApp } = await import("./AppProvider");
const { hostDisplayName } = await import("../store/host-name");
const { readHosts, savePairedHost, updateStoredHost } = await import("../store/hosts");

const HOST = { id: "host-aaaa1111", label: "Paired Mac", publicKeyB64: "key-a", endpoint: "ws://192.0.2.4:6768", lastConnectedAt: 1, provenance: { kind: "explicit" as const } };
// The provider's current value, kept by an effect (a render must not write outside itself) and read through `app`.
const live: { current: ReturnType<typeof useApp> | null } = { current: null };
const app = new Proxy({} as ReturnType<typeof useApp>, { get: (_target, key) => live.current![key as keyof ReturnType<typeof useApp>] });
function Probe() {
  const value = useApp();
  useEffect(() => { live.current = value; });
  return null;
}
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const connected = async () => { await act(async () => fake.stage!("connected", 0)); await settle(); };
const shown = () => app.hosts.map((host) => hostDisplayName(host));

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fake.storage.clear();
  fake.credentialRead = null;
  for (const mock of [fake.summaries, fake.describe, fake.forgetPairing, fake.start, fake.stop, fake.restart]) mock.mockReset();
  fake.describe.mockResolvedValue(null);
  fake.summaries.mockResolvedValue([]);
  fake.forgetPairing.mockResolvedValue(true);
  fake.paired = HOST;
  await savePairedHost(HOST, { v: 1, deviceToken: "token" });
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await settle();
});
afterEach(async () => { await act(async () => root.unmount()); });

it("reconnects a saved LAN pairing on launch without an account or another code", () => {
  expect(app.ready).toBe(true);
  expect(app.session).toBeNull();
  expect(app.activeHost?.id).toBe(HOST.id);
  expect(fake.start).toHaveBeenCalledExactlyOnceWith(HOST, { v: 1, deviceToken: "token" });
});

it("restores the most recently connected Mac when more than one is paired", async () => {
  const recent = { ...HOST, id: "host-bbbb2222", publicKeyB64: "key-b", lastConnectedAt: 20 };
  await savePairedHost(recent, { v: 1, deviceToken: "other-token" });
  await act(async () => root.unmount());
  fake.start.mockClear();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await settle();
  expect(app.activeHost?.id).toBe(recent.id);
  expect(fake.start).toHaveBeenCalledExactlyOnceWith(recent, { v: 1, deviceToken: "other-token" });
});

it("leaves launch usable when there are no saved Macs or the saved credential is missing", async () => {
  for (const hasHost of [false, true]) {
    await act(async () => root.unmount());
    fake.storage.clear();
    if (hasHost) await savePairedHost(HOST, { v: 1, deviceToken: "token" });
    fake.storage.delete(`secure:terminalx.mobile-relay.credentials.${HOST.id}`);
    fake.start.mockClear();
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
    await settle();
    expect(app.ready).toBe(true);
    expect(app.activeHost).toBeNull();
    expect(fake.start).not.toHaveBeenCalled();
    expect(app.error).toBe(hasHost ? "The device credential is unavailable. Pair this computer again." : null);
  }
});

it("does not start a connection after launch is cancelled while reading the credential", async () => {
  await act(async () => root.unmount());
  fake.start.mockClear();
  let resolve!: (credential: string) => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  fake.credentialRead = () => pending;
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await settle();
  await act(async () => root.unmount());
  await act(async () => resolve(JSON.stringify({ v: 1, deviceToken: "token" })));
  expect(fake.start).not.toHaveBeenCalled();
});

it("refreshes the machine row and active host after the connection records a newer timestamp", async () => {
  await act(async () => app.connectHost(app.hosts[0]!));
  // The real transport saves the successful connection before announcing onConnected.
  await updateStoredHost({ ...HOST, lastConnectedAt: 100 });
  await act(async () => fake.connected!());
  await settle();
  expect(app.hosts[0]?.lastConnectedAt).toBe(100);
  expect(app.activeHost?.lastConnectedAt).toBe(100);
  await updateStoredHost({ ...HOST, lastConnectedAt: 200 });
  await act(async () => fake.connected!());
  await settle();
  expect(app.hosts[0]?.lastConnectedAt).toBe(200);
  expect(app.activeHost?.lastConnectedAt).toBe(200);
});

it("gives an entry paired as Paired Mac its real name on the next connection, and follows a rename of the computer", async () => {
  expect(shown()).toEqual(["Paired Mac"]);
  fake.describe.mockResolvedValue("  Paresh’s Mac mini\u0000 ");
  await act(async () => app.connectHost(app.hosts[0]!));
  await connected();
  expect(shown()).toEqual(["Paresh’s Mac mini"]);
  expect(hostDisplayName(app.activeHost!)).toBe("Paresh’s Mac mini");
  // Renamed in System Settings: picked up on the next connection.
  fake.describe.mockResolvedValue("Studio Mac");
  await connected();
  expect(shown()).toEqual(["Studio Mac"]);
  expect((await readHosts())[0]!.hostName).toBe("Studio Mac");
});

it("keeps a name typed on the phone through reconnects and a rename of the computer, until it is cleared", async () => {
  fake.describe.mockResolvedValue("Paresh’s Mac mini");
  await act(async () => app.connectHost(app.hosts[0]!));
  await connected();
  await act(async () => app.renameHost(HOST.id, "  My desk  "));
  expect(shown()).toEqual(["My desk"]);
  fake.describe.mockResolvedValue("Renamed Mac");
  await connected();
  expect(shown()).toEqual(["My desk"]);
  expect(await readHosts()).toMatchObject([{ customName: "My desk", hostName: "Renamed Mac" }]);
  await act(async () => app.renameHost(HOST.id, ""));
  expect(shown()).toEqual(["Renamed Mac"]);
});

it("keeps the fallback when an older desktop does not say its name", async () => {
  await act(async () => app.connectHost(app.hosts[0]!));
  await connected();
  expect(fake.describe).toHaveBeenCalled();
  expect(shown()).toEqual(["Paired Mac"]);
});

it("takes the name from the pairing link at once, and falls back for a bare code", async () => {
  fake.storage.clear();
  await act(async () => app.pairCode("terminalx://pair?code=abc&name=Paresh%E2%80%99s+Mac+mini"));
  expect(shown()).toEqual(["Paresh’s Mac mini"]);
  expect((await readHosts())[0]).toMatchObject({ label: "Paired Mac", hostName: "Paresh’s Mac mini" });
  fake.storage.clear();
  await act(async () => app.pairCode("abc"));
  expect(shown()).toEqual(["Paired Mac"]);
});

it("reconnects the active computer in place, and connects another one", async () => {
  fake.start.mockClear();
  await connected();
  await act(async () => app.connectHost(app.hosts[0]!));
  await act(async () => app.reconnectHost(HOST.id));
  expect(fake.restart).toHaveBeenCalledTimes(1);
  expect(fake.start).not.toHaveBeenCalled();
  await act(async () => app.disconnectHost());
  await act(async () => app.reconnectHost(HOST.id));
  expect(fake.start).toHaveBeenCalledTimes(1);
});

it("asks the connected computer to drop this phone before forgetting it, and forgets it either way", async () => {
  await act(async () => app.connectHost(app.hosts[0]!));
  await connected();
  fake.forgetPairing.mockRejectedValue(new Error("gone"));
  await act(async () => app.forgetHost(HOST.id));
  expect(fake.forgetPairing).toHaveBeenCalledTimes(1);
  expect(app.hosts).toEqual([]);
  expect(app.activeHost).toBeNull();
  expect(await readHosts()).toEqual([]);

  // Not connected to it: there is nobody to ask, and it is still forgotten here.
  await savePairedHost(HOST, { v: 1, deviceToken: "token" });
  fake.forgetPairing.mockClear();
  await act(async () => app.forgetHost(HOST.id));
  expect(fake.forgetPairing).not.toHaveBeenCalled();
  expect(await readHosts()).toEqual([]);
});

const summary = (id: string) => ({ id, title: id, project: "project", worktree: "worktree", modified: "now", tabs: [] });

it("selects the connected Mac without clearing its sessions or restarting it (#633)", async () => {
  await connected();
  fake.summaries.mockResolvedValue([summary("existing")]);
  await act(async () => app.refreshSessions());
  fake.start.mockClear();
  fake.restart.mockClear();
  let finish!: (values: unknown[]) => void;
  fake.summaries.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => { expect(await app.connectHost(app.hosts[0]!)).toBe(true); });
  expect(app.sessions).toEqual([summary("existing")]);
  expect(fake.start).not.toHaveBeenCalled();
  expect(fake.restart).not.toHaveBeenCalled();
  await act(async () => finish([summary("fresh")]));
  expect(app.sessions).toEqual([summary("fresh")]);
});

it.each(["connecting", "reconnecting", "cant-connect", "unreachable"])("loads sessions after selecting a %s Mac", async (stage) => {
  await act(async () => fake.stage!(stage, 3));
  fake.restart.mockClear();
  await act(async () => { expect(await app.connectHost(app.hosts[0]!)).toBe(true); });
  expect(fake.restart).toHaveBeenCalledTimes(stage === "connecting" || stage === "reconnecting" ? 0 : 1);
  expect(fake.summaries).not.toHaveBeenCalled();
  fake.summaries.mockResolvedValue([summary("resumed")]);
  await connected();
  await act(async () => fake.connected!());
  expect(app.sessions).toEqual([summary("resumed")]);
});

it("drains the reconnect refresh even when the previous summary request rejects", async () => {
  let fail!: (cause: Error) => void;
  fake.summaries.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  let pending!: Promise<void>;
  await act(async () => { pending = app.refreshSessions(); });
  fake.summaries.mockResolvedValue([summary("after-reconnect")]);
  await connected();
  await act(async () => fake.connected!());
  await act(async () => { fail(new Error("old connection closed")); await pending; });
  expect(app.sessions).toEqual([summary("after-reconnect")]);
  expect(app.error).toBeNull();
  expect(app.loadingSessions).toBe(false);
});

it("keeps current summary failures visible", async () => {
  fake.summaries.mockRejectedValueOnce(new Error("Could not read sessions"));
  await act(async () => app.refreshSessions());
  expect(app.error).toBe("Could not read sessions");
  expect(app.loadingSessions).toBe(false);
});

it("ignores late credentials after another selection or disconnect", async () => {
  const other = { ...HOST, id: "host-bbbb2222" };
  for (const cancel of [() => app.connectHost(HOST), () => app.disconnectHost()]) {
    let finish!: (value: string) => void;
    fake.credentialRead = () => new Promise((resolve) => { finish = resolve; });
    let pending!: Promise<boolean>;
    await act(async () => { pending = app.connectHost(other); });
    await act(async () => { await cancel(); });
    fake.start.mockClear();
    await act(async () => { finish(JSON.stringify({ v: 1, deviceToken: "token" })); expect(await pending).toBe(false); });
    expect(fake.start).not.toHaveBeenCalled();
  }
});

it("rejects late summaries and errors from a previous selection", async () => {
  const other = { ...HOST, id: "host-bbbb2222" };
  await savePairedHost(other, { v: 1, deviceToken: "other-token" });
  for (const reject of [false, true]) {
    await act(async () => app.connectHost(HOST));
    let finish!: (value: unknown) => void;
    fake.summaries.mockImplementationOnce(() => new Promise((resolve, fail) => { finish = reject ? fail : resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = app.refreshSessions(); });
    await act(async () => app.connectHost(other));
    await act(async () => { finish(reject ? new Error("old host failed") : [summary("old")]); await pending; });
    expect(app.sessions).toEqual([]);
    expect(app.error).toBeNull();
  }
});

it("loads the newly selected computer only when its connection becomes usable", async () => {
  const other = { ...HOST, id: "host-bbbb2222" };
  await savePairedHost(other, { v: 1, deviceToken: "other-token" });
  await connected();
  fake.summaries.mockResolvedValue([summary("old")]);
  await act(async () => app.refreshSessions());
  fake.summaries.mockClear();
  await act(async () => { expect(await app.connectHost(other)).toBe(true); });
  expect(app.activeHost?.id).toBe(other.id);
  expect(app.sessions).toEqual([]);
  expect(fake.summaries).not.toHaveBeenCalled();
  fake.summaries.mockResolvedValue([summary("new")]);
  await connected();
  await act(async () => fake.connected!());
  expect(app.sessions).toEqual([summary("new")]);
});

it.each([null, new Error("Credential storage unavailable")])("keeps credential failures on the current selection: %s", async (failure) => {
  fake.credentialRead = async () => { if (failure) throw failure; return null; };
  fake.start.mockClear();
  await act(async () => { expect(await app.connectHost({ ...HOST, id: "host-bbbb2222" })).toBe(false); });
  expect(app.activeHost?.id).toBe(HOST.id);
  // readHostCredential deliberately treats secure-store failures as unavailable credentials.
  expect(app.error).toBe("The device credential is unavailable. Pair this computer again.");
  expect(fake.start).not.toHaveBeenCalled();
});

it("reports malformed stored credentials without leaving an unhandled selection rejection", async () => {
  fake.credentialRead = async () => "{";
  let expected = "";
  try { JSON.parse("{"); } catch (cause) { expected = (cause as Error).message; }
  fake.start.mockClear();
  await act(async () => { expect(await app.connectHost({ ...HOST, id: "host-bbbb2222" })).toBe(false); });
  expect(app.error).toBe(expected);
  expect(app.activeHost?.id).toBe(HOST.id);
  expect(fake.start).not.toHaveBeenCalled();
});
