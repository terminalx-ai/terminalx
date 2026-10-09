import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CleanupCandidate, CleanupProject, CleanupRemoveItem, CleanupResult } from "@terminalx/portable/workspace";

const local = { scan: vi.fn(), size: vi.fn(), cancel: vi.fn(), remove: vi.fn() };
const cloud = { scan: vi.fn(), size: vi.fn(), cancel: vi.fn(), remove: vi.fn() };
const forgetWorkspaceSize = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    worktreeCleanupScan: () => local.scan(),
    worktreeCleanupSize: (job: string, projectPath: string, path: string) => local.size(job, projectPath, path),
    worktreeCleanupCancelSizes: (prefix: string) => local.cancel(prefix),
    worktreeCleanupRemove: (items: CleanupRemoveItem[]) => local.remove(items),
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/lib/workspaceSizes", () => ({
  forgetWorkspaceSize: (path: string) => forgetWorkspaceSize(path),
  formatSize: (bytes: number) => `${bytes} B`,
}));
vi.mock("@/lib/cloudCatalog", () => {
  const workspace = (id: string, name: string) => ({ workspace: { id, orgId: "org", name, state: "ready" }, latestOperation: null });
  const catalog = { owner: "a", revision: null, loaded: true, orgs: { org: { orgId: "org", workspaces: [workspace("box", "Build box"), workspace("asleep", "Night box")], sessions: {} } }, createMemory: {}, notices: [] };
  return { useCloudCatalog: () => catalog };
});
vi.mock("@/lib/cloudConnections", () => ({
  useCloudConnectionsVersion: () => 0,
  connectedCloudClient: (key: string) =>
    key === "cloud:org:box"
      ? {
          hasCapability: () => true,
          scanCleanup: () => cloud.scan(),
          cleanupSize: (job: string, projectPath: string, path: string) => cloud.size(job, projectPath, path),
          cancelCleanupSizes: () => cloud.cancel(),
          removeCleanup: (items: CleanupRemoveItem[]) => cloud.remove(items),
        }
      : null,
}));
vi.mock("@/lib/cloudSessions", () => ({ managesOf: () => true }));

import { closeWorktreeCleanup, openWorktreeCleanup } from "@/lib/dialogs";
import { WorktreeCleanupDialog } from "./WorktreeCleanupDialog";

function candidate(projectPath: string, name: string, patch: Partial<CleanupCandidate> = {}): CleanupCandidate {
  return {
    projectPath,
    path: `${projectPath}/.raccoon/worktrees/${name}`,
    name,
    branch: `raccoon/${name}`,
    head: "abc",
    managed: true,
    verdict: "eligible",
    reason: null,
    lastActivity: null,
    sessions: [],
    disposable: [],
    ignoredData: [],
    token: `token-${name}`,
    ...patch,
  };
}

const main = (path: string): CleanupCandidate => candidate(path, "main", { path, branch: "main", verdict: "protected", reason: "This is the repository's main directory. It is never removed." });
const removed = (item: CleanupRemoveItem, patch: Partial<CleanupResult> = {}): CleanupResult => ({ projectPath: item.projectPath, path: item.path, outcome: "removed", reason: null, freedBytes: 5_000, keptBranch: "raccoon/x", sessionsKept: [], sessionsDeleted: [], ...patch });

const alpha: CleanupProject = {
  path: "/Users/me/alpha",
  name: "alpha",
  note: null,
  candidates: [
    main("/Users/me/alpha"),
    candidate("/Users/me/alpha", "quiet-fox", { sessions: [{ id: "s1", title: "Fix login", modified: "2026-10-01T00:00:00Z", live: null }] }),
    candidate("/Users/me/alpha", "busy-owl", { verdict: "active", reason: "The session \"Deploy\" is live: an agent is running. Nothing is stopped to clean up." }),
    candidate("/Users/me/alpha", "wip-bee", { verdict: "dirty", reason: "It has 2 modified files." }),
    candidate("/Users/me/alpha", "local-ant", { verdict: "unpushed", reason: "1 commit is only on this machine: not on any remote, and not merged into origin/main." }),
    candidate("/Users/me/alpha", "env-cat", { verdict: "ignoredData", reason: "1 ignored file or folder may be local data: .env.", ignoredData: [".env"] }),
  ],
};
const beta: CleanupProject = { path: "/Users/me/beta", name: "beta", note: null, candidates: [main("/Users/me/beta"), candidate("/Users/me/beta", "calm-elk")] };
const remote: CleanupProject = { path: "/home/dev/repo", name: "repo", note: null, candidates: [main("/home/dev/repo"), candidate("/home/dev/repo", "far-yak")] };

const box = (name: RegExp | string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

async function opened() {
  openWorktreeCleanup();
  render(<WorktreeCleanupDialog />);
  await screen.findByText("quiet-fox");
}

describe("WorktreeCleanupDialog", () => {
  afterEach(() => {
    cleanup();
    act(() => closeWorktreeCleanup());
  });
  beforeEach(() => {
    for (const mock of [...Object.values(local), ...Object.values(cloud), forgetWorkspaceSize]) mock.mockReset();
    local.scan.mockResolvedValue([alpha, beta]);
    cloud.scan.mockResolvedValue([remote]);
    local.size.mockResolvedValue(1_000);
    cloud.size.mockResolvedValue(7_000);
    local.cancel.mockResolvedValue(undefined);
    cloud.cancel.mockResolvedValue(undefined);
  });

  it("groups worktrees by host and project, says why each is kept, and selects and removes nothing by opening", async () => {
    await opened();
    const here = within(screen.getByRole("region", { name: "This computer" }));
    expect(here.getByRole("group", { name: "This computer: alpha" })).toBeTruthy();
    expect(here.getByRole("group", { name: "This computer: beta" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Build box" })).getByText("far-yak")).toBeTruthy();
    // A workspace that is not connected is unverifiable, and offers nothing.
    const asleep = within(screen.getByRole("region", { name: "Night box" }));
    expect(asleep.getByText(/Unverifiable: Not connected/)).toBeTruthy();
    expect(asleep.queryAllByRole("checkbox")).toHaveLength(0);

    for (const reason of [/an agent is running/, /2 modified files/, /only on this machine/, /may be local data: \.env/]) expect(screen.getByText(reason)).toBeTruthy();
    expect(box(/busy-owl/).disabled && box(/wip-bee/).disabled && box(/local-ant/).disabled && box(/env-cat/).disabled).toBe(true);
    // Main directories are shown as protected and have no checkbox at all.
    expect(screen.getAllByLabelText("Protected")).toHaveLength(3);
    expect(screen.queryByRole("checkbox", { name: /^main/ })).toBeNull();
    for (const checkbox of screen.getAllByRole("checkbox")) expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: /Review 0 worktrees/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/1 conversation kept, filed under the project/)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("1000 B").length).toBeGreaterThan(0));
    expect(local.size).not.toHaveBeenCalledWith(expect.anything(), "/Users/me/alpha", "/Users/me/alpha");
    expect(local.remove).not.toHaveBeenCalled();
    expect(cloud.remove).not.toHaveBeenCalled();
  });

  it("cancelling from the review removes nothing", async () => {
    await opened();
    fireEvent.click(box(/quiet-fox/));
    fireEvent.click(screen.getByRole("button", { name: /Review 1 worktree/ }));
    const list = within(screen.getByRole("list", { name: "Worktrees to remove" }));
    expect(list.getByText("quiet-fox")).toBeTruthy();
    expect(list.getByText(/Branch raccoon\/quiet-fox is kept · 1 conversation kept/)).toBeTruthy();
    expect(list.getByText("Fix login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(local.remove).not.toHaveBeenCalled();
    expect(cloud.remove).not.toHaveBeenCalled();
  });

  it("removes exactly what was reviewed, each on its own host, and reports every outcome", async () => {
    local.remove.mockImplementation(async (items: CleanupRemoveItem[]) => [
      removed(items[0]!, { sessionsKept: ["s1"] }),
      removed(items[1]!, { outcome: "skipped", reason: "It changed since it was reviewed, so it was left alone.", freedBytes: 0, keptBranch: null }),
    ]);
    cloud.remove.mockImplementation(async (items: CleanupRemoveItem[]) => [removed(items[0]!, { outcome: "failed", reason: "Could not remove the worktree", freedBytes: 0, keptBranch: null })]);
    await opened();
    // Scope: everything safe on this computer, plus one on the cloud workspace.
    fireEvent.click(box("Select all safe worktrees on This computer"));
    fireEvent.click(box(/far-yak/));
    expect(box(/quiet-fox/).checked && box(/calm-elk/).checked).toBe(true);
    expect(box(/env-cat/).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Review 3 worktrees/ }));
    expect(within(screen.getByRole("list", { name: "Worktrees to remove" })).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /Remove 3 worktrees/ }));

    await screen.findByText(/Removed 1 and freed 5000 B\. 1 skipped, 1 failed\./);
    expect(local.remove).toHaveBeenCalledWith([
      { projectPath: "/Users/me/alpha", path: "/Users/me/alpha/.raccoon/worktrees/quiet-fox", token: "token-quiet-fox", deleteSessions: false, acceptIgnored: false },
      { projectPath: "/Users/me/beta", path: "/Users/me/beta/.raccoon/worktrees/calm-elk", token: "token-calm-elk", deleteSessions: false, acceptIgnored: false },
    ]);
    expect(cloud.remove).toHaveBeenCalledWith([{ projectPath: "/home/dev/repo", path: "/home/dev/repo/.raccoon/worktrees/far-yak", token: "token-far-yak", deleteSessions: false, acceptIgnored: false }]);
    const results = within(screen.getByRole("list", { name: "Results" }));
    expect(results.getByText(/changed since it was reviewed/)).toBeTruthy();
    expect(results.getByText("Could not remove the worktree")).toBeTruthy();
    expect(results.getByText(/1 conversation kept/)).toBeTruthy();
    expect(forgetWorkspaceSize).toHaveBeenCalledWith("/Users/me/alpha/.raccoon/worktrees/quiet-fox");
    expect(forgetWorkspaceSize).toHaveBeenCalledTimes(1);
  });

  it("ignored local files and conversation history each need their own switch", async () => {
    local.remove.mockImplementation(async (items: CleanupRemoveItem[]) => items.map((item) => removed(item, { sessionsDeleted: ["s1"] })));
    await opened();
    fireEvent.click(screen.getByRole("switch", { name: "Allow worktrees with ignored local files" }));
    expect(box(/env-cat/).disabled).toBe(false);
    fireEvent.click(box(/env-cat/));
    fireEvent.click(screen.getByRole("switch", { name: "Also delete conversation history" }));
    fireEvent.click(screen.getByRole("button", { name: /Review 1 worktree/ }));
    expect(screen.getByText("Ignored local files that will be deleted: .env")).toBeTruthy();
    expect(screen.getByText(/The conversations listed above are deleted too/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Remove 1 worktree/ }));
    await screen.findByText(/Removed 1/);
    expect(local.remove).toHaveBeenCalledWith([expect.objectContaining({ path: "/Users/me/alpha/.raccoon/worktrees/env-cat", deleteSessions: true, acceptIgnored: true })]);
  });

  it("size estimation can be stopped without closing the view", async () => {
    local.size.mockImplementation(() => new Promise(() => undefined));
    await opened();
    fireEvent.click(await screen.findByRole("button", { name: "Stop estimating" }));
    expect(local.cancel).toHaveBeenCalled();
    expect(screen.queryByText("Estimating sizes…")).toBeNull();
    // Still usable: a worktree with no known size can be reviewed.
    fireEvent.click(box(/quiet-fox/));
    fireEvent.click(screen.getByRole("button", { name: /Review 1 worktree \(at least 0 B\)/ }));
    expect(screen.getByText("size not known")).toBeTruthy();
    expect(local.remove).not.toHaveBeenCalled();
  });
});
