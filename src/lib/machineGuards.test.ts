import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * PRO-346, docs/MACHINES.md decision 8: no check may read "not a cloud key" as
 * "local", or a machine key (`machine:…`) would reach this Mac's runtime, git
 * or files. Each remaining `"cloud:"` / `isCloudKey(` site either accepts only
 * cloud keys or handles machine keys explicitly; the rest moved to `isLocalKey`.
 */
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => []) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { environmentProjects } = await import("@/components/settings/EnvironmentSettings");
const { cloudKeyOrgId } = await import("@/lib/multiOrg");
const { adjacentSession } = await import("@/lib/sessionNavigation");

const ROOT = join(__dirname, "..", "..");
const MACHINE_SESSION = "machine:cs1uhCLEB_ttCYaQ:1_xp39fWQj0RTKD0:5b4c4c1e-8c55-4a43-9d37-6a0c6b2a8f11";
const MACHINE_PROJECT = "machine:cs1uhCLEB_ttCYaQ:1_xp39fWQj0RTKD0";

/**
 * Every site that still names `"cloud:"` or calls `isCloudKey(`, with why it
 * cannot take a machine key for a local one. A new site fails this test until
 * it is looked at and listed here.
 */
const REVIEWED: Record<string, { count: number; why: string }> = {
  "src/types/target.ts": { count: 6, why: "the key helpers themselves; isLocalKey refuses cloud, machine and guest keys" },
  "src/components/layout/AppShell.tsx": { count: 1, why: "cloudKey: only a cloud session renders the cloud view; a machine session has its own branch" },
  "src/lib/cloudSelection.ts": { count: 1, why: "accepts only a cloud session key" },
  "src/lib/cloudPresence.ts": { count: 1, why: "presence targets only a selected cloud session's workspace key; a machine session is never a target" },
  "src/lib/cloudControl.ts": { count: 2, why: "refuses anything but a cloud project key" },
  "src/lib/prefs.ts": { count: 1, why: "issueCloudProject keeps only a cloud project key" },
  "src/lib/mergedCleanup.ts": { count: 1, why: "counts cloud toggles; local toggles use isLocalKey" },
  "src/lib/notify.ts": { count: 1, why: "cloud branch, then an explicit machine branch, then local" },
  "src/lib/sessionNavigation.ts": { count: 1, why: "cloud branch, then an explicit machine branch, then local" },
  "src/lib/multiOrg.ts": { count: 2, why: "cloudKeyOrgId: an organization only for a cloud key, null for a machine key" },
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$|test-utils/.test(name) ? [path] : [];
  });
}

describe("cloud-key sites", () => {
  it("are each reviewed for machine keys", () => {
    const found: Record<string, number> = {};
    for (const path of sources(join(ROOT, "src"))) {
      const count = (readFileSync(path, "utf8").match(/["']cloud:["']|isCloudKey\(/g) ?? []).length;
      if (count) found[relative(ROOT, path)] = count;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(REVIEWED).map(([file, { count }]) => [file, count])));
  });
});

describe("guards that meant 'local'", { timeout: 30_000 }, () => {
  it("leave machine projects out of this Mac's environment settings", () => {
    const projects = [{ path: "/Users/me/code/terminalx" }, { path: "cloud:org:github.com/acme/api" }, { path: MACHINE_PROJECT }, { path: "/tmp/notes", kind: "folder" }];
    expect(environmentProjects(projects).map((project) => project.path)).toEqual(["/Users/me/code/terminalx"]);
  });

  it("give a machine key no organization", () => {
    expect(cloudKeyOrgId("cloud:org-1:ws:s")).toBe("org-1");
    expect(cloudKeyOrgId(MACHINE_SESSION)).toBeNull();
  });

  it("keep a machine project out of the cloud issue project", async () => {
    vi.resetModules();
    localStorage.setItem("raccoon.prefs", JSON.stringify({ issueCloudProject: MACHINE_PROJECT }));
    const { getPrefs } = await import("@/lib/prefs");
    expect(getPrefs().issueCloudProject).toBeNull();
    localStorage.clear();
  });

  it("never tell this Mac's runtime that a machine session is shown, or keep it from the idle sweep", async () => {
    vi.resetModules();
    mocks.invoke.mockClear();
    const sessions = await import("@/lib/sessions");
    sessions.selectCloudSession(MACHINE_SESSION);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sessions.runIdleArchive();
    const calls = mocks.invoke.mock.calls as unknown as [string, Record<string, unknown>?][];
    expect(calls.filter(([command]) => command === "set_shown_session").every(([, args]) => args?.sessionId !== MACHINE_SESSION)).toBe(true);
    expect(calls.find(([command]) => command === "archive_idle_sessions")?.[1]).toEqual({ keep: [] });
  });

  it("never ask this Mac's runtime for a machine session's row status", async () => {
    vi.resetModules();
    mocks.invoke.mockClear();
    const { renderHook } = await import("@testing-library/react");
    const { useSessionRowStatuses } = await import("@/lib/sessionRowStatus");
    const local = "5d3f0a8e-4b1c-4f7e-9a2d-1c6b8e0f2a91";
    const view = renderHook(() => useSessionRowStatuses([{ id: MACHINE_SESSION, tabs: [] }, { id: "cloud:org:ws:s", tabs: [] }, { id: local, tabs: [] }]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // This Mac's own session is asked for; the machine's and the cloud's are not.
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "session_row_statuses").map(([, args]) => args)).toEqual([{ ids: [local] }]);
    view.unmount();
  });

  it("order a machine session with the cloud ones, not in this Mac's custom order", () => {
    const order = { custom: true, sessions: ["b", "a"], projects: [], revision: 1 };
    const rows = [
      { id: "a", created: "2026-11-01", lastMessageAt: "2026-11-01", pinned: false },
      { id: "b", created: "2026-11-02", lastMessageAt: "2026-11-02", pinned: false },
      { id: MACHINE_SESSION, created: "2026-11-03", lastMessageAt: "2026-11-09", pinned: false },
    ];
    expect(adjacentSession(rows, "a", 1, order)).toBe(MACHINE_SESSION);
    expect(adjacentSession(rows, MACHINE_SESSION, 1, order)).toBe("b");
  });
});
