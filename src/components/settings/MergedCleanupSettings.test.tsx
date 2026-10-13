import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergedRemovalView } from "@terminalx/portable/workspace";
import type { HeadBranchSetting, MergedCleanupSettings as Settings } from "@/lib/api";
import type { Project } from "@/types/session";

// #432: the setting that removes a workspace once its pull request has merged.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  projects: [] as Project[],
  catalog: { orgs: {} as Record<string, unknown> },
  clients: new Map<string, unknown>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: mocks.projects }) }));
vi.mock("@/lib/cloudCatalog", () => ({ useCloudCatalog: () => mocks.catalog, getCloudCatalog: () => mocks.catalog }));
vi.mock("@/lib/cloudConnections", () => ({ useCloudConnectionsVersion: () => 0, connectedCloudClient: (key: string) => mocks.clients.get(key) ?? null }));
vi.mock("@/lib/cloudSessions", () => ({ managesOf: () => true, forgetCloudSessions: vi.fn(), refreshCloudSessions: vi.fn(async () => undefined) }));
vi.mock("@/lib/workspaceSizes", () => ({ forgetWorkspaceSize: vi.fn() }));

const { MergedCleanupSettings } = await import("./MergedCleanupSettings");
const { resetMergedCleanupForTest } = await import("@/lib/mergedCleanup");

const record = (patch: Partial<MergedRemovalView>): MergedRemovalView => ({
  id: "removal-1",
  removedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  projectPath: "/repos/app",
  path: "/repos/app/.raccoon/worktrees/quiet-amber-fox",
  name: "quiet-amber-fox",
  branch: "raccoon/quiet-amber-fox",
  commit: "abcdef0123456789abcdef0123456789abcdef01",
  pr: { number: 62, title: "Fix login", url: "https://github.com/acme/app/pull/62", head: "abcdef0123456789abcdef0123456789abcdef01" },
  localBranch: { outcome: "deleted" },
  remoteBranch: { outcome: "deleted" },
  sessionsKept: ["s1"],
  sessionsDeleted: [],
  blocked: null,
  ...patch,
});

let settings: Settings;
let records: MergedRemovalView[];
let head: Record<string, HeadBranchSetting | Error>;
let saveFails: string | null;
/** The projects whose pull requests a pass could not read. */
let unreadable: { projectPath: string; reason: string }[];

const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
const toggle = (name: string) => screen.getByRole("switch", { name });
const projectRow = (name: string) => within(screen.getByRole("list", { name: "Projects" })).getByText(name).closest("li") as HTMLElement;

async function show() {
  render(<MergedCleanupSettings />);
  await waitFor(() => expect(toggle("Delete the workspace when its pull request is merged").hasAttribute("disabled")).toBe(false));
}

beforeEach(() => {
  settings = { enabled: false, projects: {}, deleteConversations: false, graceMinutes: 10 };
  records = [];
  head = {};
  saveFails = null;
  unreadable = [];
  mocks.projects = [
    { path: "/repos/app", name: "App", kind: "git" },
    { path: "/repos/site", name: "Site" },
    { path: "/notes", name: "Notes", kind: "folder" },
    { path: "/repos/old", name: "Old", archived: true },
  ];
  mocks.catalog.orgs = { "org-1": { workspaces: [{ workspace: { orgId: "org-1", id: "ws-1", name: "api", state: "ready" } }] } };
  mocks.clients.clear();
  mocks.openUrl.mockReset();
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: { projectPath?: string; patch?: Partial<Settings> & { project?: { key: string; enabled: boolean | null } } }) => {
    if (command === "merged_cleanup_settings") return settings;
    if (command === "set_merged_cleanup_settings") {
      if (saveFails) throw new Error(saveFails);
      const { project, ...rest } = args?.patch ?? {};
      const projects = { ...settings.projects };
      if (project) {
        if (project.enabled === null) delete projects[project.key];
        else projects[project.key] = project.enabled;
      }
      settings = { ...settings, ...rest, projects };
      return settings;
    }
    if (command === "merged_cleanup_sweep") return { statuses: [], unreadable };
    if (command === "merged_cleanup_records") return records;
    if (command === "merged_cleanup_restore") return { record: { ...records[0], restoredAt: new Date().toISOString() }, notes: ['The session "Fix login" has been used since and stays under the project.'] };
    if (command === "github_head_branch_setting" || command === "github_enable_head_branch_deletion") {
      const found = head[args?.projectPath ?? ""];
      if (!found || found instanceof Error) throw found ?? new Error("GitHub CLI (gh) is not installed or not on PATH.");
      if (command === "github_enable_head_branch_deletion") head[args!.projectPath!] = { ...found, enabled: true };
      return head[args!.projectPath!];
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  resetMergedCleanupForTest();
});

describe("the setting", () => {
  it("is off until it is turned on, and what depends on it waits for that", async () => {
    await show();
    const main = toggle("Delete the workspace when its pull request is merged");
    expect(main.getAttribute("aria-checked")).toBe("false");
    expect(toggle("Also delete its conversations").hasAttribute("disabled")).toBe(true);
    expect(within(screen.getByRole("radiogroup", { name: "Wait before deleting" })).getAllByRole("radio").every((radio) => radio.hasAttribute("disabled"))).toBe(true);
    // Nothing was run to show the page, and nothing is asked of GitHub for a project it is off for.
    expect(calls("merged_cleanup_sweep")).toEqual([]);
    expect(calls("github_head_branch_setting")).toEqual([]);

    fireEvent.click(main);
    await waitFor(() => expect(main.getAttribute("aria-checked")).toBe("true"));
    expect(calls("set_merged_cleanup_settings")).toEqual([{ patch: { enabled: true } }]);

    const conversations = toggle("Also delete its conversations");
    expect(conversations.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(conversations);
    await waitFor(() => expect(conversations.getAttribute("aria-checked")).toBe("true"));
    const waits = within(screen.getByRole("radiogroup", { name: "Wait before deleting" })).getAllByRole("radio");
    expect(waits.map((radio) => radio.textContent)).toEqual(["5 min", "10 min", "30 min", "1 hour"]);
    expect(waits[1].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(waits[2]);
    await waitFor(() => expect(waits[2].getAttribute("aria-checked")).toBe("true"));
    expect(calls("set_merged_cleanup_settings").slice(1)).toEqual([{ patch: { deleteConversations: true } }, { patch: { graceMinutes: 30 } }]);
  });

  it("lets each Git project and cloud workspace answer for itself, or follow the default", async () => {
    await show();
    // Folders have no pull requests, and an archived project is not cleaned.
    expect(within(screen.getByRole("list", { name: "Projects" })).getAllByRole("listitem").map((row) => row.querySelector("div.truncate")?.textContent)).toEqual(["App", "Site", "api"]);
    const choices = (name: string) => within(within(projectRow(name)).getByRole("radiogroup")).getAllByRole("radio");
    expect(choices("App").map((radio) => radio.textContent)).toEqual(["Default (off)", "On", "Off"]);
    expect(choices("App")[0].getAttribute("aria-checked")).toBe("true");

    fireEvent.click(choices("App")[1]);
    await waitFor(() => expect(choices("App")[1].getAttribute("aria-checked")).toBe("true"));
    expect(choices("Site")[0].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(choices("api")[1]);
    await waitFor(() => expect(choices("api")[1].getAttribute("aria-checked")).toBe("true"));
    // A cloud workspace's passes run only while it is connected, and that is said.
    expect(projectRow("api").textContent).toContain("Runs while the workspace is connected.");
    fireEvent.click(choices("App")[0]);
    await waitFor(() => expect(choices("App")[0].getAttribute("aria-checked")).toBe("true"));
    expect(calls("set_merged_cleanup_settings")).toEqual([
      { patch: { project: { key: "/repos/app", enabled: true } } },
      { patch: { project: { key: "cloud:org-1:ws-1", enabled: true } } },
      { patch: { project: { key: "/repos/app", enabled: null } } },
    ]);
    expect(settings.projects).toEqual({ "cloud:org-1:ws-1": true });
  });

  it("says under a project why its pull requests could not be read, since nothing in it will go until they can", async () => {
    settings.enabled = true;
    unreadable = [{ projectPath: "/repos/site", reason: "GitHub CLI (gh) is not installed or not on PATH." }];
    await show();
    await waitFor(() => expect(projectRow("Site").textContent).toContain("Its pull requests could not be read: GitHub CLI (gh) is not installed or not on PATH."));
    expect(projectRow("App").textContent).not.toContain("could not be read");
  });

  it("says why a change was not saved", async () => {
    saveFails = "The settings file could not be written.";
    await show();
    fireEvent.click(toggle("Delete the workspace when its pull request is merged"));
    expect((await screen.findByRole("alert")).textContent).toBe("The settings file could not be written.");
    expect(toggle("Delete the workspace when its pull request is merged").getAttribute("aria-checked")).toBe("false");
  });
});

describe("GitHub's own head branch deletion", () => {
  it("is offered to an administrator of a project the setting is on for, and turned on from here", async () => {
    settings.projects = { "/repos/app": true };
    head = {
      "/repos/app": { repository: "acme/app", enabled: false, admin: true },
      "/repos/site": { repository: "acme/site", enabled: false, admin: true },
    };
    await show();
    const offer = await within(projectRow("App")).findByRole("button", { name: "Turn on “Automatically delete head branches”" });
    // Not for a project the setting is off for.
    expect(calls("github_head_branch_setting")).toEqual([{ projectPath: "/repos/app" }]);
    expect(within(projectRow("Site")).queryByRole("button")).toBeNull();

    fireEvent.click(offer);
    await waitFor(() => expect(projectRow("App").textContent).toContain("GitHub deletes the merged branches of acme/app itself."));
    expect(calls("github_enable_head_branch_deletion")).toEqual([{ projectPath: "/repos/app" }]);
    expect(within(projectRow("App")).queryByRole("button")).toBeNull();
  });

  it("is not offered to a reader who cannot change it, and nothing is said when GitHub cannot be asked", async () => {
    settings.enabled = true;
    head = { "/repos/app": { repository: "acme/app", enabled: false, admin: false }, "/repos/site": new Error("gh: not logged in") };
    await show();
    await waitFor(() => expect(calls("github_head_branch_setting")).toHaveLength(2));
    await act(async () => {});
    for (const name of ["App", "Site"]) {
      expect(within(projectRow(name)).queryByRole("button")).toBeNull();
      expect(projectRow(name).textContent).not.toContain("GitHub");
    }
  });

  it("says why it could not be turned on", async () => {
    settings.enabled = true;
    head = { "/repos/app": { repository: "acme/app", enabled: false, admin: true } };
    await show();
    const offer = await within(projectRow("App")).findByRole("button", { name: /Automatically delete head branches/ });
    head["/repos/app"] = new Error("Must have admin rights to Repository.");
    fireEvent.click(offer);
    expect((await within(projectRow("App")).findByRole("alert")).textContent).toBe("Must have admin rights to Repository.");
  });
});

describe("what was removed", () => {
  it("is listed with its branch, commit and pull request, and can be restored while that is possible", async () => {
    records = [
      record({}),
      record({ id: "removal-2", name: "calm-teal-owl", branch: "raccoon/calm-teal-owl", removedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), remoteBranch: { outcome: "moved", at: "1234567890".repeat(4) }, blocked: "Something is at its path again." }),
      record({ id: "removal-3", name: "bold-red-hen", removedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), restoredAt: new Date(Date.now() - 60_000).toISOString(), blocked: "It was brought back already." }),
    ];
    await show();
    const list = await screen.findByRole("list", { name: "Workspaces removed after their pull request merged" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("quiet-amber-fox");
    expect(rows[0].textContent).toContain("raccoon/quiet-amber-fox at abcdef0");
    expect(rows[0].textContent).toContain("Pull request #62 merged; removed 5m ago. The local branch raccoon/quiet-amber-fox was deleted. Its branch on the remote was deleted.");
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Pull request #62" }));
    expect(mocks.openUrl).toHaveBeenCalledWith("https://github.com/acme/app/pull/62");
    // One that cannot be brought back says why, and one that was says so: neither offers Restore.
    expect(rows[1].textContent).toContain("removed 3h ago.");
    expect(rows[1].textContent).toContain("Its branch on the remote was kept: it has moved to 1234567 since the merge.");
    expect(rows[1].textContent).toContain("Cannot be brought back: Something is at its path again.");
    expect(rows[2].textContent).toContain("Brought back 1m ago.");
    expect(within(list).getAllByRole("button", { name: /^Restore / }).map((button) => button.getAttribute("aria-label"))).toEqual(["Restore quiet-amber-fox"]);

    fireEvent.click(within(rows[0]).getByRole("button", { name: "Restore quiet-amber-fox" }));
    expect((await within(list).findByRole("status")).textContent).toBe('The session "Fix login" has been used since and stays under the project.');
    expect(calls("merged_cleanup_restore")).toEqual([{ id: "removal-1" }]);
    // The list is read again after it.
    expect(calls("merged_cleanup_records").length).toBeGreaterThan(1);
  });

  it("says so when nothing has been removed", async () => {
    await show();
    expect(await screen.findByText("Nothing has been removed yet.")).toBeTruthy();
  });
});
