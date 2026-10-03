import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// PRO-23 CS-19, end to end through the real stores: a waiting cloud tab shows
// in the dashboard's Needs-you column and the dock badge, raises one notice,
// and the notice, the card and the palette open it without waking anything.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  status: null as unknown as AccountStatus,
  badge: vi.fn(async () => undefined),
  sendNotification: vi.fn(),
  resume: vi.fn(),
  workspaceConnection: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: mocks.badge }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: mocks.sendNotification,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: { ...original.api, cloudWorkspaceResume: mocks.resume, cloudWorkspaces: vi.fn(), cloudCatalogLoad: vi.fn(), cloudCatalogSave: vi.fn(), cloudAgentPurgeWorkspace: vi.fn() },
    workspaceConnection: mocks.workspaceConnection,
    closeWorkspaceConnection: vi.fn(),
  };
});
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));
// The new-workspace form has its own tests; here only that the palette opens it.
const openNewWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/components/cloud/NewCloudWorkspaceDialog", () => ({ openNewCloudWorkspace: openNewWorkspace }));
vi.mock("@/lib/cloudConnections", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cloudConnections")>();
  return { ...original, wakeCloudConnection: vi.fn(original.wakeCloudConnection), retainCloudConnection: vi.fn(original.retainCloudConnection) };
});

const { AgentDashboard } = await import("./AgentDashboard");
const { CommandPalette } = await import("@/components/command/CommandPalette");
const { Toasts } = await import("@/components/ui/Toasts");
const notify = await import("@/lib/notify");
const catalog = await import("@/lib/cloudCatalog");
const sessions = await import("@/lib/sessions");
const terminal = await import("@/lib/terminal");
const connections = await import("@/lib/cloudConnections");
const { resetCloudAgents } = await import("@/lib/cloudAgents");
const { resetCloudSessions } = await import("@/lib/cloudSessions");

const ORG = "org-a";
const OTHER = "org-b";
const acmeApi = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };
const betaSite = { identity: "github.com/beta/site", fullName: "beta/site", cloneUrl: "https://github.com/beta/site.git", primary: true };

function item(id: string, orgId: string, fields: Record<string, unknown> = {}): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId, name: id, provider: "box", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, releaseDisposition: null, repositories: [acmeApi], ...fields },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

const session = (id: string, title: string, status: string, fields: Record<string, unknown> = {}) => ({
  id,
  projectPath: "/workspace",
  cwd: "/workspace",
  title,
  created: "2026-09-30T10:00:00.000Z",
  modified: "2026-09-30T11:00:00.000Z",
  archived: false,
  pinned: false,
  tabs: [{ id: `${id}-tab`, harness: "claude", title: null, model: "opus", permissionMode: "default", status, created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" }],
  ...fields,
});

const pending = (count: number) => ({ online: true, reportedAt: Date.now(), activeTurns: 0, pendingApprovals: count });

/** A poll of the organization's list: the same rows each time unless changed. */
async function poll(orgId: string, workspaces: CloudWorkspaceListItem[]) {
  await act(async () => {
    await catalog.ingestCloudList({ workspaces, quota: { used: workspaces.length, limit: 3 } }, orgId);
    await Promise.resolve();
  });
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function expectNoWake() {
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(mocks.workspaceConnection).not.toHaveBeenCalled();
  expect(connections.wakeCloudConnection).not.toHaveBeenCalled();
  expect(connections.retainCloudConnection).not.toHaveBeenCalled();
}

const acmeWorkspaces = (count: number) => [item("ws-1", ORG, { runtimeActivity: pending(count) }), item("ws-2", ORG, { runtimeActivity: { online: true, reportedAt: 1, activeTurns: 1, pendingApprovals: 0 } }), item("ws-3", ORG, { state: "suspended" })];

// jsdom draws nothing, so it has no scrolling.
Element.prototype.scrollIntoView ??= function () {};
Element.prototype.scrollTo ??= function () {} as typeof Element.prototype.scrollTo;

beforeEach(async () => {
  mocks.status = {
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    multiOrg: true,
    organizations: [
      { id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: OTHER, name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ],
  } as AccountStatus;
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "cloud_agent_cache_load") return { tabs: {} };
    if (command === "cloud_agent_outbox" || command === "cloud_agent_checkpoints") return [];
    if (command === "session_summaries" || command === "list_sessions") return [];
    if (command === "list_projects") return { projects: [], lastSelected: null };
    return undefined;
  });
  for (const fn of [mocks.resume, mocks.workspaceConnection, mocks.sendNotification, mocks.badge, connections.wakeCloudConnection, connections.retainCloudConnection]) vi.mocked(fn).mockClear();
  act(() => sessions.selectSession(null));
  // The cache the catalog saved says what each workspace's runtime last listed.
  await poll(ORG, acmeWorkspaces(0));
  catalog.cacheCloudSessions(ORG, "ws-1", [session("s1", "Fix login redirect", "in_progress", { branch: "terminalx/fix-login-3f2a" })] as never, ["session/2"]);
  catalog.cacheCloudSessions(ORG, "ws-2", [session("s2", "Add tests", "in_progress")] as never, ["session/2"]);
  catalog.cacheCloudSessions(ORG, "ws-3", [session("s3", "Long task", "in_progress")] as never, ["session/2"]);
  await poll(OTHER, [item("ws-b", OTHER, { repositories: [betaSite] })]);
  catalog.cacheCloudSessions(OTHER, "ws-b", [session("sb", "Landing page copy", "completed", { branch: "feature/landing" })] as never, ["session/2"]);
  notify.startNotifications();
  await settle();
});

afterEach(() => {
  cleanup();
  catalog.resetCloudCatalog();
  resetCloudAgents();
  resetCloudSessions();
});

describe("a waiting cloud tab", () => {
  it("shows in Needs you, counts in the dock badge, raises one notice across polls, and its notice opens the tab without waking", async () => {
    window.dispatchEvent(new Event("blur"));
    // The list now says ws-1 waits on an approval; polled three times.
    for (let i = 0; i < 3; i++) await poll(ORG, acmeWorkspaces(1));
    await settle();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification.mock.calls[0][0]).toMatchObject({ title: "TerminalX — Claude needs attention" });
    expect(String(mocks.sendNotification.mock.calls[0][0].body)).toContain("Fix login redirect · Acme cloud");
    // Waiting, plus Beta's finished and unread session: two want the reader back.
    expect(mocks.badge).toHaveBeenLastCalledWith(2);

    // Focused, a new wait elsewhere raises an in-app notice; clicking it selects that session and tab.
    window.dispatchEvent(new Event("focus"));
    render(<Toasts />);
    await poll(ORG, [...acmeWorkspaces(1).slice(0, 1), item("ws-2", ORG, { runtimeActivity: pending(1) }), acmeWorkspaces(1)[2]]);
    await settle();
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("Claude needs attention");
    fireEvent.click(toast);
    expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:ws-2:s2`);
    expect(terminal.getTerminalState().selected[`cloud:${ORG}:ws-2:s2`]).toEqual({ kind: "agent", id: "s2-tab" });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expectNoWake();
  });
});

describe("the Agent Dashboard", () => {
  it("puts cloud sessions in Needs you, Working and Done like local ones, never a stopped one in Working, and opens a card without waking", async () => {
    await poll(ORG, acmeWorkspaces(1));
    render(
      <TooltipProvider>
        <AgentDashboard />
      </TooltipProvider>,
    );
    await settle();
    const column = (label: string) => screen.getByRole("region", { name: label });
    const cards = (label: string) => within(column(label)).queryAllByTestId("cloud-agent-card").map((card) => card.getAttribute("data-session"));
    expect(cards("Needs you")).toEqual([`cloud:${ORG}:ws-1:s1`]);
    expect(cards("Working")).toEqual([`cloud:${ORG}:ws-2:s2`]);
    // Beta's finished session and the stopped workspace's (cached "working") one are Done.
    expect(cards("Done").sort()).toEqual([`cloud:${ORG}:ws-3:s3`, `cloud:${OTHER}:ws-b:sb`].sort());
    expect(within(column("Needs you")).getByText("Waiting for your decision")).toBeTruthy();

    fireEvent.click(within(column("Needs you")).getByTestId("cloud-agent-card"));
    expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:ws-1:s1`);
    expect(terminal.getTerminalState().selected[`cloud:${ORG}:ws-1:s1`]).toEqual({ kind: "agent", id: "s1-tab" });
    expectNoWake();
  });
});

describe("the command palette", () => {
  const openPalette = () =>
    render(
      <TooltipProvider>
        <CommandPalette open onOpenChange={() => undefined} onOpenSettings={() => undefined} onCreated={() => undefined} />
      </TooltipProvider>,
    );

  it.each([
    ["title", "login redirect", "Fix login redirect"],
    ["repository", "acme/api", "Fix login redirect"],
    ["branch", "fix-login-3f2a", "Fix login redirect"],
    ["another organization's branch", "feature/landing", "Landing page copy"],
  ])("finds a cloud session by %s", async (_what, query, title) => {
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: query } });
    const option = await screen.findByRole("option", { name: new RegExp(title) });
    expect(option.textContent).toContain("cloud");
  });

  it("opens a result by selecting it, without a wake", async () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    try {
      openPalette();
      fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: "landing page" } });
      fireEvent.click(await screen.findByRole("option", { name: /Landing page copy/ }));
      await waitFor(() => expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${OTHER}:ws-b:sb`));
      expectNoWake();
    } finally {
      frame.mockRestore();
    }
  });

  describe("the entries that replace the full-window cloud page (PRO-68)", () => {
    const frames = () =>
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        callback(0);
        return 0;
      });
    const search = (value: string) => fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value } });

    it("no longer has the old page's command", async () => {
      openPalette();
      search("cloud workspace session");
      await screen.findByRole("option", { name: /Go to cloud session…/ });
      expect(screen.queryByRole("option", { name: /Open a cloud workspace session/ })).toBeNull();
    });

    it("Go to cloud session… keeps the palette open on the cloud sessions; choosing one selects it without a wake", async () => {
      const frame = frames();
      try {
        const onOpenChange = vi.fn();
        render(
          <TooltipProvider>
            <CommandPalette open onOpenChange={onOpenChange} onOpenSettings={() => undefined} onCreated={() => undefined} />
          </TooltipProvider>,
        );
        search("go to cloud");
        fireEvent.click(await screen.findByRole("option", { name: /Go to cloud session…/ }));
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
        expect((screen.getByPlaceholderText(/Search sessions/) as HTMLInputElement).value).toBe("cloud ");
        // Both organizations' sessions are listed.
        await screen.findByRole("option", { name: /Fix login redirect/ });
        fireEvent.click(await screen.findByRole("option", { name: /Landing page copy/ }));
        await waitFor(() => expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${OTHER}:ws-b:sb`));
        expectNoWake();
      } finally {
        frame.mockRestore();
      }
    });

    it("New cloud workspace… opens the form for an admin of the default organization, and creates nothing by itself", async () => {
      const frame = frames();
      try {
        openPalette();
        search("new cloud workspace");
        fireEvent.click(await screen.findByRole("option", { name: /New cloud workspace…/ }));
        await waitFor(() => expect(openNewWorkspace).toHaveBeenCalledTimes(1));
        expectNoWake();
      } finally {
        frame.mockRestore();
      }
    });

    it("does not offer New cloud workspace… to a member, who could only be refused", async () => {
      mocks.status = { ...mocks.status, organizations: mocks.status.organizations!.map((org) => (org.id === ORG ? { ...org, role: "member" } : org)) } as AccountStatus;
      openPalette();
      search("cloud workspace");
      await screen.findByRole("option", { name: /Go to cloud session…/ });
      expect(screen.queryByRole("option", { name: /New cloud workspace…/ })).toBeNull();
    });

    it("offers neither entry while signed out", async () => {
      mocks.status = { state: "signed-out", identity: null, expiresAt: null, lastError: null } as unknown as AccountStatus;
      openPalette();
      search("cloud");
      await settle();
      expect(screen.queryByRole("option", { name: /Go to cloud session…/ })).toBeNull();
      expect(screen.queryByRole("option", { name: /New cloud workspace…/ })).toBeNull();
    });
  });
});
