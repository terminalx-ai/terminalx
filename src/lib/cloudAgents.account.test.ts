import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
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
  events: new Map<string, Set<() => void>>(),
  runtime: { status: vi.fn(), reconnect: vi.fn() },
  saveMode: "ok" as "ok" | "held" | "failed",
  finishSave: null as null | (() => void),
  enforceCacheAccount: false,
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
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event: string, listener: () => void) => {
  let listeners = mocks.events.get(event);
  if (!listeners) mocks.events.set(event, (listeners = new Set()));
  listeners.add(listener);
  return () => listeners.delete(listener);
}) }));
vi.mock("@/lib/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sessions")>()),
  getSessionStore: () => ({ loaded: true, sessions: [] }),
}));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: mocks.api, localRuntime: mocks.runtime }));
vi.mock("@/lib/account", () => ({
  refreshAccount: vi.fn(),
  getAccount: () => mocks.account,
  subscribeAccount: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));

const { applyLiveTabs, dropCloudAgents, getCloudAgents, loadCloudAgents, resetCloudAgents, setCloudAgentAccount, SAVE_DEBOUNCE_MS } = await import("./cloudAgents");
const { bootCloudCatalog, resetCloudCatalog } = await import("./cloudCatalog");
const { getDraft, setDraft, clearDrafts, checkpointDraftsForRecovery } = await import("./drafts");
const { LocalRuntimeNotice } = await import("@/components/LocalRuntimeNotice");

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
  sessionStorage.clear();
  mocks.events.clear();
  mocks.runtime.status.mockReset().mockResolvedValue({ state: "connected", epoch: "owner", runningAgents: 1, terminals: 1 });
  mocks.runtime.reconnect.mockReset();
  mocks.saveMode = "ok";
  mocks.finishSave = null;
  mocks.enforceCacheAccount = false;
  setCloudAgentAccount(null);
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
      const enforce = mocks.enforceCacheAccount;
      const requestedOwner = String(args.account);
      const write = () => {
        // The R3 controls hold BEFORE mutation and check the account at that
        // boundary, like native cache_save, not just when IPC was dispatched.
        if (enforce && requestedOwner !== owner()) throw new Error("Account changed before cache mutation");
        const target = enforce ? (mocks.caches[requestedOwner] ??= {}) : cache;
        if (args.entry) target[String(args.tabId)] = args.entry as CachedTab;
        else delete target[String(args.tabId)];
      };
      if (mocks.saveMode === "failed") throw new Error("Cache write refused");
      if (mocks.saveMode === "held") return new Promise<void>((resolve, reject) => {
        mocks.finishSave = () => { try { write(); resolve(); } catch (error) { reject(error); } };
      });
      write();
      return undefined;
    }
    if (command === "cloud_agent_outbox" || command === "cloud_agent_checkpoints") return [];
    return undefined;
  });
  signIn("a@example.com");
  bootCloudCatalog();
});

afterEach(() => {
  cleanup();
  resetCloudCatalog();
  resetCloudAgents();
  clearDrafts(() => true);
  vi.useRealTimers();
});

describe("a cloud draft stays with its account", () => {
  const reattached = async () => {
    await act(async () => { for (const listener of mocks.events.get("local_runtime_reattached") ?? []) listener(); });
  };
  const mountedRecovery = async () => {
    const reload = vi.fn();
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(createElement(LocalRuntimeNotice, { reload })); });
    return { ...view, reload };
  };
  const expectNoPrompt = () => {
    expect(mocks.invoke.mock.calls.every(([command]) => [
      "cloud_agent_cache_load", "cloud_agent_cache_save", "cloud_agent_outbox", "cloud_agent_checkpoints",
    ].includes(command))).toBe(true);
    expect(mocks.runtime.reconnect).not.toHaveBeenCalled();
  };

  it.each(["write", "delete"] as const)("R3 an A %s held before mutation orders replacement A after A -> B -> A", async (kind) => {
    mocks.enforceCacheAccount = true;
    setCloudAgentAccount("a@example.com");
    await open();
    setDraft("t-1", "baseline");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    mocks.saveMode = "held";
    if (kind === "write") setDraft("t-1", "obsolete S1 text");
    else applyLiveTabs(shared, []); // Real forgetTab deletion path.
    await act(async () => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
    const finishOld = mocks.finishSave!;
    expect(saved("a@example.com")).toBe("baseline"); // Mutation has NOT happened.
    const aMutations = () => mocks.invoke.mock.calls.filter(([command, args]) =>
      command === "cloud_agent_cache_save" && args.account === "a@example.com").length;
    const issuedBeforeSwitch = aMutations();

    setCloudAgentAccount("b@example.com");
    signIn("b@example.com");
    mocks.saveMode = "ok";
    await open();
    expect(getDraft("t-1")).toBe("");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(saved("b@example.com")).toBeUndefined();
    const { reload, unmount } = await mountedRecovery();
    await reattached();
    expect(reload).not.toHaveBeenCalled(); // Detached A still owns an issued mutation.

    setCloudAgentAccount("a@example.com");
    signIn("a@example.com");
    await open();
    setDraft("t-1", "newest S2 text");
    mocks.saveMode = "held";
    await act(async () => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1));
    expect(aMutations()).toBe(issuedBeforeSwitch); // S2 cannot issue ahead of S1.
    await reattached();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => finishOld()); // A is current; the native account check permits S1.
    expect(saved("a@example.com")).toBe(kind === "write" ? "obsolete S1 text" : undefined);
    expect(aMutations()).toBe(issuedBeforeSwitch + 1);
    await reattached();
    expect(reload).not.toHaveBeenCalled(); // S2 is now held before ITS mutation.
    await act(async () => mocks.finishSave!());
    await reattached();
    expect(saved("a@example.com")).toBe("newest S2 text");
    expect(saved("b@example.com")).toBeUndefined();
    expect(reload).toHaveBeenCalledOnce();
    expectNoPrompt();
    unmount();
    resetCloudCatalog();
    resetCloudAgents();
    vi.resetModules();
    const freshDrafts = await import("./drafts");
    const freshAgents = await import("./cloudAgents");
    const freshCatalog = await import("./cloudCatalog");
    freshAgents.setCloudAgentAccount("a@example.com");
    try {
      freshCatalog.bootCloudCatalog();
      await freshAgents.loadCloudAgents(shared);
      freshAgents.applyLiveTabs(shared, [tab()]);
      expect(freshDrafts.getDraft("t-1")).toBe("newest S2 text");
      freshAgents.setCloudAgentAccount("b@example.com");
      signIn("b@example.com"); // No edit after restore.
      await freshAgents.loadCloudAgents(shared);
      freshAgents.applyLiveTabs(shared, [tab()]);
      mocks.saveMode = "ok";
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
      expect(freshDrafts.getDraft("t-1")).toBe("");
      expect(saved("b@example.com")).toBeUndefined();
      expectNoPrompt();
    } finally {
      freshCatalog.resetCloudCatalog();
      freshAgents.resetCloudAgents();
      freshDrafts.clearDrafts(() => true);
    }
  });

  it("R3 forgetTab waits behind an issued upsert and deletion remains final", async () => {
    mocks.enforceCacheAccount = true;
    setCloudAgentAccount("a@example.com");
    await open();
    mocks.saveMode = "held";
    setDraft("t-1", "must not reappear after deletion");
    await act(async () => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
    const finishWrite = mocks.finishSave!;
    applyLiveTabs(shared, []);
    await act(async () => {});
    const deletions = () => mocks.invoke.mock.calls.filter(([command, args]) =>
      command === "cloud_agent_cache_save" && args.entry === null).length;
    expect(deletions()).toBe(0);
    await act(async () => finishWrite());
    expect(saved("a@example.com")).toBe("must not reappear after deletion");
    expect(deletions()).toBe(1);
    const { reload } = await mountedRecovery();
    await reattached();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => mocks.finishSave!());
    expect(mocks.caches["a@example.com"]["t-1"]).toBeUndefined();
    expectNoPrompt();
  });

  it("R2 real recovery defers a sub-500ms edit until saved, then restores A in a fresh graph without disclosing to B", async () => {
    await open();
    setDraft("t-1", "older saved text");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    const { reload, unmount } = await mountedRecovery();
    const latest = "Latest unsent text typed immediately before recovery";
    setDraft("t-1", latest);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await reattached();
    expect(reload).not.toHaveBeenCalled();
    expect(saved("a@example.com")).toBe("older saved text");
    expect(getDraft("t-1")).toBe(latest);
    await act(async () => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100));
    expect(saved("a@example.com")).toBe(latest);
    await act(async () => vi.advanceTimersByTimeAsync(600)); // Existing recovery health timer.
    expect(reload).toHaveBeenCalledOnce();
    expectNoPrompt();
    unmount();
    resetCloudCatalog();
    resetCloudAgents();
    // No old save timers are advanced after destruction of this document.
    vi.resetModules();
    const freshDrafts = await import("./drafts");
    const freshAgents = await import("./cloudAgents");
    const freshCatalog = await import("./cloudCatalog");
    try {
      expect(freshDrafts.getDraft("t-1")).toBe(""); // Never in the local checkpoint.
      freshCatalog.bootCloudCatalog();
      await freshAgents.loadCloudAgents(shared);
      freshAgents.applyLiveTabs(shared, [tab()]);
      expect(freshDrafts.getDraft("t-1")).toBe(latest);
      signIn(null); // No edit after restoration.
      expect(freshDrafts.getDraft("t-1")).toBe("");
      signIn("b@example.com");
      await freshAgents.loadCloudAgents(shared);
      freshAgents.applyLiveTabs(shared, [tab()]);
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
      expect(freshDrafts.getDraft("t-1")).toBe("");
      expect(saved("b@example.com")).toBeUndefined();
      expectNoPrompt();
    } finally {
      freshCatalog.resetCloudCatalog();
      freshAgents.resetCloudAgents();
      freshDrafts.clearDrafts(() => true);
    }
  });

  it.each(["held", "failed"] as const)("R2 a %s cache write prevents real recovery reload and sends no prompt", async (mode) => {
    await open();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    const { reload } = await mountedRecovery();
    mocks.saveMode = mode;
    setDraft("t-1", "Still only in memory");
    await reattached();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(reload).not.toHaveBeenCalled();
    expect(getDraft("t-1")).toBe("Still only in memory");
    expect(saved("a@example.com")).toBeUndefined();
    expect(screen.getByRole("status").textContent).toContain("Waiting for cloud drafts to be saved");
    expectNoPrompt();
    if (mode === "held") {
      await act(async () => mocks.finishSave!());
      await reattached();
      expect(reload).toHaveBeenCalledOnce();
      expect(saved("a@example.com")).toBe("Still only in memory");
    }
  });

  it("R2 an edit while an older save is held cannot be mistaken for completed persistence", async () => {
    await open();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    const { reload } = await mountedRecovery();
    mocks.saveMode = "held";
    setDraft("t-1", "old write in flight");
    await act(async () => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
    const finishOld = mocks.finishSave!;
    setDraft("t-1", "newest edit");
    await act(async () => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
    await reattached();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => finishOld());
    expect(saved("a@example.com")).toBe("old write in flight");
    await reattached();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => mocks.finishSave!());
    await reattached();
    expect(saved("a@example.com")).toBe("newest edit");
    expect(reload).toHaveBeenCalledOnce();
    expectNoPrompt();
  });

  it("R2 a failed acknowledgement invalidates even an earlier matching saved draft", async () => {
    await open();
    setDraft("t-1", "previously acknowledged");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    const { reload } = await mountedRecovery();
    mocks.saveMode = "failed";
    applyLiveTabs(shared, [tab()]); // Another cache write with the same draft.
    await act(async () => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
    await reattached();
    expect(reload).not.toHaveBeenCalled();
    expect(getDraft("t-1")).toBe("previously acknowledged");
    expectNoPrompt();
  });

  it.each(["a@example.com", "b@example.com"])("recovery followed by %s loading first keeps shared-workspace drafts account-owned", async (firstAccount) => {
    await open();
    setDraft("t-1", "A's half-written prompt");
    setDraft("local-recovery", "Local text survives either account");
    setDraft("unclassified", "Not proven local");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(saved("a@example.com")).toBe("A's half-written prompt");
    // The local session index positively identifies only this local tab.
    checkpointDraftsForRecovery(["local-recovery"]);

    // Dispose the old document's stores/listeners, then recreate the REAL
    // drafts/cloudAgents/cloudCatalog graph with window storage and native
    // account caches retained. No cloud ownership metadata survives in JS.
    resetCloudCatalog();
    resetCloudAgents();
    signIn(firstAccount);
    vi.resetModules();
    const freshDrafts = await import("./drafts");
    expect(freshDrafts.getDraft("t-1")).toBe(""); // Before account stores even load.
    expect(freshDrafts.getDraft("unclassified")).toBe("");
    expect(freshDrafts.getDraft("local-recovery")).toBe("Local text survives either account");
    const freshAgents = await import("./cloudAgents");
    const freshCatalog = await import("./cloudCatalog");
    const openFresh = async () => {
      await freshAgents.loadCloudAgents(shared);
      freshAgents.applyLiveTabs(shared, [tab()]);
    };
    try {
      freshCatalog.bootCloudCatalog();
      if (firstAccount === "a@example.com") {
        await openFresh();
        expect(freshDrafts.getDraft("t-1")).toBe("A's half-written prompt");
        // Deliberately NO edit after restore: clearing must use the metadata
        // built by the existing account cache path, not a new keystroke.
        signIn(null);
        expect(freshDrafts.getDraft("t-1")).toBe("");
        signIn("b@example.com");
      }
      await openFresh();
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
      expect(freshDrafts.getDraft("t-1")).toBe("");
      expect(mocks.caches["b@example.com"]["t-1"]).toBeDefined();
      expect(saved("b@example.com")).toBeUndefined();
      expect(freshDrafts.getDraft("local-recovery")).toBe("Local text survives either account");
      // The original same-workspace control still restores A's OWN cache.
      signIn("a@example.com");
      await openFresh();
      expect(freshDrafts.getDraft("t-1")).toBe("A's half-written prompt");
      signIn("b@example.com"); // Direct A-to-B also clears without any edit.
      expect(freshDrafts.getDraft("t-1")).toBe("");
      await openFresh();
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
      expect(saved("b@example.com")).toBeUndefined();
    } finally {
      freshCatalog.resetCloudCatalog();
      freshAgents.resetCloudAgents();
      freshDrafts.clearDrafts(() => true);
    }
  });

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
