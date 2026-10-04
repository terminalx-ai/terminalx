// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// PRO-50: what the app tells the connection when it goes to the home screen and comes back.
const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  appState: null as null | ((state: string) => void),
  removed: 0,
  stage: null as null | ((stage: string, attempt: number) => void),
  connected: null as null | (() => void),
  calls: [] as string[],
  resumable: true,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async (key: string) => fake.storage.get(key) ?? null, setItem: async (key: string, value: string) => void fake.storage.set(key, value), removeItem: async (key: string) => void fake.storage.delete(key) } }));
vi.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: async (key: string) => fake.storage.get(`secure:${key}`) ?? null, setItemAsync: async (key: string, value: string) => void fake.storage.set(`secure:${key}`, value), deleteItemAsync: async (key: string) => void fake.storage.delete(`secure:${key}`) }));
vi.mock("react-native", () => ({
  AppState: { addEventListener: (_event: string, listener: (state: string) => void) => { fake.appState = listener; return { remove: () => { fake.removed++; } }; } },
  Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("../auth/native", () => ({ beginSignIn: vi.fn(), finishSignIn: vi.fn(), readSession: async () => null, refreshStoredSession: vi.fn(), signOut: vi.fn() }));
vi.mock("../auth/protocol", () => ({ isAuthCallbackUrl: () => false }));
vi.mock("../notifications/local", () => ({ handleNotificationEvent: vi.fn(), restoreLocalNotifications: vi.fn() }));
vi.mock("../pairing/account", () => ({ discoverMachines: vi.fn(), pairDiscoveredMachine: vi.fn(), signOutPairing: vi.fn() }));
vi.mock("../pairing/errors", () => ({ pairingStep: (_step: string, work: () => unknown) => work() }));
vi.mock("../pairing/pair", () => ({ recoverPendingPairing: async () => null, pairFromOffer: vi.fn() }));
vi.mock("../transport/connection", () => ({
  HostConnection: class {
    start() { fake.calls.push("start"); }
    stop() { fake.calls.push("stop"); }
    restart() { fake.calls.push("restart"); }
    background() { fake.calls.push("background"); }
    foreground() { fake.calls.push("foreground"); return fake.resumable; }
    onStage(listener: (stage: string, attempt: number) => void) { fake.stage = listener; return () => undefined; }
    onConnected(listener: () => void) { fake.connected = listener; return () => undefined; }
    onLog() { return () => undefined; }
    onEvent() { return () => undefined; }
  },
}));
vi.mock("../data/host-api", () => ({ HostApi: class { describe = async () => null; summaries = async () => []; } }));

const { AppProvider, useApp } = await import("./AppProvider");
const { savePairedHost } = await import("../store/hosts");

const HOST = { id: "host-aaaa1111", label: "Mac", publicKeyB64: "key-a", endpoint: "ws://192.0.2.4:6768", lastConnectedAt: 1, provenance: { kind: "explicit" as const } };
const seen: { current: ReturnType<typeof useApp> | null } = { current: null };
function Probe() {
  const app = useApp();
  useEffect(() => { seen.current = app; });
  return null;
}
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const appState = async (state: string) => { await act(async () => fake.appState!(state)); await settle(); };

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fake.storage.clear();
  fake.calls = [];
  fake.resumable = true;
  fake.removed = 0;
  await savePairedHost(HOST, { v: 1, deviceToken: "token" });
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await settle();
  await act(async () => seen.current!.connectHost(seen.current!.hosts[0]!));
  await act(async () => fake.stage!("connected", 0));
  await settle();
  fake.calls = [];
});
afterEach(async () => { await act(async () => root.unmount()); });

it("tells the connection when the app goes to the home screen and when it is back, and restarts nothing itself", async () => {
  await appState("background");
  expect(fake.calls).toEqual(["background"]);
  await appState("active");
  expect(fake.calls).toEqual(["background", "foreground"]);
  // The same Mac stays chosen and its session list stays on screen: nobody re-picks anything.
  expect(seen.current!.activeHost?.id).toBe(HOST.id);
  expect(seen.current!.connectionStage).toBe("connected");
});

it("does not treat the app switcher or a system sheet as leaving", async () => {
  await appState("inactive");
  await appState("active");
  expect(fake.calls).toEqual(["foreground"]);
});

it("connects as before on an activation that was not a return from the background, when not connected", async () => {
  fake.resumable = false;
  await act(async () => fake.stage!("reconnecting", 2));
  await settle();
  await appState("active");
  expect(fake.calls).toEqual(["foreground", "restart"]);
  // Connected: nothing to restart.
  await act(async () => fake.stage!("connected", 0));
  await settle();
  fake.calls = [];
  await appState("active");
  expect(fake.calls).toEqual(["foreground"]);
});

it("counts each time the connection is usable again, so the screen reads what it missed, and keeps one listener", async () => {
  const before = seen.current!.connectionEpoch;
  await act(async () => fake.connected!());
  expect(seen.current!.connectionEpoch).toBe(before + 1);
  for (let trip = 0; trip < 5; trip++) {
    await appState("background");
    await appState("active");
  }
  // One background and one foreground per trip: the listener is replaced, never doubled.
  expect(fake.calls.filter((call) => call === "background")).toHaveLength(5);
  expect(fake.calls.filter((call) => call === "foreground")).toHaveLength(5);
});

it("does nothing with no Mac chosen", async () => {
  await act(async () => seen.current!.disconnectHost());
  fake.calls = [];
  await appState("active");
  expect(fake.calls).toEqual([]);
});
