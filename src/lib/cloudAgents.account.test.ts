import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTabInfo } from "@terminalx/portable/workspace";
import type { AccountStatus } from "@/lib/api";
import type { CachedTab } from "@/lib/cloudAgentApi";

// An unsent cloud draft is one account's (PRO-23 review of #508). Account A
// and account B can open the same shared workspace, so the same tab id: when
// the user changes or signs out, nothing A typed stays in memory, shows in
// B's composer, or is written into B's cache.

const mocks = vi.hoisted(() => ({
  account: { status: { state: "signed-out", identity: null, expiresAt: null, lastError: null } as AccountStatus, ready: true, busy: false },
  listeners: new Set<() => void>(),
  /** Each account's on-disk agent cache, by tab id, as the native side keeps it. */
  caches: {} as Record<string, Record<string, CachedTab>>,
  /** Hold the next cache read open; its answer is given by `held`. */
  hold: false,
  held: null as null | ((tabs: Record<string, CachedTab>) => void),
  invoke: vi.fn(),
  api: { cloudWorkspaces: vi.fn(), cloudWorkspaceRepositories: vi.fn(), cloudCatalogLoad: vi.fn(), cloudCatalogSave: vi.fn(), cloudAgentPurgeWorkspace: vi.fn() },
}));

const owner = () => (mocks.account.status.state === "signed-in" ? mocks.account.status.identity!.email : "nobody");
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: mocks.api }));
vi.mock("@/lib/account", () => ({
  refreshAccount: vi.fn(),
  getAccount: () => mocks.account,
  subscribeAccount: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));

const { applyLiveTabs, dropCloudAgents, getCloudAgents, loadCloudAgents, resetCloudAgents, SAVE_DEBOUNCE_MS } = await import("./cloudAgents");
const { bootCloudCatalog, resetCloudCatalog } = await import("./cloudCatalog");
const { getDraft, setDraft } = await import("./drafts");

const ORG = "org-a";
const shared = { organizationId: ORG, workspaceId: "shared" };
const tab = (tabId = "t-1"): AgentTabInfo => ({
  sessionId: "s-1",
  tabId,
  title: null,
  harness: "claude",
  model: "",
  effort: null,
  permissionMode: "manual",
  status: "idle",
  process: "running",
  pendingPermissions: [],
  followUps: [],
  lastSeq: 0,
  created: "2026-10-17T00:00:00Z",
  modified: "2026-10-17T00:00:00Z",
});

function signIn(email: string | null) {
  mocks.account.status = (
    email
      ? { state: "signed-in", identity: { name: email, email, organization: "Acme", organizationId: ORG }, expiresAt: null, lastError: null, context: { scope: "s", revision: `${email}:1` }, organizations: [{ id: ORG, name: "Acme", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } }] }
      : { state: "signed-out", identity: null, expiresAt: null, lastError: null }
  ) as AccountStatus;
  for (const listener of [...mocks.listeners]) listener();
}

/** Open the shared workspace's tab as whoever is signed in: the cache, then the runtime's list. */
async function open() {
  await loadCloudAgents(shared);
  applyLiveTabs(shared, [tab()]);
}

const saved = (email: string) => mocks.caches[email]?.["t-1"]?.draft;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.caches = {};
  mocks.hold = false;
  mocks.held = null;
  mocks.api.cloudWorkspaces.mockReturnValue(new Promise(() => undefined));
  mocks.api.cloudWorkspaceRepositories.mockReturnValue(new Promise(() => undefined));
  mocks.api.cloudCatalogLoad.mockResolvedValue(null);
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const cache = (mocks.caches[owner()] ??= {});
    if (command === "cloud_agent_cache_load") {
      if (!mocks.hold) return { tabs: { ...cache } };
      mocks.hold = false;
      return new Promise((resolve) => (mocks.held = (tabs) => resolve({ tabs })));
    }
    if (command === "cloud_agent_cache_save") {
      if (args.entry) cache[String(args.tabId)] = args.entry as CachedTab;
      return undefined;
    }
    if (command === "cloud_agent_outbox" || command === "cloud_agent_checkpoints") return [];
    return undefined;
  });
  signIn("a@example.com");
  bootCloudCatalog();
});

afterEach(() => {
  resetCloudCatalog();
  resetCloudAgents();
  setDraft("t-1", "");
  vi.useRealTimers();
});

describe("a cloud draft stays with its account", () => {
  it("switching from A to B on one shared workspace: B's composer is empty and B's cache never gets A's text", async () => {
    await open();
    setDraft("t-1", "A's half-written prompt");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(saved("a@example.com")).toBe("A's half-written prompt");

    signIn("b@example.com");
    expect(getDraft("t-1")).toBe("");
    expect(getCloudAgents(shared).tabs).toEqual([]);

    await open();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(getDraft("t-1")).toBe("");
    expect(mocks.caches["b@example.com"]["t-1"]).toBeDefined();
    expect(saved("b@example.com")).toBeUndefined();

    // A signs in again: A's own cache brings it back.
    signIn("a@example.com");
    await open();
    expect(getDraft("t-1")).toBe("A's half-written prompt");
  });

  it("a save still queued when the user changes is dropped, not written into the next account's cache", async () => {
    await open();
    setDraft("t-1", "typed just before switching");
    signIn("b@example.com");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(saved("b@example.com")).toBeUndefined();
  });

  it("signing out forgets it in memory", async () => {
    await open();
    setDraft("t-1", "A's text");
    signIn(null);
    expect(getDraft("t-1")).toBe("");
  });

  it("A's cache read that finishes after B signed in puts nothing back", async () => {
    mocks.hold = true;
    const loading = loadCloudAgents(shared);
    await vi.waitFor(() => expect(mocks.held).not.toBeNull());
    const finish = mocks.held!;
    signIn("b@example.com");
    finish({ "t-1": { tab: tab(), events: [], cursor: null, checkpoint: null, unread: false, completed: false, draft: "A's text", updatedAt: 1 } });
    await loading;
    expect(getDraft("t-1")).toBe("");
  });

  it("a deleted workspace's drafts go with its tabs", async () => {
    await open();
    setDraft("t-1", "for a workspace about to go");
    dropCloudAgents(shared);
    expect(getDraft("t-1")).toBe("");
  });
});
