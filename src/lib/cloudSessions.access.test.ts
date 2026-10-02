import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSession, WorkspaceConnectionState, WorkspaceYou } from "@terminalx/portable/workspace";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// Found in the live two-person re-test: after a share was revoked, the
// person's sidebar kept a selected "Terminal 1" row under the workspace that
// now read "Not shared". Losing access forgets everything the sidebar shows of
// the workspace, and getting it back reads it again.

const mocks = vi.hoisted(() => ({
  api: { cloudWorkspaces: vi.fn(), cloudWorkspaceRepositories: vi.fn(), cloudWorkspaceResume: vi.fn(), cloudRemoteAttach: vi.fn(), cloudAgentPurgeWorkspace: vi.fn(), cloudCatalogLoad: vi.fn(), cloudCatalogSave: vi.fn() },
  workspaceConnection: vi.fn(),
  status: null as unknown as AccountStatus,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
  workspaceConnection: mocks.workspaceConnection,
  hasWorkspaceConnection: () => true,
  closeWorkspaceConnection: vi.fn(),
}));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));

const catalog = await import("@/lib/cloudCatalog");
const { bootCloudSessions, liveCloudSessionList, resetCloudSessions } = await import("@/lib/cloudSessions");
const { retainCloudConnection, resetCloudConnections } = await import("@/lib/cloudConnections");
const { applyCollabEvent, clearCollabAccess, resetCollab, startCollab } = await import("@/lib/cloudCollab");
const cloudTerminals = await import("@/lib/cloudTerminals");
const terminalStore = await import("@/lib/terminal");

const ORG = "org-a";
const WS = "share-demo";
const KEY = `cloud:${ORG}:${WS}`;
const SESSION = `${KEY}:s1`;

const session = (id: string, title: string): RuntimeSession =>
  ({ id, projectPath: "/workspace", cwd: "/workspace", title, created: "2026-10-01T10:00:00.000Z", modified: "2026-10-01T11:00:00.000Z", archived: false, pinned: false, tabs: [{ id: `${id}-tab`, harness: "claude", title: null, model: "opus", permissionMode: "default", status: "idle", created: "", modified: "" }] }) as unknown as RuntimeSession;

function item(you: { role: WorkspaceYou["role"]; canApprove: boolean } | null): CloudWorkspaceListItem {
  return {
    workspace: { id: WS, orgId: ORG, name: WS, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, authority: "participate", ...(you ? { you } : {}) },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

/** A runtime this desktop is connected to as `you`. */
function runtime(you: WorkspaceYou) {
  const state: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: ["session/1", "session/2", "pty/2", "collab/1"], authority: "participate", you } as WorkspaceConnectionState;
  const sessionListeners = new Set<(sessions: RuntimeSession[]) => void>();
  const client = {
    connection: state,
    onState: (listener: (state: WorkspaceConnectionState) => void) => {
      listener(state);
      return () => undefined;
    },
    hasCapability: (capability: string) => (state as { capabilities: string[] }).capabilities.includes(capability),
    listSessions: vi.fn(async () => [session("s1", "echo:hello from Alice")]),
    listAgentTabs: vi.fn(async () => []),
    onSessions: (listener: (sessions: RuntimeSession[]) => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    onNotification: () => () => undefined,
    listPtys: vi.fn(async () => ({ epoch: "e1", terminals: [{ ptyId: "p1", number: 1, epoch: "e1", pid: 1, cwd: "/w", cols: 80, rows: 24, createdAt: 1, offset: 0, exited: false, exitCode: null, control: "other", sessionId: "s1" }] })),
    attachPty: vi.fn(async () => ({ cursor: () => undefined, detach: vi.fn() })),
  };
  const activate = vi.fn(async () => undefined);
  return { connection: { target: { kind: "cloud", organizationId: ORG, workspaceId: WS }, client, activate, close: vi.fn() }, client, activate, pushSessions: (sessions: RuntimeSession[]) => sessionListeners.forEach((listener) => listener(sessions)) };
}

const xterm = () => ({ el: document.createElement("div"), term: { write: vi.fn(), onData: vi.fn(), onBinary: vi.fn(), onResize: vi.fn(), dispose: vi.fn(), cols: 80, rows: 24, resize: vi.fn() }, fit: {} }) as never;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const driver: WorkspaceYou = { userId: "u-bob", role: "driver", canApprove: false };
const none: WorkspaceYou = { userId: "u-bob", role: "none", canApprove: false };

/** Bob has the session open on its terminal tab, as in the re-test. */
async function opened(you: WorkspaceYou = driver) {
  const held = runtime(you);
  mocks.workspaceConnection.mockResolvedValue(held.connection);
  bootCloudSessions();
  await retainCloudConnection({ orgId: ORG, workspaceId: WS }, "connect");
  await settle();
  await cloudTerminals.syncCloudTerminals(KEY, held.client as never, xterm);
  terminalStore.selectSessionTab(SESSION, { kind: "terminal", id: `cloud:${KEY}:p1` });
  return held;
}

beforeEach(async () => {
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.workspaceConnection.mockReset();
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  mocks.status = {
    state: "signed-in",
    identity: { name: "Bob", email: "bob@example.com", organization: "Share Lab", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    organizations: [{ id: ORG, name: "Share Lab", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } }],
  } as AccountStatus;
  await catalog.ingestCloudList({ workspaces: [item({ role: "driver", canApprove: false })] }, ORG);
});

afterEach(() => {
  resetCloudSessions();
  resetCloudConnections();
  resetCollab();
  cloudTerminals.resetCloudTerminals();
  catalog.resetCloudCatalog();
});

describe("losing access to a cloud workspace", () => {
  it("forgets its sessions, tabs, terminals and the selected tab the moment the runtime says role none", async () => {
    const held = await opened();
    expect(liveCloudSessionList(ORG, WS)?.map((row) => row.title)).toEqual(["echo:hello from Alice"]);
    expect(catalog.getCloudCatalog().orgs[ORG].sessions[WS]?.sessions).toHaveLength(1);
    expect(cloudTerminals.cloudTerminalsOf(KEY).terminals.map((terminal) => terminal.title)).toEqual(["Terminal 1"]);
    held.client.listSessions.mockClear();

    applyCollabEvent(KEY, { type: "you", you: none });

    // The sidebar's sources are all empty: the live list, the saved list, the terminals and their pty list.
    expect(liveCloudSessionList(ORG, WS)).toBeNull();
    expect(catalog.getCloudCatalog().orgs[ORG].sessions[WS]).toBeUndefined();
    expect(cloudTerminals.cloudTerminalsOf(KEY).terminals).toEqual([]);
    expect(cloudTerminals.cloudTerminalsOf(KEY).selected).toBeNull();
    // No tab stays asked for in its sessions: the session's own view (the lock pane) is what is selected.
    expect(terminalStore.getTerminalState().selected[SESSION]).toBeUndefined();

    // A list the runtime sent on its way out is not taken, live or saved.
    held.pushSessions([session("s1", "echo:hello from Alice")]);
    expect(liveCloudSessionList(ORG, WS)).toBeNull();
    expect(catalog.getCloudCatalog().orgs[ORG].sessions[WS]).toBeUndefined();
    // Looking never wakes compute: nothing was read, attached or resumed for this.
    expect(held.client.listSessions).not.toHaveBeenCalled();
    expect(held.activate).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("does the same when the API refuses the reconnect, and when a connection starts without access", async () => {
    await opened();
    clearCollabAccess(KEY);
    expect(liveCloudSessionList(ORG, WS)).toBeNull();
    expect(cloudTerminals.cloudTerminalsOf(KEY).terminals).toEqual([]);
    expect(terminalStore.getTerminalState().selected[SESSION]).toBeUndefined();

    // Reconnected with role none (the share was revoked while this desktop was away).
    resetCloudSessions();
    resetCloudConnections();
    cloudTerminals.resetCloudTerminals();
    await catalog.ingestCloudList({ workspaces: [item({ role: "driver", canApprove: false })] }, ORG);
    catalog.cacheCloudSessions(ORG, WS, [session("s1", "echo:hello from Alice")], ["session/2"]);
    // What this window still held from before: a terminal and the tab asked for.
    await cloudTerminals.syncCloudTerminals(KEY, runtime(driver).client as never, xterm);
    terminalStore.selectSessionTab(SESSION, { kind: "terminal", id: `cloud:${KEY}:p1` });
    const held = runtime(none);
    mocks.workspaceConnection.mockResolvedValue(held.connection);
    bootCloudSessions();
    await retainCloudConnection({ orgId: ORG, workspaceId: WS }, "connect");
    await settle();
    expect(liveCloudSessionList(ORG, WS)).toBeNull();
    expect(catalog.getCloudCatalog().orgs[ORG].sessions[WS]).toBeUndefined();
    expect(cloudTerminals.cloudTerminalsOf(KEY).terminals).toEqual([]);
    expect(terminalStore.getTerminalState().selected[SESSION]).toBeUndefined();
    // The session view's own hello handling says the same, and changes nothing more.
    startCollab(KEY, held.client as never);
    expect(cloudTerminals.cloudTerminalsOf(KEY).terminals).toEqual([]);
  });

  it("drops the saved session list of a workspace the list says is not shared, or no longer lists", async () => {
    catalog.cacheCloudSessions(ORG, WS, [session("s1", "echo:hello from Alice")], ["session/2"]);
    await catalog.ingestCloudList({ workspaces: [item({ role: "none", canApprove: false })] }, ORG);
    expect(catalog.getCloudCatalog().orgs[ORG].sessions[WS]).toBeUndefined();

    // Shared again, read again; then made private (no longer listed for this person at all).
    await catalog.ingestCloudList({ workspaces: [item({ role: "viewer", canApprove: false })] }, ORG);
    catalog.cacheCloudSessions(ORG, WS, [session("s1", "echo:hello from Alice")], ["session/2"]);
    expect(catalog.getCloudCatalog().orgs[ORG].sessions[WS]?.sessions).toHaveLength(1);
    await catalog.ingestCloudList({ workspaces: [] }, ORG);
    expect(catalog.getCloudCatalog().orgs[ORG].sessions[WS]).toBeUndefined();
    // An older server that reports no roles keeps what it had.
    await catalog.ingestCloudList({ workspaces: [item(null)] }, ORG);
    catalog.cacheCloudSessions(ORG, WS, [session("s1", "echo:hello from Alice")], ["session/2"]);
    await catalog.ingestCloudList({ workspaces: [item(null)] }, ORG);
    expect(catalog.getCloudCatalog().orgs[ORG].sessions[WS]?.sessions).toHaveLength(1);
  });

  it("reads the sessions again when the workspace is shared again on the same connection", async () => {
    const held = await opened();
    applyCollabEvent(KEY, { type: "you", you: none });
    expect(liveCloudSessionList(ORG, WS)).toBeNull();
    held.client.listSessions.mockClear();

    applyCollabEvent(KEY, { type: "you", you: { ...driver, role: "viewer" } });
    await settle();
    expect(held.client.listSessions).toHaveBeenCalledTimes(1);
    expect(liveCloudSessionList(ORG, WS)?.map((row) => row.title)).toEqual(["echo:hello from Alice"]);
    expect(catalog.getCloudCatalog().orgs[ORG].sessions[WS]?.sessions).toHaveLength(1);
    // Its terminals come back with the session view's next read of the pty list.
    await cloudTerminals.syncCloudTerminals(KEY, held.client as never, xterm);
    expect(cloudTerminals.cloudTerminalsOf(KEY).terminals.map((terminal) => terminal.title)).toEqual(["Terminal 1"]);
    expect(held.activate).not.toHaveBeenCalled();
  });
});

describe("a tab added to a session (live test: two rows named after the session)", () => {
  it("reads as its agent until its first message, while the first tab keeps the session's title", async () => {
    const { buildCloudSessions } = await import("@/lib/cloudSessions");
    const title = "echo:hello from alice";
    const tab = (id: string, own: string | null) => ({ id, harness: "claude", title: own, model: "opus", permissionMode: "default", status: "idle", created: "", modified: "" });
    const live = [{ ...session("s1", title), tabs: [tab("t1", "Echo:hello from alice"), tab("t2", null)], activeTab: "t2" }] as unknown as RuntimeSession[];
    // The runtime's agent list reports the session's title for a tab without one of its own.
    const info = (tabId: string, reported: string) => ({ tabId, info: { sessionId: "s1", tabId, title: reported, harness: "claude", status: "idle", pendingPermissions: [] }, unread: false, live: true, placeholder: false });
    const rows = buildCloudSessions({ item: item({ role: "manager", canApprove: true }), live, agentTabs: [info("t1", "Echo:hello from alice"), info("t2", title)] as never });
    expect(rows[0].title).toBe(title);
    expect(rows[0].tabs.map((row) => row.title)).toEqual(["Echo:hello from alice", null]);
    // After its first message it has its own title.
    const named = buildCloudSessions({ item: item({ role: "manager", canApprove: true }), live, agentTabs: [info("t1", "Echo:hello from alice"), info("t2", "Echo:erin tab")] as never });
    expect(named[0].tabs.map((row) => row.title)).toEqual(["Echo:hello from alice", "Echo:erin tab"]);
    // A first tab with no title yet goes by the session's.
    const first = buildCloudSessions({ item: item({ role: "manager", canApprove: true }), live: [{ ...live[0], tabs: [tab("t1", null)] }] as never, agentTabs: [info("t1", title)] as never });
    expect(first[0].tabs.map((row) => row.title)).toEqual([title]);
  });
});
