// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// PRO-600: the phone was signed out right after Cancel on iOS's "Wants to Use github.com to Sign In" prompt. The
// prompt makes the app inactive; Cancel makes it active again, and coming back refreshes the cloud session. The cloud
// screens had refreshed the stored session minutes earlier, so the copy the app kept in its state held a refresh token
// the server had replaced. The server takes a replaced refresh token for one minute only; after that it ends the
// whole sign-in (terminalx-server `cloudTokens.rotateRefresh`), and the phone, refused, forgot it.
const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  listeners: [] as ((state: string) => void)[],
  now: 1_800_000_000_000,
  // The server's sign-in, as `cloudTokens.rotateRefresh` keeps it.
  server: { refresh: "", previous: null as string | null, replayEndsAt: 0, issued: null as null | Record<string, unknown>, revoked: false, minted: 0 },
  refreshes: [] as string[],
}));
vi.mock("@react-native-community/netinfo", () => ({ default: { addEventListener: () => () => undefined } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => fake.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void fake.storage.set(key, value),
    removeItem: async (key: string) => void fake.storage.delete(key),
    getAllKeys: async () => [...fake.storage.keys()].filter((key) => !key.startsWith("secure:")),
    multiGet: async (keys: string[]) => keys.map((key) => [key, fake.storage.get(key) ?? null]),
    multiSet: async (pairs: [string, string][]) => { for (const [key, value] of pairs) fake.storage.set(key, value); },
    multiRemove: async (keys: string[]) => { for (const key of keys) fake.storage.delete(key); },
  },
}));
vi.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: async (key: string) => fake.storage.get(`secure:${key}`) ?? null, setItemAsync: async (key: string, value: string) => void fake.storage.set(`secure:${key}`, value), deleteItemAsync: async (key: string) => void fake.storage.delete(`secure:${key}`) }));
vi.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, CryptoEncoding: { BASE64: "base64" }, getRandomBytesAsync: async (n: number) => new Uint8Array(n), digestStringAsync: async () => "" }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn(), dismissAuthSession: vi.fn() }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: (_event: string, listener: (state: string) => void) => { fake.listeners.push(listener); return { remove: () => { fake.listeners = fake.listeners.filter((held) => held !== listener); } }; } },
  Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: "ios", constants: { interfaceIdiom: "phone" } },
}));
// The real refresh rules, on the server's side of the wire: rotate, replay within a minute, end the sign-in after.
vi.mock("../auth/protocol", async (original) => ({
  ...(await original<typeof import("../auth/protocol")>()),
  refreshSession: async (_config: unknown, session: { refreshToken: string; user: unknown }) => {
    fake.refreshes.push(session.refreshToken);
    const server = fake.server;
    if (server.revoked) return { status: "rejected" };
    if (session.refreshToken === server.previous) {
      if (fake.now < server.replayEndsAt) return { status: "refreshed", session: server.issued };
      server.revoked = true;
      return { status: "rejected" };
    }
    if (session.refreshToken !== server.refresh) return { status: "rejected" };
    server.minted++;
    const issued = { accessToken: `access-${server.minted}`, refreshToken: `refresh-${server.minted}`, expiresAt: fake.now + 30 * 60_000, user: session.user };
    server.previous = server.refresh;
    server.refresh = issued.refreshToken;
    server.replayEndsAt = fake.now + 60_000;
    server.issued = issued;
    return { status: "refreshed", session: issued };
  },
}));
vi.mock("../notifications/local", () => ({ handleNotificationEvent: vi.fn(), restoreLocalNotifications: vi.fn() }));
vi.mock("../pairing/account", () => ({ discoverMachines: vi.fn(), pairDiscoveredMachine: vi.fn(), signOutPairing: vi.fn() }));
vi.mock("../pairing/errors", () => ({ pairingStep: (_step: string, work: () => unknown) => work() }));
vi.mock("../pairing/pair", () => ({ recoverPendingPairing: async () => null, pairFromOffer: vi.fn() }));
vi.mock("../transport/connection", () => ({
  HostConnection: class {
    start() {}
    stop() {}
    restart() {}
    background() {}
    foreground() { return true; }
    networkChanged() {}
    onStage() { return () => undefined; }
    onConnected() { return () => undefined; }
    onLog() { return () => undefined; }
    onEvent() { return () => undefined; }
  },
}));
vi.mock("../data/host-api", () => ({ HostApi: class { resetConnection() {} describeHost = async () => null; summaries = async () => []; listVersion = () => null; rememberList() {} } }));

const { AppProvider, useApp } = await import("./AppProvider");
const { readSession, refreshStoredSession, resetSessionCacheForTests } = await import("../auth/native");

const SESSION_KEY = "secure:terminalx.cloud.session.v1";
const seen: { current: ReturnType<typeof useApp> | null } = { current: null };
function Probe() {
  const app = useApp();
  useEffect(() => { seen.current = app; });
  return null;
}
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const appState = async (state: string) => { await act(async () => { for (const listener of [...fake.listeners]) listener(state); }); await settle(); };
const minutes = (count: number) => { fake.now += count * 60_000; };

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  resetSessionCacheForTests();
  vi.spyOn(Date, "now").mockImplementation(() => fake.now);
  fake.storage.clear();
  fake.listeners = [];
  fake.refreshes = [];
  fake.server = { refresh: "refresh-0", previous: null, replayEndsAt: 0, issued: null, revoked: false, minted: 0 };
  fake.storage.set(SESSION_KEY, JSON.stringify({ accessToken: "access-0", refreshToken: "refresh-0", expiresAt: fake.now + 30 * 60_000, user: { userId: "user-ada", email: "ada@example.com" } }));
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await settle();
  expect(seen.current!.session?.refreshToken).toBe("refresh-0");
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

it("stays signed in when the app comes back after the cloud screens refreshed the session more than a minute ago", async () => {
  // Browsing the launch form for half an hour: the cloud screens' next request refreshes the stored session.
  minutes(30);
  const cloud = await refreshStoredSession();
  expect(cloud.status).toBe("refreshed");
  // Two minutes later, the GitHub prompt and its Cancel.
  minutes(2);
  await appState("inactive");
  await appState("active");
  expect(fake.server.revoked).toBe(false);
  // The replaced refresh token was never sent again.
  expect(fake.refreshes).toEqual(["refresh-0"]);
  expect(seen.current!.session?.refreshToken).toBe("refresh-1");
  expect(JSON.parse(fake.storage.get(SESSION_KEY)!).refreshToken).toBe("refresh-1");
});

it("refreshes the stored session, not the app's copy, when coming back finds it due", async () => {
  minutes(30);
  await refreshStoredSession();
  // The stored session is due again: coming back refreshes it with the refresh token it holds now.
  minutes(30);
  await appState("active");
  expect(fake.refreshes).toEqual(["refresh-0", "refresh-1"]);
  expect(fake.server.revoked).toBe(false);
  expect(seen.current!.session?.refreshToken).toBe("refresh-2");
  expect((await readSession())?.refreshToken).toBe("refresh-2");
});

it("still signs out when the server refuses the stored session's own refresh token", async () => {
  fake.storage.set("terminalx:connection-log:v1", JSON.stringify([{ id: "1", at: 1, level: "info", message: "test" }]));
  fake.storage.set("terminalx:draft:host-1:s-1:t-1", "sealed-draft");
  fake.storage.set("terminalx:draft-id:host-1:s-1:t-1", "{}");
  fake.storage.set("secure:terminalx.local.storage.key.v1", "key-material");
  minutes(31);
  fake.server.revoked = true;
  await appState("active");
  expect(fake.refreshes).toEqual(["refresh-0"]);
  // Signing out clears what the phone keeps before the session goes: it takes a few turns.
  await vi.waitFor(async () => { await settle(); expect([seen.current!.error, seen.current!.session]).toEqual([null, null]); });
  expect(fake.storage.has(SESSION_KEY)).toBe(false);
  // S-48: connection log, drafts, draft-ids, and local storage encryption key are purged on sign-out/rejection.
  expect(fake.storage.has("terminalx:connection-log:v1")).toBe(false);
  expect(fake.storage.has("terminalx:draft:host-1:s-1:t-1")).toBe(false);
  expect(fake.storage.has("terminalx:draft-id:host-1:s-1:t-1")).toBe(false);
  expect(fake.storage.has("secure:terminalx.local.storage.key.v1")).toBe(false);
});
