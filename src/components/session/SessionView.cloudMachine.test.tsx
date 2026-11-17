import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mouseClick } from "@/test/press";
import type { CloudSessionModel } from "@/lib/cloudSession";
import type { MachineBranchSnapshot, MachinePr, MachineSessionBranch } from "@/lib/machineSessionBranch";
import type { MachineSessionChecks, MachineSessionUsage } from "@/lib/machineSessionAgents";
import type { RemovableWorkspace } from "@/lib/workspaceRemoval";
import type { SessionEntry, TabEntry } from "@/types/session";

// PRO-404, PRO-406, PRO-408: a machine session's header (21.08). Every control
// here calls the machine session's model; this computer's Tauri commands are
// recorded, and none of git, gh, the branch step, usage, continuation or
// workspace removal may be among them.
const mocks = vi.hoisted(() => ({
  invoked: [] as string[],
  panel: { props: null as null | Record<string, unknown>, machine: null as unknown },
  deletes: [] as unknown[][],
  prefs: { panelOpen: true, panelWidth: 360, sidebarOpen: true, lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", tabStrip: false, shortcuts: {} } as Record<string, unknown>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (command: string) => {
    mocks.invoked.push(command);
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined), revealItemInDir: vi.fn() }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => mocks.prefs, getPrefs: () => mocks.prefs, setPrefs: vi.fn(), subscribePrefs: () => () => {} }));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.mock("@/lib/experimentalSettings", () => ({ useExperimentalSettings: () => ({ sessionCost: true, orchestratorRuns: false }) }));
vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-out", identity: null, expiresAt: null, lastError: null, organizations: [] } };
  return { useAccount: () => account, getAccount: () => account, subscribeAccount: () => () => undefined, refreshAccount: vi.fn() };
});
vi.mock("@/lib/models", async (original) => ({ ...(await original<typeof import("@/lib/models")>()), useModels: () => [], loadModels: vi.fn() }));
vi.mock("@/lib/dialogs", async (original) => ({
  ...(await original<typeof import("@/lib/dialogs")>()),
  openWorkspaceDelete: (...args: unknown[]) => void mocks.deletes.push(args),
}));
// The header is what is under test: the tab bodies, panel contents and machine strips have their own tests.
vi.mock("./TabView", () => ({ TabView: ({ tab }: { tab: TabEntry }) => <div data-testid="tab-view">{tab.id}</div> }));
vi.mock("@/components/layout/RightPanel", async () => {
  const { useMachinePanel } = await import("@/components/changes/machinePanel");
  return {
    RightPanel: (props: Record<string, unknown> & { onFixErrors?: (pr: { url: string }) => Promise<unknown> }) => {
      mocks.panel.props = props;
      mocks.panel.machine = useMachinePanel();
      return (
        <aside data-testid="right-panel">
          {props.onFixErrors && <button onClick={() => void props.onFixErrors!({ url: "https://github.com/o/r/pull/12" })}>Fix errors</button>}
        </aside>
      );
    },
  };
});
vi.mock("@/components/machines/MachineSession", () => ({
  MACHINE_LOCAL_ONLY: "Browser and computer use aren't available on another machine.",
  MachineSessionChip: ({ cloud }: { cloud: CloudSessionModel }) => <span data-testid="machine-chip">{cloud.machine?.name}</span>,
  MachineSessionStrips: () => null,
  MachineTerminalDock: () => null,
}));
vi.mock("@/components/editor/QuickOpen", () => ({ QuickOpen: () => null }));
vi.mock("@/components/editor/ProjectSearch", () => ({ ProjectSearch: () => null }));
vi.mock("@/components/cloud/CloudWorkspaceDetails", () => ({ CloudWorkspaceDetails: () => null }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));

const { SessionView } = await import("./SessionView");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { machineHostId } = await import("@/lib/mergedCleanup");

/** Commands of this computer that a machine session's header must never reach. */
const LOCAL_ONLY = /^(branch_step|gh_|git_|session_usage|prepare_continuation|agent_prepare_continuation|workspace_disposition|remove_workspace|workspace_remove|fix_check|check_failures|merged_cleanup)/;

const tab = (patch: Partial<TabEntry> = {}): TabEntry =>
  ({
    id: "t1",
    harness: "claude",
    model: "opus",
    effort: "high",
    permissionMode: "bypassPermissions",
    status: "completed",
    title: "Login",
    created: "2026-11-18T10:00:00Z",
    modified: "2026-11-18T10:00:00Z",
    usage: { models: [{ model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.25 }], updated: "2026-11-18T10:00:00Z" },
    accountLabel: "Work account",
    ...patch,
  }) as TabEntry;

const pr = (patch: Partial<MachinePr> = {}): MachinePr =>
  ({ number: 12, url: "https://github.com/o/r/pull/12", title: "Login", head: "feat/login", base: "main", state: "OPEN", isDraft: false, checks: [], headSha: "abc1234def", ...patch }) as MachinePr;

const snapshotOf = (patch: Partial<MachineBranchSnapshot> = {}): MachineBranchSnapshot => ({
  branch: "feat/login",
  head: "abc1234def",
  base: "main",
  state: "noPr",
  actions: ["createPr"],
  pr: null,
  behindUpstream: false,
  pullNeedsAgent: false,
  ...patch,
});

function branchOf(snapshot: MachineBranchSnapshot | null, patch: Partial<MachineSessionBranch> = {}): MachineSessionBranch {
  return {
    served: true,
    snapshot,
    branchName: "feat/login",
    diff: { additions: 120, deletions: 8 },
    prs: [pr({ number: 9, state: "CLOSED" })],
    prsKnown: true,
    loading: false,
    error: null,
    headPinned: true,
    refresh: vi.fn(async () => snapshot),
    push: vi.fn(async () => null),
    pull: vi.fn(async () => null),
    commitPush: vi.fn(async () => null),
    createPr: vi.fn(async () => "Opened #12"),
    markReady: vi.fn(async () => undefined),
    merge: vi.fn(async () => undefined),
    agentPrompt: vi.fn((action) => (action === "resolveConflicts" ? "Reconcile this branch on the machine." : null)),
    isAgentAction: (action) => action === "resolveConflicts" || action === "fixChecks" || action === "addressReview",
    ...patch,
  };
}

interface Model {
  cloud: CloudSessionModel;
  send: ReturnType<typeof vi.fn>;
  usageRefresh: ReturnType<typeof vi.fn>;
  fix: ReturnType<typeof vi.fn>;
  continueInNewTab: ReturnType<typeof vi.fn>;
}

function machineModel(input: { branch?: MachineSessionBranch; tabs?: TabEntry[]; machine?: boolean; continueBlocked?: string | null; workspace?: RemovableWorkspace | undefined; checksServed?: boolean } = {}): Model {
  const tabs = input.tabs ?? [tab()];
  const send = vi.fn(async () => ({ queued: false }));
  const usageRefresh = vi.fn(async () => null);
  const fix = vi.fn(async () => "Sent failed check logs to the agent on Mac mini.");
  const continueInNewTab = vi.fn(async () => ({ tabId: "t2", queued: false }));
  const onMachine = input.machine ?? true;
  const session: SessionEntry = {
    id: onMachine ? "machine:m1:p1:s1" : "cloud:org-1:ws-1:s1",
    projectPath: onMachine ? "machine:m1:p1" : "cloud:org-1:ws-1",
    cwd: onMachine ? "machine://m1:p1" : "cloud://ws-1",
    branch: "feat/login",
    baseRef: null,
    worktreeName: null,
    worktreeRemoved: false,
    title: "Fix login",
    created: "",
    modified: "",
    archived: false,
    pinned: false,
    tabs,
    activeTab: tabs[0]?.id ?? null,
  } as SessionEntry;
  const usage: MachineSessionUsage = { served: true, read: null, error: null, loading: false, refresh: usageRefresh };
  const checks: MachineSessionChecks = { served: input.checksServed ?? true, failing: null, blocked: null, fix };
  const host = { key: "machine:m1|s1", disposition: vi.fn(), remove: vi.fn(), turnRunning: () => false };
  const workspace: RemovableWorkspace | undefined = "workspace" in input ? input.workspace : { host, projectPath: "machine:m1:p1", path: "/srv/repos/app/.raccoon/worktrees/bright-otter", name: "bright-otter" };
  const backend = {
    caps: { local: false, write: true },
    readOnlyReason: null,
    logSessionId: session.id,
    send,
    terminalView: () => ({ available: false, reason: "Not here" }),
  };
  const cloud = {
    backend,
    session,
    orgId: onMachine ? "" : "org-1",
    workspaceId: "ws-1",
    workspaceKey: onMachine ? "machine:m1" : "cloud:org-1:ws-1",
    root: session.cwd,
    projectName: "app",
    workspaceName: "app",
    location: { provider: onMachine ? "Mac mini" : "AWS", org: onMachine ? "" : "Acme" },
    connection: { label: "Live", tone: "live" },
    connected: true,
    manage: true,
    collab: { key: "k", you: null, live: false, notShared: false },
    locked: null,
    recheckAccess: () => undefined,
    mayControlTerminals: true,
    canWakeForTerminal: false,
    asleep: false,
    terminals: [],
    openTerminal: vi.fn(),
    addAgentTab: vi.fn(),
    canAddTabs: true,
    agents: [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }],
    client: null,
    terminalBase: () => undefined,
    repositories: null,
    repository: null,
    selectRepository: () => undefined,
    gitSource: undefined,
    fileSource: {} as never,
    removableWorkspace: workspace,
    ports: { offered: false, state: { state: "connected" }, connectionId: null },
    error: null,
    ...(onMachine
      ? {
          machine: { machineId: "m1", projectId: "p1", record: {}, name: "Mac mini", state: { state: "direct" } },
          scripts: undefined,
          branch: input.branch ?? branchOf(snapshotOf()),
          usage,
          checks,
          continueInNewTab,
          continueBlocked: input.continueBlocked ?? null,
        }
      : {}),
  } as unknown as CloudSessionModel;
  return { cloud, send, usageRefresh, fix, continueInNewTab };
}

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

async function show(model: Model) {
  const view = render(
    <TooltipProvider>
      <SessionView session={model.cloud.session} cloud={model.cloud} sidebarOpen onToggleSidebar={() => undefined} />
    </TooltipProvider>,
  );
  await flush();
  return view;
}

const header = () => document.querySelector("header")!;
const local = () => mocks.invoked.filter((command) => LOCAL_ONLY.test(command));

beforeEach(() => {
  mocks.invoked = [];
  mocks.deletes = [];
  mocks.panel = { props: null, machine: null };
});
afterEach(() => cleanup());

describe("a machine session's header (21.08, PRO-404)", () => {
  it("shows the branch's diff size, its pull requests and Create PR beside the machine chip, and opens the PR on the machine", async () => {
    const model = machineModel();
    await show(model);
    const bar = within(header());
    expect(bar.getByTestId("machine-chip").textContent).toBe("Mac mini");
    expect(bar.getByTestId("machine-diff-size").textContent).toBe("+120−8");
    expect(bar.getByTestId("machine-pr-count").textContent).toContain("1 PR");
    fireEvent.click(bar.getByRole("button", { name: "Create PR" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("from feat/login into main, through Mac mini's GitHub sign-in");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /PR title/ }), { target: { value: "Fix the login" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create PR" }));
    await waitFor(() => expect(model.cloud.branch!.createPr).toHaveBeenCalledWith({ title: "Fix the login", body: "", draft: false }));
    expect(await bar.findByText("Opened #12")).toBeTruthy();
    expect(local()).toEqual([]);
  });

  it("merges through the machine with the method chosen and the snapshot that was shown", async () => {
    const ready = snapshotOf({ state: "ready", actions: ["merge"], pr: pr() });
    const model = machineModel({ branch: branchOf(ready) });
    await show(model);
    fireEvent.click(within(header()).getByRole("button", { name: "Merge" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("GitHub refuses it if the head moved from abc1234");
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Merge method" }), { target: { value: "squash" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(model.cloud.branch!.merge).toHaveBeenCalledWith("squash", ready));
    expect(local()).toEqual([]);
  });

  it("sends an agent step to the open tab on the machine, and Fix checks saves the failed logs there first", async () => {
    const conflicts = machineModel({ branch: branchOf(snapshotOf({ state: "conflicts", actions: ["resolveConflicts"] })) });
    const first = await show(conflicts);
    fireEvent.click(within(header()).getByRole("button", { name: "Resolve conflicts" }));
    await waitFor(() => expect(conflicts.send).toHaveBeenCalledWith("t1", "Reconcile this branch on the machine.", []));
    first.unmount();

    const failing = machineModel({ branch: branchOf(snapshotOf({ state: "checksFailing", actions: ["fixChecks"], pr: pr() })) });
    await show(failing);
    fireEvent.click(within(header()).getByRole("button", { name: "Fix checks" }));
    await waitFor(() => expect(failing.fix).toHaveBeenCalledWith("t1", "https://github.com/o/r/pull/12"));
    expect(failing.send).not.toHaveBeenCalled();
    expect((await screen.findByTestId("machine-check-fix")).textContent).toContain("Sent failed check logs to the agent on Mac mini.");
    expect(local()).toEqual([]);
  });

  it("offers nothing to press to a computer that may not manage the machine", async () => {
    const model = machineModel();
    (model.cloud as { manage: boolean }).manage = false;
    await show(model);
    expect((within(header()).getByRole("button", { name: "Create PR" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("a machine session's side panel (PRO-406, PRO-408)", () => {
  it("names the machine, its worktree and the merge pin to the PR panel, and Fix errors there runs on the machine", async () => {
    const model = machineModel();
    await show(model);
    expect(mocks.panel.machine).toMatchObject({ machineId: "m1", name: "Mac mini", headPinned: true, workspace: { name: "bright-otter" } });
    fireEvent.click(screen.getByRole("button", { name: "Fix errors" }));
    await waitFor(() => expect(model.fix).toHaveBeenCalledWith("t1", "https://github.com/o/r/pull/12"));
    expect(machineHostId("m1")).not.toBe("local");
    expect(local()).toEqual([]);
  });

  it("removes the worktree from the header's menu through the machine's host, never this computer's", async () => {
    const model = machineModel();
    await show(model);
    mouseClick(within(header()).getByTestId("machine-workspace-menu"));
    const item = await screen.findByRole("menuitem", { name: /Remove worktree on Mac mini/ });
    mouseClick(item);
    await waitFor(() => expect(mocks.deletes).toHaveLength(1));
    const [projectPath, path, name, host] = mocks.deletes[0];
    expect([projectPath, path, name]).toEqual(["machine:m1:p1", "/srv/repos/app/.raccoon/worktrees/bright-otter", "bright-otter"]);
    expect(host).toBe(model.cloud.removableWorkspace!.host);
    expect(local()).toEqual([]);
  });

  it("offers no removal for a session in the project's own folder", async () => {
    await show(machineModel({ workspace: undefined }));
    mouseClick(within(header()).getByTestId("machine-workspace-menu"));
    await screen.findByRole("menuitem", { name: /Copy branch name/ });
    expect(screen.queryByRole("menuitem", { name: /Remove worktree/ })).toBeNull();
  });
});

describe("a machine session's cost, account and Continue (PRO-408)", () => {
  it("shows the cost from the machine's session list and reads it again on the machine when opened", async () => {
    const model = machineModel();
    await show(model);
    const chip = within(header()).getByTestId("session-cost");
    expect(chip.textContent).toContain("$1.25");
    mouseClick(chip);
    await waitFor(() => expect(model.usageRefresh).toHaveBeenCalled());
    expect(local()).toEqual([]);
  });

  it("names the account the machine says the tab runs on, and nothing when its agent has one account there", async () => {
    const first = await show(machineModel());
    expect(within(header()).getByTestId("tab-account-label").textContent).toBe("Work account");
    first.unmount();
    await show(machineModel({ tabs: [tab({ accountLabel: null })] }));
    expect(within(header()).queryByTestId("tab-account-label")).toBeNull();
  });

  it("continues the open tab in a new tab of the session on the machine", async () => {
    const model = machineModel();
    await show(model);
    fireEvent.click(within(header()).getByRole("button", { name: "Continue in a New Tab…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Opens a new agent tab in this session on Mac mini");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Full transcript" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue in New Tab" }));
    await waitFor(() =>
      expect(model.continueInNewTab).toHaveBeenCalledWith({ sourceTabId: "t1", agent: "claude", model: "opus", effort: "high", mode: "bypassPermissions", context: "full" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(local()).toEqual([]);
  });

  it("says why Continue cannot be used while the machine is away", async () => {
    await show(machineModel({ continueBlocked: "Can't send until Mac mini is back" }));
    const button = within(header()).getByRole("button", { name: "Continue in a New Tab…" });
    fireEvent.click(button);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a cloud workspace session", () => {
  it("renders as before: none of the machine's header controls, and no machine context in its panel", async () => {
    await show(machineModel({ machine: false }));
    const bar = within(header());
    expect(bar.getByTestId("session-title").textContent).toBe("Fix login");
    expect(bar.getByTestId("session-branch").textContent).toContain("feat/login");
    expect(bar.queryByTestId("machine-diff-size")).toBeNull();
    expect(bar.queryByTestId("machine-pr-count")).toBeNull();
    expect(bar.queryByTestId("machine-branch-button")).toBeNull();
    expect(bar.queryByTestId("machine-workspace-menu")).toBeNull();
    expect(bar.queryByTestId("session-cost")).toBeNull();
    expect(bar.queryByTestId("tab-account-label")).toBeNull();
    expect(bar.queryByRole("button", { name: /Continue in/ })).toBeNull();
    expect(mocks.panel.machine).toBeNull();
    expect(mocks.panel.props?.onFixErrors).toBeUndefined();
  });
});
