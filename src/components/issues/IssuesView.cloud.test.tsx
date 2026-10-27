import "@testing-library/dom";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateRefused } from "@/lib/cloudCreate";
import { forgetAgentLoginsRequest, takeAgentLoginsRequest, takeOrganizationRequest } from "@/lib/settingsLinks";
import { setPrefs } from "@/lib/prefs";
import type { ModelInfo } from "@/lib/api";
import type { CloudIssueOutcome, CloudSessionRequest } from "@/lib/cloudNewSession";
import type { IssuePipeline } from "@/types/issuePipeline";
import type { Project } from "@/types/session";
import type { CloudProject } from "@/types/target";

// #433, the cloud half: the Issues view for a cloud project. Its issues are
// its repository's, read with the reader's own gh through the project's key;
// a session on one starts in one of its workspaces, whose runtime carries it on.

const PROJECT = "cloud:org-a:github.com/acme/api";

const { invoke, sessionStore, pipelineStore, cloudStart, openCloudSession, startCloudSessionIn, models } = vi.hoisted(() => ({
  invoke: vi.fn(),
  pipelineStore: { pipelines: [] as IssuePipeline[] },
  sessionStore: {
    projects: [{ path: "/repo", name: "Raccoon" }] as Project[],
    harnesses: [{ id: "claude", name: "Claude Code", available: true, installHint: "", caps: {} }],
    selectedProject: "/repo",
    sessions: [],
    newSessionPreset: null,
    workspaces: {},
  },
  cloudStart: {
    plan: { kind: "reuse" } as { kind: string; node?: unknown },
    outcome: { supported: true, pipeline: { id: "p1", cloud: true }, note: null } as CloudIssueOutcome,
    startInWorkspace: vi.fn(),
  },
  openCloudSession: vi.fn(),
  startCloudSessionIn: vi.fn(),
  models: [] as ModelInfo[],
}));

const node = { key: "cloud:org-a:ws-1", placedBy: "server", item: { workspace: { id: "ws-1", orgId: "org-a", name: "acme-api", state: "ready" }, latestOperation: null } };
const cloudProject = { key: PROJECT, orgId: "org-a", identity: "github.com/acme/api", fullName: "acme/api", selected: true, pinned: false, blank: false, workspaces: [node] } as unknown as CloudProject;

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/components/ui/tooltip", () => ({
  WithTooltip: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  PERMISSION_MODES: [{ id: "bypassPermissions", label: "Bypass permissions", hint: "" }],
  refreshModels: vi.fn(),
  useModels: (harness: string) => models.filter((m) => m.harness === harness),
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notePipelineState: vi.fn() }));
vi.mock("@/lib/issuePipeline", async (original) => ({
  ...(await original<typeof import("@/lib/issuePipeline")>()),
  useIssuePipelines: () => pipelineStore.pipelines,
  startPipeline: vi.fn(),
}));
vi.mock("@/lib/sessions", () => ({
  openAutomation: vi.fn(),
  selectProject: vi.fn(),
  selectSession: vi.fn(),
  startCloudSessionIn,
  upsertSession: vi.fn(),
  useSessionStore: () => sessionStore,
}));
const cloudWorkState = vi.hoisted(() => ({
  account: { status: { state: "signed-in", identity: { email: "me@example.com", organizationId: "org-a" }, context: { account: "test" }, organizations: [{ id: "org-a", name: "Acme", role: "owner", cloud: { enabled: true, flags: {} } }] }, ready: true, busy: false },
  catalog: { owner: "me@example.com", loaded: true, orgs: {} },
  rows: [],
  accountChanged: () => {},
}));
vi.mock("@/lib/account", async (original) => ({
  ...(await original<typeof import("@/lib/account")>()),
  getAccount: () => cloudWorkState.account,
  useAccount: () => cloudWorkState.account,
  subscribeAccount: (listener: () => void) => { cloudWorkState.accountChanged = listener; return () => {}; },
}));
vi.mock("@/lib/cloudCatalog", async (original) => ({
  ...(await original<typeof import("@/lib/cloudCatalog")>()),
  getCloudCatalog: () => cloudWorkState.catalog,
  useCloudCatalog: () => cloudWorkState.catalog,
}));
vi.mock("@/lib/cloudDashboard", async (original) => ({ ...(await original<typeof import("@/lib/cloudDashboard")>()), useCloudDashboard: () => cloudWorkState.rows, openCloudSession }));
vi.mock("@/lib/cloudModels", async (original) => ({ ...(await original<typeof import("@/lib/cloudModels")>()), useCloudModelClient: () => null }));
vi.mock("@/components/session/CloudNewSession", async (original) => ({
  ...(await original<typeof import("@/components/session/CloudNewSession")>()),
  useCloudProjectChoices: () => [
    { orgId: "org-a", orgName: "Acme", mayStart: true, projects: [cloudProject] },
    { orgId: "org-b", orgName: "Other", mayStart: true, projects: [{ ...cloudProject, key: "cloud:org-b:github.com/other/api", orgId: "org-b", fullName: "other/api" }] },
  ],
}));
vi.mock("@/lib/cloudNewSession", () => ({
  planCloudStart: () => (cloudStart.plan.kind === "create" ? { kind: "create" } : { kind: cloudStart.plan.kind, node }),
  startInWorkspace: cloudStart.startInWorkspace,
}));

const { IssuesView } = await import("./IssuesView");

const issue = {
  provider: "github" as const,
  id: "433",
  identifier: "#433",
  number: 433,
  title: "Carry issue sessions on",
  url: "https://github.com/acme/api/issues/433",
  state: "OPEN",
  stateType: "open" as const,
  labels: [{ name: "cloud", color: "1D76DB" }],
  updatedAt: "2026-10-18T00:00:00Z",
  body: "Sessions stop at code.",
};

const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args as Record<string, unknown>);

let accountNumber = 0;

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "linear_status") return { connected: false };
    if (command === "gh_available") return true;
    if (command === "github_repo") return args?.projectPath === PROJECT ? "acme/api" : "terminalx-ai/raccoon";
    if (command === "work_status") return { isRepo: true, dirty: false, branch: "main", defaultBranch: "main", ahead: 0, behind: 0, aheadOfBase: 0, head: "abc" };
    if (command === "issues_list") return args?.projectPath === PROJECT ? [issue] : [];
    if (command === "issue_details") return issue;
    if (command === "issue_comments") return { comments: [], nextCursor: null, total: 0 };
    return undefined;
  });
  cloudWorkState.account.status.state = "signed-in";
  cloudWorkState.account.status.context.account = `test-${++accountNumber}`;
  cloudWorkState.accountChanged();
  cloudWorkState.catalog.orgs = { "org-a": { source: "live", workspaces: [node.item], sessions: {} } };
  pipelineStore.pipelines = [];
  cloudStart.plan = { kind: "reuse" };
  cloudStart.outcome = { supported: true, pipeline: { id: "p1", cloud: true }, note: null };
  cloudStart.startInWorkspace.mockReset().mockImplementation(async (_plan: unknown, _request: CloudSessionRequest, options?: { onIssue?: (outcome: CloudIssueOutcome) => void }) => {
    options?.onIssue?.(cloudStart.outcome);
    return "cloud:org-a:ws-1:s1";
  });
  openCloudSession.mockReset();
  startCloudSessionIn.mockReset();
  setPrefs({ lastProject: "/repo", issueCloudProject: PROJECT, lastAgent: "claude", lastMode: "bypassPermissions", issueProvider: "github", useWorktree: true, cloudIssuePipelines: {} });
});

afterEach(() => {
  cleanup();
  takeOrganizationRequest();
  forgetAgentLoginsRequest();
  setPrefs({ issueCloudProject: null });
});

/** A Radix menu opens on the pointer, as a person's click starts. */
function press(element: HTMLElement) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse" });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
  fireEvent.click(element, { button: 0 });
}

const row = () => screen.findByRole("button", { name: /#433.*Carry issue sessions on/ });

async function openIssue() {
  render(<IssuesView />);
  fireEvent.click(await row());
  await screen.findByText("Sessions stop at code.");
}

describe("the Issues view for a cloud project", () => {
  it("lists the project's issues from its repository, with this computer's projects and the cloud ones to choose from", async () => {
    setPrefs({ issueCloudProject: null });
    render(<IssuesView />);
    press(await screen.findByRole("button", { name: /Raccoon/ }));
    const group = await screen.findByRole("group", { name: "Cloud · Acme" });
    fireEvent.click(within(group).getByText("acme/api"));
    expect(await row()).toBeTruthy();
    // Every read names the project by its key; the native side reads the repository from it.
    expect(calls("issues_list").at(-1)).toMatchObject({ projectPath: PROJECT, provider: "github" });
    // A cloud project has no branches here to read.
    expect(calls("work_status").every((args) => args.projectPath !== PROJECT)).toBe(true);
  });

  it("starts an issue in the project's workspace, in a worktree named after it, carried on by the runtime", async () => {
    setPrefs({ lastMode: "default", cloudIssuePipelines: { [PROJECT]: { enabled: true, autoMerge: true, requirePerson: false, maxRounds: 2, mergeMethod: "squash", protected: { migrations: true, deploy: true, security: true, paths: [] }, ignoredChecks: [] } } });
    await openIssue();
    // No worktree switch and no merge switch: the issue gets a worktree, and a person merges.
    expect(screen.queryByRole("switch", { name: "Start issue in a new worktree" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Merge automatically when the review is addressed" })).toBeNull();
    expect(screen.getByTestId("issue-start-row").textContent).toContain("433-carry-issue-sessions-on· cloud workspace");
    expect(screen.getByTestId("issue-cloud-pipeline").textContent).toContain("you merge it here");

    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(cloudStart.startInWorkspace).toHaveBeenCalledTimes(1));
    const [plan, request] = cloudStart.startInWorkspace.mock.calls[0] as [{ kind: string }, CloudSessionRequest];
    expect(plan.kind).toBe("reuse");
    expect(request).toMatchObject({
      agent: "claude",
      mode: "manual",
      useWorktree: true,
      title: "#433 Carry issue sessions on",
      issue: {
        ref: { provider: "github", id: "433", identifier: "#433", title: "Carry issue sessions on", url: issue.url },
        body: "Sessions stop at code.",
        worktreeName: "433-carry-issue-sessions-on",
        pipeline: true,
        settings: { maxRounds: 2, mergeMethod: "squash", autoMerge: false },
      },
    });
    expect(request.prompt).toContain("Work on GitHub issue #433: Carry issue sessions on");
    // Nothing is started on this computer.
    expect(calls("create_session")).toEqual([]);
    expect(screen.queryByTestId("issue-start-note")).toBeNull();
  });

  it("says when the session will not be carried on, and where there is no workspace to start in", async () => {
    cloudStart.outcome = { supported: false, pipeline: null, note: null };
    await openIssue();
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect((await screen.findByTestId("issue-start-note")).textContent).toContain("older TerminalX");

    cloudStart.outcome = { supported: true, pipeline: null, note: "This session runs on main itself." };
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start anyway" }));
    await waitFor(() => expect(screen.getByTestId("issue-start-note").textContent).toContain("runs on main itself"));

    cleanup();
    cloudStart.plan = { kind: "create" };
    cloudStart.startInWorkspace.mockClear();
    await openIssue();
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start anyway" }));
    const note = await screen.findByTestId("issue-start-note");
    expect(note.textContent).toContain("no workspace to start in");
    expect(cloudStart.startInWorkspace).not.toHaveBeenCalled();
    fireEvent.click(within(note).getByRole("button", { name: "New session…" }));
    expect(startCloudSessionIn).toHaveBeenCalledWith(PROJECT);
  });

  it("offers the failed organization's Agent logins and clears recovery on retry", async () => {
    cloudStart.startInWorkspace.mockRejectedValueOnce(new CreateRefused("cloud_workspace_agent_credential_required", "claude"));
    await openIssue();
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Agent logins" }));
    expect(takeOrganizationRequest()).toBe("org-a");
    expect(takeAgentLoginsRequest("org-a")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(cloudStart.startInWorkspace).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Open Agent logins" })).toBeNull();
  });

  it("keeps a pending failure's organization after switching cloud projects", async () => {
    let rejectStart!: (error: unknown) => void;
    cloudStart.startInWorkspace.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStart = reject; }));
    await openIssue();
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(cloudStart.startInWorkspace).toHaveBeenCalledTimes(1));
    press(screen.getByRole("button", { name: "acme/api" }));
    fireEvent.click(await screen.findByText("other/api"));
    await waitFor(() => expect(calls("issues_list").at(-1)).toMatchObject({ projectPath: "cloud:org-b:github.com/other/api" }));
    await act(async () => rejectStart(new CreateRefused("cloud_workspace_agent_credential_required", "claude")));
    fireEvent.click(await screen.findByRole("button", { name: "Open Agent logins" }));
    expect(takeOrganizationRequest()).toBe("org-a");
    expect(takeAgentLoginsRequest("org-b")).toBe(false);
    expect(takeAgentLoginsRequest("org-a")).toBe(true);
  });

  it("does not offer Agent logins for unrelated start failures", async () => {
    cloudStart.startInWorkspace.mockRejectedValueOnce(new Error("Workspace disconnected"));
    await openIssue();
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(await screen.findByText("Workspace disconnected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Agent logins" })).toBeNull();
  });

  it("starts nothing in a repository that is no longer selected for cloud workspaces", async () => {
    (cloudProject as { selected: boolean }).selected = false;
    try {
      await openIssue();
      expect((screen.getByRole("button", { name: "Start session" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/no longer selected for cloud workspaces/)).toBeTruthy();
    } finally {
      (cloudProject as { selected: boolean }).selected = true;
    }
  });

  it("shows the issue's cloud pipeline and opens its session in the cloud", async () => {
    pipelineStore.pipelines = [
      {
        id: "p1", projectPath: PROJECT, cloud: true,
        place: { orgId: "org-a", workspaceId: "ws-1", projectKey: PROJECT, repository: "acme/api", readAt: Date.now() },
        issue: { provider: "github", id: "433", identifier: "#433", title: issue.title, url: issue.url },
        branch: "raccoon/433-carry-issue-sessions-on",
        author: { sessionId: "cloud:org-a:ws-1:s1", tabId: "t1" }, reviewer: null,
        autoMerge: false, stopped: false, stage: "review", state: "working", reason: null, note: "Review 1 of 3: the reviewer session is reading 1111111111.",
        pr: { number: 7, url: "https://github.com/acme/api/pull/7", base: "main" },
        round: 1, maxRounds: 3, reviewCommit: null, verdict: null, securityAreas: [], merged: null, events: [],
        created: "2026-10-18T00:00:00.000Z", modified: "2026-10-18T00:00:00.000Z",
      },
    ];
    await openIssue();
    expect(within(screen.getByTestId("issue-pipeline")).getByText("In review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(openCloudSession).toHaveBeenCalledWith("cloud:org-a:ws-1:s1", "t1");
    // Automations run in projects on this computer.
    fireEvent.contextMenu(await row());
    expect(await screen.findByText("Automations run in projects on this computer")).toBeTruthy();
  });
});

it("counts a successful cloud start before claims or lists arrive and opens it from the duplicate warning", async () => {
  await openIssue();
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await screen.findByText("You · in the cloud");
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open the existing session" }));
  expect(openCloudSession).toHaveBeenCalledWith("cloud:org-a:ws-1:s1", undefined);
  expect(cloudStart.startInWorkspace).toHaveBeenCalledTimes(1);
  const choose = async (label: string) => {
    fireEvent.pointerDown(screen.getByRole("button", { name: /^Working: / }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: label }));
  };
  await choose("Only mine");
  expect(await row()).toBeTruthy();
  await choose("Hide issues someone is working on");
  await waitFor(() => expect(screen.queryByRole("button", { name: /#433.*Carry issue sessions on/ })).toBeNull());
});

it("does not retain a failed start as work or warn on its retry", async () => {
  cloudStart.startInWorkspace.mockRejectedValueOnce(new Error("failed"));
  await openIssue();
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() => expect(cloudStart.startInWorkspace).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((screen.getByRole("button", { name: "Start session" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText("You · in the cloud")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() => expect(cloudStart.startInWorkspace).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId("taken-issue-warning")).toBeNull();
});

it("keeps a successful start across view remounts but clears it on sign-out even with cached cloud data", async () => {
  await openIssue();
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await screen.findByText("You · in the cloud");
  cleanup();
  await openIssue();
  expect(screen.getByText("You · in the cloud")).toBeTruthy();
  cleanup();
  act(() => {
    cloudWorkState.account.status.state = "signed-out";
    cloudWorkState.accountChanged();
  });
  await openIssue();
  expect(screen.queryByText("You · in the cloud")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  expect(screen.queryByTestId("taken-issue-warning")).toBeNull();
});


it("removes an open duplicate warning when its account signs out", async () => {
  const view = render(<IssuesView />);
  fireEvent.click(await row());
  await screen.findByText("Sessions stop at code.");
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await screen.findByText("You · in the cloud");
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await screen.findByTestId("taken-issue-warning");
  act(() => {
    cloudWorkState.account.status.state = "signed-out";
    cloudWorkState.accountChanged();
  });
  view.rerender(<IssuesView />);
  expect(screen.queryByTestId("taken-issue-warning")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open the existing session" })).toBeNull();
});
