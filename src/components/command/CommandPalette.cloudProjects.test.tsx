import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import type { Project } from "@/types/session";

// PRO-23: Search lists project rows, local and cloud, each saying where it
// is, so two projects of the same name in two organizations read apart.

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), updateCloudSession: vi.fn(), status: null as unknown as AccountStatus, api: { cloudCatalogLoad: vi.fn(), cloudCatalogSave: vi.fn(), cloudRemoteAttach: vi.fn(), cloudWorkspaceResume: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/lib/cloudSessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/cloudSessions")>(),
  updateCloudSession: mocks.updateCloudSession,
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, api: new Proxy(original.api, { get: (target, key: string) => (key in mocks.api ? mocks.api[key as keyof typeof mocks.api] : target[key as keyof typeof target]) }) };
});
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));

const { CommandPalette } = await import("./CommandPalette");
const store = await import("@/lib/sessions");
const catalog = await import("@/lib/cloudCatalog");
const prefs = await import("@/lib/prefs");

const local: Project = { path: "/code/accone", name: "accone" };

function blank(id: string, orgId: string, name: string): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId, name, provider: "local-docker", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, lastActivityAt: 20, releaseDisposition: null, repositories: [] },
    latestOperation: null,
  } as unknown as CloudWorkspaceListItem;
}

beforeEach(async () => {
  mocks.updateCloudSession.mockReset().mockResolvedValue(undefined);
  mocks.status = {
    state: "signed-in",
    identity: { name: "Alice", email: "alice@example.com", organization: "Share Lab", organizationId: "org-share" },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    multiOrg: true,
    organizations: [
      { id: "org-share", name: "Share Lab", role: "owner", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: "org-second", name: "Second Lab", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ],
  } as AccountStatus;
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects: [local], lastSelected: local.path };
    if (command === "list_sessions" || command === "list_workspaces" || command === "list_harnesses") return [];
    return null;
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  prefs.setPrefs({ hiddenOrganizations: [], organizationDisplay: "all", cloudBlankProjects: {} });
  await catalog.ingestCloudList({ workspaces: [blank("w1", "org-share", "accone")] }, "org-share");
  await catalog.ingestCloudList({ workspaces: [blank("w2", "org-second", "accone")] }, "org-second");
  await act(async () => {
    await store.refreshEverything();
    store.selectSession(null);
  });
});

describe("cloud status commands", () => {
  async function selectCloud(authority: "manage" | "participate" = "manage", capabilities = ["session/2", "session-status/1"], role: "manager" | "driver" = "manager") {
    const item = blank("w1", "org-share", "accone");
    item.workspace.authority = authority;
    item.workspace.you = { role, canApprove: false };
    await catalog.ingestCloudList({ workspaces: [item] }, "org-share");
    catalog.cacheCloudSessions("org-share", "w1", [{ id: "s1", title: "Cloud review", projectPath: "/workspace", cwd: "/workspace", created: "2026-01-01", modified: "2026-01-01", pinned: false, archived: false, tabs: [], manualStatus: "in_progress" }], capabilities);
    act(() => store.selectCloudSession("cloud:org-share:w1:s1"));
  }

  it("routes the selected cloud session through its cloud setter without connecting to populate the chooser", async () => {
    await selectCloud();
    const closed = vi.fn();
    render(<CommandPalette open onOpenChange={closed} onOpenSettings={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: "Set status" } });
    fireEvent.click(await screen.findByRole("option", { name: /Set status…/ }));
    expect(screen.getByRole("option", { name: /In progress/ }).textContent).toContain("Current status");
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "In review" }));
    await waitFor(() => expect(mocks.updateCloudSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: "cloud:org-share:w1:s1", orgId: "org-share", workspaceId: "w1", sessionId: "s1" }), { manualStatus: "in_review" }));
    expect(mocks.invoke.mock.calls.some(([command]) => command === "set_session_status")).toBe(false);
    expect(closed).toHaveBeenCalledWith(false);
  });

  it.each([
    ["participate", ["session/2", "session-status/1"], "manager"],
    ["manage", ["session/2"], "manager"],
    ["manage", ["session-status/1"], "manager"],
    ["manage", ["session/2", "session-status/1"], "driver"],
  ] as const)("omits status for authority %s, capabilities %j, role %s", async (authority, capabilities, role) => {
    await selectCloud(authority, [...capabilities], role);
    search("status");
    await screen.findByRole("option", { name: /Toggle status bar/ });
    expect(screen.queryByRole("option", { name: /Set status…/ })).toBeNull();
    expect(mocks.updateCloudSession).not.toHaveBeenCalled();
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("removes the chooser choices when the runtime capability is revoked", async () => {
    await selectCloud();
    search("Set status");
    fireEvent.click(await screen.findByRole("option", { name: /Set status…/ }));
    act(() => catalog.cacheCloudSessions("org-share", "w1", catalog.getCloudCatalog().orgs["org-share"].sessions.w1.sessions, ["session/2"]));
    await waitFor(() => expect(screen.queryByRole("option", { name: "Done" })).toBeNull());
    expect(mocks.updateCloudSession).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  cleanup();
  catalog.resetCloudCatalog();
});

function search(text: string) {
  render(<CommandPalette open onOpenChange={vi.fn()} onOpenSettings={vi.fn()} onCreated={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: text } });
}

const projectRows = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter((row) => row.id === `project:${local.path}` || row.id.startsWith("cloud-project:"));

describe("project rows in Search", () => {
  it("lists a local project and both organizations' projects of the same name, each saying where it is", async () => {
    search("accone");
    await waitFor(() => expect(projectRows()).toHaveLength(3));
    const lines = projectRows().map((row) => row.textContent);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^accone.*Share Lab cloud · no repository$/),
        expect.stringMatching(/^accone.*Second Lab cloud · no repository$/),
        `acconeLocal · ${local.path}`,
      ]),
    );
  });

  it("finds a cloud project by its organization's name", async () => {
    search("second lab");
    await waitFor(() => expect(projectRows().map((row) => row.id)).toEqual(["cloud-project:cloud:org-second:blank/accone"]));
  });

  it("opening a cloud project row focuses it in the sidebar and wakes nothing", async () => {
    search("share lab accone");
    await waitFor(() => expect(projectRows()).toHaveLength(1));
    fireEvent.click(projectRows()[0]);
    await waitFor(() => expect(store.getSessionStore().selectedCloudProject).toBe("cloud:org-share:blank/accone"));
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("leaves a hidden organization's projects out until something is typed", async () => {
    prefs.setPrefs({ hiddenOrganizations: ["org-second"] });
    render(<CommandPalette open onOpenChange={vi.fn()} onOpenSettings={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(projectRows().map((row) => row.id)).toContain("cloud-project:cloud:org-share:blank/accone"));
    expect(projectRows().map((row) => row.id)).not.toContain("cloud-project:cloud:org-second:blank/accone");
    prefs.setPrefs({ hiddenOrganizations: [] });
  });
});
