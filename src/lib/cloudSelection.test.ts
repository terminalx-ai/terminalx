import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// PRO-23: after a relaunch the cloud session the window showed comes back, as
// a click on its row would select it, for the same account only, and never
// over something chosen since the launch.

const mocks = vi.hoisted(() => ({
  status: null as unknown as AccountStatus,
  ready: true,
  listeners: new Set<() => void>(),
  api: { cloudCatalogLoad: vi.fn(), cloudCatalogSave: vi.fn(), cloudAgentPurgeWorkspace: vi.fn(), cloudWorkspaceRepositories: vi.fn(), cloudWorkspaceResume: vi.fn(), cloudRemoteAttach: vi.fn() },
  invoke: vi.fn(async (_command: string, _args?: unknown) => undefined),
  workspaceConnection: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: mocks.api, workspaceConnection: mocks.workspaceConnection }));
vi.mock("@/lib/account", () => ({
  getAccount: () => ({ status: mocks.status, ready: mocks.ready, busy: false }),
  useAccount: () => ({ status: mocks.status, ready: mocks.ready, busy: false }),
  subscribeAccount: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
  refreshAccount: vi.fn(),
}));

const catalog = await import("@/lib/cloudCatalog");
const sessions = await import("@/lib/sessions");
const { bootCloudSelection, resetCloudSelection } = await import("./cloudSelection");

const ORG = "org-a";
const KEY = `cloud:${ORG}:alpha:s1`;

function account(email: string | null, ready = true) {
  mocks.ready = ready;
  mocks.status = (
    email
      ? {
          state: "signed-in",
          identity: { name: "A", email, organization: "Acme", organizationId: ORG },
          expiresAt: null,
          lastError: null,
          context: { scope: "s", revision: "s:1" },
          multiOrg: true,
          organizations: [{ id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } }],
        }
      : { state: "signed-out", identity: null, expiresAt: null, lastError: null }
  ) as AccountStatus;
  for (const listener of [...mocks.listeners]) listener();
}

function item(id: string, fields: Record<string, unknown> = {}): CloudWorkspaceListItem {
  return { workspace: { id, orgId: ORG, name: id, provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 10, releaseDisposition: null, ...fields }, latestOperation: null } as CloudWorkspaceListItem;
}

/** Quit and launch again: nothing selected, nothing followed, the catalog not read yet. */
function relaunch() {
  resetCloudSelection();
  catalog.resetCloudCatalog();
  sessions.selectSession(null);
  bootCloudSelection();
}

const selected = () => sessions.getSessionStore().selectedSessionId;

beforeEach(() => {
  localStorage.clear();
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  mocks.api.cloudWorkspaceRepositories.mockResolvedValue({ configured: true, repositories: [] });
  account("a@example.com");
});

afterEach(() => {
  resetCloudSelection();
  catalog.resetCloudCatalog();
  sessions.selectSession(null);
});

describe("the selected cloud session across a relaunch", () => {
  it("comes back once the catalog lists its workspace, as its row would select it, and nothing is woken", async () => {
    bootCloudSelection();
    sessions.selectCloudSession(KEY);
    relaunch();
    expect(selected()).toBeNull();
    // Stopped: restoring only selects; the view looks without waking.
    await catalog.ingestCloudList({ workspaces: [item("alpha", { state: "suspended" })] } as never, ORG);
    expect(selected()).toBe(KEY);
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([command]) => /wake|resume|attach/i.test(String(command)))).toEqual([]);
  });

  it("waits for the account, and is never another account's", async () => {
    bootCloudSelection();
    sessions.selectCloudSession(KEY);
    account("a@example.com", false);
    relaunch();
    await catalog.ingestCloudList({ workspaces: [item("alpha")] } as never, ORG);
    expect(selected()).toBeNull();
    account("a@example.com");
    expect(selected()).toBe(KEY);

    account("b@example.com", false);
    relaunch();
    await catalog.ingestCloudList({ workspaces: [item("alpha")] } as never, ORG);
    account("b@example.com");
    expect(selected()).toBeNull();
  });

  it("gives way to whatever is chosen first, and then remembers that instead", async () => {
    bootCloudSelection();
    sessions.selectCloudSession(KEY);
    relaunch();
    sessions.openAgents();
    await catalog.ingestCloudList({ workspaces: [item("alpha")] } as never, ORG);
    expect(sessions.getSessionStore().view).toBe("agents");
    relaunch();
    await catalog.ingestCloudList({ workspaces: [item("alpha")] } as never, ORG);
    expect(selected()).toBeNull();
  });

  it("a local session chosen later replaces it", async () => {
    bootCloudSelection();
    sessions.selectCloudSession(KEY);
    sessions.selectSession("local-1");
    relaunch();
    await catalog.ingestCloudList({ workspaces: [item("alpha")] } as never, ORG);
    expect(selected()).toBeNull();
  });

  it("is forgotten when this launch's list no longer has the workspace, and not opened when it is archived", async () => {
    bootCloudSelection();
    sessions.selectCloudSession(KEY);
    relaunch();
    await catalog.ingestCloudList({ workspaces: [item("beta")] } as never, ORG);
    expect(selected()).toBeNull();
    expect(localStorage.getItem("terminalx.cloudSelection")).toBe("{}");

    sessions.selectCloudSession(KEY);
    relaunch();
    await catalog.ingestCloudList({ workspaces: [item("alpha", { state: "archived", archivedAt: 1 })] } as never, ORG);
    expect(selected()).toBeNull();
  });
});
