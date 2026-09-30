import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus } from "@/lib/api";
import type { Project, SessionEntry, Workspace } from "@/types/session";

// A DOM snapshot of the whole sidebar rail (destinations, the project list
// header, projects and the account entry). It was recorded before the
// organization sections (PRO-58) were added: signed out, or signed in with no
// organization that has cloud workspaces enabled, the sidebar must stay
// exactly as it was.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  account: null as unknown as AccountStatus,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set() }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));

const { ProjectRail } = await import("./ProjectRail");
const sessions = await import("@/lib/sessions");
const account = await import("@/lib/account");

const NOW = new Date("2026-09-30T12:00:00.000Z");
const projectPath = "/repos/raccoon";
const workspace: Workspace = {
  path: projectPath, name: "raccoon", branch: "main", head: "abc1234", isMain: true, managed: false,
  uncommitted: 0, additions: 2, deletions: 1, unpushed: 0, ahead: 0, behind: 0,
};
const projects: Project[] = [{ path: projectPath, name: "Raccoon", pinned: true }, { path: "/notes", name: "Notes", kind: "folder" }];
const sessionList: SessionEntry[] = [
  {
    id: "s1", projectPath, cwd: projectPath, worktreeRemoved: false, title: "Fix scroll snapping",
    created: "2026-09-29T00:00:00.000Z", modified: "2026-09-30T11:58:00.000Z", archived: false, pinned: false,
    tabs: [{ id: "t1", harness: "claude", title: null, model: "opus", permissionMode: "auto", status: "in_progress", created: "2026-09-30T10:00:00.000Z", modified: "2026-09-30T10:00:00.000Z" }],
    activeTab: "t1",
  },
];

const signedIn = (organizations: AccountStatus["organizations"]): AccountStatus => ({
  state: "signed-in",
  identity: { name: "Ada", email: "ada@example.com", organization: "Acme", organizationId: "org-a" },
  expiresAt: null,
  lastError: null,
  context: { scope: "scope", revision: "scope:1" },
  organizations,
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  mocks.account = { state: "signed-out", identity: null, expiresAt: null, lastError: null };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects, lastSelected: projectPath };
    if (command === "list_sessions") return sessionList;
    if (command === "list_harnesses") return [{ id: "claude", name: "Claude", available: true }];
    if (command === "list_workspaces") return [workspace];
    if (command === "account_status") return mocks.account;
    if (command === "list_automations") return [];
    return null;
  });
  await act(async () => {
    await sessions.bootSessions();
    await sessions.refreshEverything();
    await account.bootAccount();
  });
});
afterEach(cleanup);
afterAll(() => vi.useRealTimers());

const noop = () => {};
const mount = () =>
  render(
    <TooltipProvider>
      <ProjectRail
        onOpenSettings={noop}
        onOpenAccount={noop}
        onOpenIssues={noop}
        onOpenAgents={noop}
        onOpenStats={noop}
        onOpenAutomations={noop}
        onOpenSkills={noop}
        onSearch={noop}
      />
    </TooltipProvider>,
  );

async function setAccount(status: AccountStatus) {
  mocks.account = status;
  await act(async () => {
    await account.refreshAccount();
  });
}

describe("sidebar rail DOM", () => {
  it("signed out", async () => {
    await setAccount({ state: "signed-out", identity: null, expiresAt: null, lastError: null });
    expect(mount().container).toMatchSnapshot();
  });

  it("signed in, with no organization that has cloud workspaces enabled", async () => {
    await setAccount(
      signedIn([
        { id: "org-a", name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: false, flags: {} } },
        { id: "org-old", name: "Old", role: "member" },
      ]),
    );
    expect(mount().container).toMatchSnapshot();
  });
});
