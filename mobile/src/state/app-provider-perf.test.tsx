// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionLogEntry, ConnectionStage } from "../transport/connection";

const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  setItem: vi.fn(),
  stageListeners: [] as ((stage: ConnectionStage, attempt: number) => void)[],
  logListeners: [] as ((entry: ConnectionLogEntry) => void)[],
  request: vi.fn(),
}));

vi.mock("@react-native-community/netinfo", () => ({ default: { addEventListener: () => () => undefined, refresh: async () => undefined } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => fake.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      fake.setItem(key, value);
      fake.storage.set(key, value);
    },
    removeItem: async (key: string) => void fake.storage.delete(key),
    getAllKeys: async () => [...fake.storage.keys()],
    multiGet: async (keys: string[]) => keys.map((key) => [key, fake.storage.get(key) ?? null]),
    multiSet: async (pairs: [string, string][]) => { for (const [key, value] of pairs) fake.storage.set(key, value); },
    multiRemove: async (keys: string[]) => { for (const key of keys) fake.storage.delete(key); },
  },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock("expo-crypto", () => ({
  randomUUID: () => "uuid-1",
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { BASE64: "base64" },
  getRandomBytesAsync: async (n: number) => new Uint8Array(n),
  digestStringAsync: async () => "",
}));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn(), dismissAuthSession: vi.fn() }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: "ios", constants: { interfaceIdiom: "phone" } },
}));
vi.mock("../notifications/local", () => ({ handleNotificationEvent: vi.fn(), restoreLocalNotifications: vi.fn() }));
vi.mock("../pairing/account", () => ({ discoverMachines: vi.fn(), pairDiscoveredMachine: vi.fn(), signOutPairing: vi.fn() }));
vi.mock("../pairing/errors", () => ({ pairingStep: (_step: string, work: () => unknown) => work() }));
vi.mock("../pairing/pair", () => ({ recoverPendingPairing: async () => null, pairFromOffer: vi.fn() }));
vi.mock("../store/hosts", () => ({
  readHosts: async () => [],
  readHostCredential: async () => ({ v: 1, deviceToken: "tok", current: { token: "t", hash: "h", version: 1, expiresAt: Date.now() + 60_000 } }),
  removeHost: async () => undefined,
  setHostKind: async () => null,
  setHostNames: async () => null,
}));
vi.mock("../transport/connection", () => ({
  CONNECTION_LOG_CAPACITY: 200,
  HostConnection: class {
    start() {}
    stop() {}
    restart() {}
    background() {}
    foreground() { return true; }
    networkChanged() {}
    retryNow() {}
    transport() { return "direct" as const; }
    reassemblesFragments = async () => true;
    request = (...args: unknown[]) => fake.request(...args);
    onStage(listener: (stage: ConnectionStage, attempt: number) => void) {
      fake.stageListeners.push(listener);
      return () => { fake.stageListeners = fake.stageListeners.filter((l) => l !== listener); };
    }
    onConnected() { return () => undefined; }
    onLog(listener: (entry: ConnectionLogEntry) => void) {
      fake.logListeners.push(listener);
      return () => { fake.logListeners = fake.logListeners.filter((l) => l !== listener); };
    }
    onEvent() { return () => undefined; }
  },
}));

const { AppProvider, connectionLogStore, useApp, useAppActions, useAppConnection, useConnectionLogs } = await import("./AppProvider");
const { CONNECTION_LOG_FLUSH_MS, CONNECTION_LOG_STORAGE_KEY } = await import("./connection-log-store");

describe("AppProvider performance optimizations (P-46, P-49)", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    fake.storage.clear();
    fake.setItem.mockClear();
    fake.stageListeners = [];
    fake.logListeners = [];
    fake.request.mockReset();
    connectionLogStore.reset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    connectionLogStore.reset();
    vi.useRealTimers();
    container.remove();
  });

  it("extracts logs into external store, debounces AsyncStorage writes, keeps clearError stable, and isolates AppActions from volatile connection changes (P-49)", async () => {
    let appRenders = 0;
    let actionsRenders = 0;
    let connectionRenders = 0;
    let logRenders = 0;
    const clearErrors: (() => void)[] = [];
    let latestLogs: ConnectionLogEntry[] = [];

    function AppConsumer() {
      const app = useApp();
      appRenders++;
      clearErrors.push(app.clearError);
      return null;
    }
    function ActionsConsumer() {
      const actions = useAppActions();
      actionsRenders++;
      clearErrors.push(actions.clearError);
      return null;
    }
    function ConnectionConsumer() {
      useAppConnection();
      connectionRenders++;
      return null;
    }
    function LogConsumer() {
      latestLogs = useConnectionLogs();
      logRenders++;
      return null;
    }

    await act(async () => {
      root.render(
        <AppProvider>
          <AppConsumer />
          <ActionsConsumer />
          <ConnectionConsumer />
          <LogConsumer />
        </AppProvider>,
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    const appBeforeLogs = appRenders;
    const actionsBeforeLogs = actionsRenders;
    const logsBefore = logRenders;
    fake.setItem.mockClear();

    // Burst 5 log entries: AppContext & AppActions must NOT re-render, and AsyncStorage must NOT be written immediately.
    await act(async () => {
      for (let i = 1; i <= 5; i++) {
        for (const listener of fake.logListeners) {
          listener({ id: `log-${i}`, at: 1000 + i, level: "info", message: `tick ${i}` });
        }
      }
    });

    expect(latestLogs).toHaveLength(5);
    expect(logRenders).toBeGreaterThan(logsBefore);
    expect(appRenders).toBe(appBeforeLogs);
    expect(actionsRenders).toBe(actionsBeforeLogs);
    expect(fake.setItem.mock.calls.filter(([k]) => k === CONNECTION_LOG_STORAGE_KEY)).toHaveLength(0);

    // After the debounce window, all 5 entries flush in a single AsyncStorage write.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECTION_LOG_FLUSH_MS);
    });
    const logWrites = fake.setItem.mock.calls.filter(([k]) => k === CONNECTION_LOG_STORAGE_KEY);
    expect(logWrites).toHaveLength(1);
    expect(JSON.parse(logWrites[0][1])).toHaveLength(5);

    // Volatile connectionStage updates re-render ConnectionConsumer, NOT ActionsConsumer, and clearError keeps identical reference.
    const actionsBeforeStage = actionsRenders;
    const connBeforeStage = connectionRenders;
    await act(async () => {
      for (const listener of fake.stageListeners) listener("reconnecting", 1);
      for (const listener of fake.stageListeners) listener("reconnecting", 2);
    });
    expect(connectionRenders).toBeGreaterThan(connBeforeStage);
    expect(actionsRenders).toBe(actionsBeforeStage);
    expect(new Set(clearErrors).size).toBe(1);
  });

  it("short-circuits setSessions and AsyncStorage writes when host responds notModified (P-46)", async () => {
    const summary = {
      id: "s1",
      title: "Fix bug",
      project: "Repo",
      worktree: "wt",
      modified: "2026-11-01T00:00:00Z",
      tabs: [{ id: "t1", harness: "claude", status: "idle" as const }],
    };
    let calls = 0;
    fake.request.mockImplementation(async (method: string) => {
      if (method === "sync.capabilities") return { ok: true, value: { conditionalLists: 1 } };
      if (method === "sessions.summaries") {
        calls++;
        if (calls === 1) return { ok: true, value: { sessions: [summary], version: "v1" } };
        return { ok: true, value: { notModified: true, version: "v1" } };
      }
      return { ok: true, value: {} };
    });

    let appRef: ReturnType<typeof useApp> | null = null;
    let renders = 0;
    function Probe() {
      const app = useApp();
      renders++;
      useEffect(() => { appRef = app; });
      return null;
    }

    await act(async () => {
      root.render(<AppProvider><Probe /></AppProvider>);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await appRef!.connectHost({
        id: "host-1",
        label: "Mac",
        publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        endpoint: "ws://localhost:1",
        lastConnectedAt: 1,
        provenance: { kind: "explicit" },
      });
    });

    // First refresh fetches v1 and writes saved summaries.
    await act(async () => {
      await appRef!.refreshSessions();
      await vi.advanceTimersByTimeAsync(0);
    });
    const firstSessionsRef = appRef!.sessions;
    expect(firstSessionsRef).toHaveLength(1);

    const rendersAfterFirst = renders;
    fake.setItem.mockClear();

    // Second refresh gets { notModified: true } -> zero re-renders, exact same sessions reference, zero AsyncStorage writes.
    await act(async () => {
      await appRef!.refreshSessions();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(appRef!.sessions).toBe(firstSessionsRef);
    expect(renders).toBe(rendersAfterFirst);
    expect(fake.setItem).not.toHaveBeenCalled();
  });
});
