import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTabInfo, WorkspaceConnectionState } from "@terminalx/portable/workspace";

const mocks = vi.hoisted(() => ({ purge: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { cloudAgentPurgeWorkspace: mocks.purge },
  closeWorkspaceConnection: mocks.close,
  hasWorkspaceConnection: vi.fn(() => false),
  workspaceConnection: vi.fn(),
  workspaceTargetKey: (target: { kind: string; organizationId?: string; workspaceId?: string }) =>
    target.kind === "local" ? "local" : `cloud:${target.organizationId}:${target.workspaceId}`,
}));

import { applyLiveTabs, getCloudAgents, resetCloudAgents } from "./cloudAgents";
import { dropEditors, getEditors, openFile, setEditorDirty } from "./editors";
import { hasWorkspaceConnection, workspaceConnection, type CloudWorkspace, type CloudWorkspaceDisposition } from "@/lib/api";
import {
  checkRuntime,
  cleanupStateText,
  deadlineText,
  purgeNoticeText,
  purgeTombstones,
  repositoryRiskLines,
  resetPurged,
  risksOf,
} from "./cloudLifecycle";

const KEY = "cloud:org-1:ws-gone";
const tombstone = { id: "ws-gone", orgId: "org-1", deletedAt: 1, expiresAt: 2 };

const tab = (fields: Partial<AgentTabInfo> = {}): AgentTabInfo => ({
  sessionId: "s-1",
  tabId: "t-1",
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
  created: "2026-09-29T00:00:00Z",
  modified: "2026-09-29T00:00:00Z",
  ...fields,
});

beforeEach(() => {
  mocks.purge.mockReset();
  mocks.close.mockReset();
  resetPurged();
});

afterEach(() => {
  dropEditors(() => true);
  resetCloudAgents();
});

describe("purgeTombstones", () => {
  it("drops the deleted workspace's editors, unsaved text, agent tabs, connection and native store, and only its own", async () => {
    const dirty = openFile(KEY, "cloud://x", "README.md", undefined, "cloud://x", KEY);
    openFile(KEY, "cloud://x", "src/app.ts", undefined, "cloud://x", KEY);
    setEditorDirty(dirty, true);
    const kept = openFile("cloud:org-1:ws-live", "cloud://y", "a.ts", undefined, "cloud://y", "cloud:org-1:ws-live");
    setEditorDirty(kept, true);
    applyLiveTabs({ organizationId: "org-1", workspaceId: "ws-gone" }, [tab()]);
    mocks.purge.mockResolvedValue({ removed: true, unsentCommands: 2, cachedTabs: 1 });

    const notices = await purgeTombstones([tombstone], new Map([["ws-gone", "Docs site"]]));

    expect(mocks.purge).toHaveBeenCalledWith("org-1", "ws-gone");
    expect(mocks.close).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org-1", workspaceId: "ws-gone" });
    expect(getEditors().editors.map((entry) => entry.id)).toEqual([kept]);
    expect(getCloudAgents({ organizationId: "org-1", workspaceId: "ws-gone" }).tabs).toEqual([]);
    expect(notices).toEqual([{ workspaceId: "ws-gone", name: "Docs site", unsentCommands: 2, unsavedFiles: 1 }]);
    expect(purgeNoticeText(notices[0])).toBe(
      "“Docs site” was permanently deleted. TerminalX removed what this Mac kept of it, including 2 agent messages that never reached it and unsaved edits in 1 file.",
    );
  });

  it("an already-purged tombstone is left alone on the next list", async () => {
    mocks.purge.mockResolvedValue({ removed: true, unsentCommands: 0, cachedTabs: 0 });
    await purgeTombstones([tombstone], new Map());
    const again = await purgeTombstones([tombstone], new Map());
    expect(again).toEqual([]);
    expect(mocks.purge).toHaveBeenCalledTimes(1);
  });

  it("a workspace this Mac never kept anything of says nothing", async () => {
    mocks.purge.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
    expect(await purgeTombstones([tombstone], new Map())).toEqual([]);
  });

  it("a native purge that fails keeps everything for the next list, which says what went", async () => {
    const dirty = openFile(KEY, "cloud://x", "README.md", undefined, "cloud://x", KEY);
    setEditorDirty(dirty, true);
    mocks.purge.mockRejectedValueOnce("cloud_agent_store_unwritable").mockResolvedValueOnce({ removed: true, unsentCommands: 0, cachedTabs: 1 });
    expect(await purgeTombstones([tombstone], new Map())).toEqual([]);
    expect(getEditors().editors.map((entry) => entry.id)).toEqual([dirty]);
    const notices = await purgeTombstones([tombstone], new Map());
    expect(notices).toHaveLength(1);
    expect(purgeNoticeText(notices[0])).toBe(
      "A cloud workspace was permanently deleted. TerminalX removed what this Mac kept of it, including unsaved edits in 1 file.",
    );
  });

  it("overlapping list reloads purge a tombstone once", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.purge.mockReturnValue(new Promise((done) => (resolve = done)));
    const first = purgeTombstones([tombstone], new Map([["ws-gone", "Docs site"]]));
    const second = purgeTombstones([tombstone], new Map([["ws-gone", "Docs site"]]));
    resolve({ removed: true, unsentCommands: 0, cachedTabs: 0 });
    const notices = [...(await first), ...(await second)];
    expect(notices).toHaveLength(1);
    expect(mocks.purge).toHaveBeenCalledTimes(1);
  });
});

describe("risks and wording", () => {
  it("combines the server's activity report with the runtime's facts", () => {
    const server = {
      runtime: { reporting: true, reportedAt: 1, stale: false, activeTurns: 0, pendingApprovals: 1 },
      blockers: ["pending-approvals", "operation-in-progress"],
    } as never;
    const risks = risksOf(server, { kind: "offline" });
    expect(risks).toMatchObject({ activeTurns: 0, pendingApprovals: 1, operationInProgress: true, needsForce: true, repositories: [] });
    expect(risksOf(null, null).needsForce).toBe(false);
  });

  it("names local-only commits when there is no upstream to be ahead of", () => {
    expect(
      repositoryRiskLines({ path: "r", branch: null, dirtyFiles: 0, untrackedFiles: 0, unpushedCommits: null, hasUpstream: false, localOnlyCommits: 4, openPullRequests: null }),
    ).toEqual(["4 commits on no remote branch"]);
  });

  it("says when the deadline is and what a cleanup item waits for", () => {
    const now = Date.UTC(2026, 8, 29);
    expect(deadlineText(now + 29.5 * 86_400_000, now)).toBe("in 29 days");
    expect(deadlineText(now + 3 * 3_600_000, now)).toBe("in 3 hours");
    expect(deadlineText(now - 1, now)).toBe("any moment now");
    expect(cleanupStateText({ kind: "provider-storage", state: "pending", providerStage: "blocked", expectedBy: now + 2 * 86_400_000 }, now)).toBe(
      "Waiting for the provider to confirm (blocked), expected in 2 days",
    );
    expect(cleanupStateText({ kind: "x", state: "retained-by-provider", providerStage: null, expectedBy: null })).toMatch(/Kept by the provider/);
  });
});

describe("checkRuntime", () => {
  const workspace = (state: string) => ({ id: "ws-1", orgId: "org-1", name: "boat-e2e-3", state }) as CloudWorkspace;
  const server = (state: string) => ({ state, runtimeFacts: { available: true } }) as CloudWorkspaceDisposition;
  const facts = { v: 1, repositories: [], activeTasks: [], runningProcesses: 0, observedAt: 1 };

  /** A connection whose client starts in `initial` and moves through `later`, one state per tick. */
  function connectWith(initial: WorkspaceConnectionState["state"], later: WorkspaceConnectionState[] = []) {
    let state: WorkspaceConnectionState = { state: initial } as WorkspaceConnectionState;
    const listeners = new Set<(state: WorkspaceConnectionState) => void>();
    const client = {
      get connection() {
        return state;
      },
      onState(listener: (state: WorkspaceConnectionState) => void) {
        listeners.add(listener);
        listener(state);
        return () => listeners.delete(listener);
      },
      call: vi.fn(async () => facts),
    };
    void (async () => {
      for (const next of later) {
        await Promise.resolve();
        state = next;
        for (const listener of [...listeners]) listener(next);
      }
    })();
    vi.mocked(workspaceConnection).mockResolvedValue({ client } as never);
    return client;
  }

  beforeEach(() => {
    vi.mocked(workspaceConnection).mockReset();
    vi.mocked(hasWorkspaceConnection).mockReturnValue(false);
  });

  it("never connects to a workspace the server reports stopped, even if the list row still says ready", async () => {
    expect(await checkRuntime(workspace("ready"), server("suspended"))).toEqual({ kind: "offline" });
    expect(await checkRuntime(workspace("archived"), null)).toEqual({ kind: "offline" });
    expect(workspaceConnection).not.toHaveBeenCalled();
  });

  it("asks a running workspace's runtime over a connect that cannot wake it", async () => {
    const client = connectWith("opening", [{ state: "connecting", attempt: 1 }, { state: "connected" } as WorkspaceConnectionState]);
    expect(await checkRuntime(workspace("ready"), server("ready"))).toEqual({ kind: "checked", facts });
    expect(workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org-1", workspaceId: "ws-1" }, "connect");
    expect(client.call).toHaveBeenCalledWith("lifecycle.dispositionFacts");
    // The connection was made for the check, so it is closed after it.
    expect(mocks.close).toHaveBeenCalled();
  });

  it("goes by the server's fresh state over a stale list row", async () => {
    connectWith("connected");
    expect(await checkRuntime(workspace("suspended"), server("ready"))).toMatchObject({ kind: "checked" });
  });

  it("says a running workspace it could not reach in time is unreachable, not offline", async () => {
    connectWith("opening", [{ state: "reconnecting", attempt: 1, reason: "relay timed out", retryInMs: 1000 }]);
    expect(await checkRuntime(workspace("ready"), server("ready"), 20)).toEqual({ kind: "unreachable" });
    connectWith("stopped");
    expect(await checkRuntime(workspace("ready"), server("ready"))).toEqual({ kind: "unreachable" });
  });

  it("reports offline when the attach finds the workspace suspended after all", async () => {
    connectWith("opening", [{ state: "suspended" }]);
    expect(await checkRuntime(workspace("ready"), server("ready"))).toEqual({ kind: "offline" });
  });

  it("keeps a connection it reused, and handles one already suspended", async () => {
    vi.mocked(hasWorkspaceConnection).mockReturnValue(true);
    connectWith("suspended");
    expect(await checkRuntime(workspace("ready"), server("ready"))).toEqual({ kind: "offline" });
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
