import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCatalog, SAVED_LIST, WATCH_POLL_MS } from "./catalog";

const item = (id: string, fields: Record<string, unknown> = {}) => ({
  workspace: {
    id,
    orgId: "org-1",
    name: id,
    provider: "box",
    state: "suspended",
    you: { role: "driver", canApprove: false },
    lastActivityAt: 10,
    ...fields,
  },
  latestOperation: null,
});

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("CloudCatalog polling amplification fixes (P-75)", () => {
  it("skips loading:true on silent background polls, omits the 3rd publish when nothing purged, caches HELD in memory, and writes SAVED_LIST only on diff", async () => {
    const secretsMap = new Map<string, string>();
    const blobsMap = new Map<string, string>();
    const secrets = {
      get: vi.fn(async (name: string) => secretsMap.get(name) ?? null),
      set: vi.fn(async (name: string, value: string) => { secretsMap.set(name, value); }),
      delete: vi.fn(async (name: string) => { secretsMap.delete(name); }),
    };
    const storage = {
      getItem: vi.fn(async (name: string) => blobsMap.get(name) ?? null),
      setItem: vi.fn(async (name: string, value: string) => { blobsMap.set(name, value); }),
      removeItem: vi.fn(async (name: string) => { blobsMap.delete(name); }),
      getAllKeys: vi.fn(async () => [...blobsMap.keys()]),
    };
    let workspaces = [item("ws-1")];
    const api = {
      organizations: vi.fn(async () => [{ orgId: "org-1", name: "Acme", role: "member" }]),
      workspaces: vi.fn(async () => ({ workspaces, tombstones: [] })),
      open: vi.fn(),
      enqueue: vi.fn(),
      commandStatuses: vi.fn(async () => []),
      cancelCommand: vi.fn(),
      checkpoints: vi.fn(async () => []),
      checkpoint: vi.fn(async () => null),
    };
    const catalog = new CloudCatalog({
      api: api as never,
      secrets,
      storage,
      clientInstallationId: "mobile-1",
      appVersion: "0.1.3",
      now: () => 100,
    });
    await catalog.restored;

    // Initial explicit refresh: publishes loading:true then loaded (2 publishes, not 3 when nothing purged).
    const initialStates: boolean[] = [];
    const unsubscribe = catalog.subscribe(() => initialStates.push(catalog.getSnapshot().loading));
    await catalog.refresh();
    expect(initialStates).toEqual([true, false]);
    expect(storage.setItem.mock.calls.filter(([k]) => k === SAVED_LIST)).toHaveLength(1);
    const heldReadsAfterFirst = secrets.get.mock.calls.filter(([k]) => k === "terminalx.cloud.held.v1").length;
    expect(heldReadsAfterFirst).toBe(1);

    // Open a workspace session to verify listChanged() does not re-publish when unchanged.
    const session = catalog.session("org-1", "ws-1");
    await vi.waitFor(() => expect(api.checkpoints).toHaveBeenCalledTimes(1));
    const sessionPublishes = vi.fn();
    session.subscribe(sessionPublishes);

    // Start watching: background poll fires after WATCH_POLL_MS with silent: true.
    initialStates.length = 0;
    const stopWatch = catalog.watch();
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS);

    // Silent background poll: ZERO loading:true transitions, only 1 publish (not 3!).
    expect(initialStates).toEqual([false]);
    // Unchanged list skips AsyncStorage.setItem(SAVED_LIST, ...).
    expect(storage.setItem.mock.calls.filter(([k]) => k === SAVED_LIST)).toHaveLength(1);
    // HELD list is cached in memory: ZERO additional Keychain reads on subsequent polls!
    expect(secrets.get.mock.calls.filter(([k]) => k === "terminalx.cloud.held.v1")).toHaveLength(1);
    // Open workspace session did not re-publish when nothing in its listed state changed.
    expect(sessionPublishes).not.toHaveBeenCalled();

    // When the list actually changes, SAVED_LIST is written once more.
    workspaces = [item("ws-1"), item("ws-2", { lastActivityAt: 20 })];
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS);
    expect(storage.setItem.mock.calls.filter(([k]) => k === SAVED_LIST)).toHaveLength(2);

    stopWatch();
    unsubscribe();
    catalog.close();
  });
});
