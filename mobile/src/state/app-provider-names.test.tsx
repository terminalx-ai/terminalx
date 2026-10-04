// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// PRO-87: the app's own wiring of names, reconnect and unpair, over a fake connection and real storage.
const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  stage: null as null | ((stage: string, attempt: number) => void),
  describe: vi.fn(),
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
  getItemAsync: async (key: string) => fake.storage.get(`secure:${key}`) ?? null,
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
    onConnected() { return () => undefined; }
  },
}));
vi.mock("../data/host-api", () => ({
  HostApi: class { resetConnection() {}
    describe = fake.describe;
    forgetPairing = fake.forgetPairing;
    summaries = async () => [];
  },
}));

const { AppProvider, useApp } = await import("./AppProvider");
const { hostDisplayName } = await import("../store/host-name");
const { readHosts, savePairedHost } = await import("../store/hosts");

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
  for (const mock of [fake.describe, fake.forgetPairing, fake.start, fake.stop, fake.restart]) mock.mockReset();
  fake.describe.mockResolvedValue(null);
  fake.forgetPairing.mockResolvedValue(true);
  fake.paired = HOST;
  await savePairedHost(HOST, { v: 1, deviceToken: "token" });
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await settle();
});
afterEach(async () => { await act(async () => root.unmount()); });

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
  await act(async () => app.connectHost(app.hosts[0]!));
  await act(async () => app.reconnectHost(HOST.id));
  expect(fake.restart).toHaveBeenCalledTimes(1);
  expect(fake.start).toHaveBeenCalledTimes(1);
  await act(async () => app.disconnectHost());
  await act(async () => app.reconnectHost(HOST.id));
  expect(fake.start).toHaveBeenCalledTimes(2);
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
