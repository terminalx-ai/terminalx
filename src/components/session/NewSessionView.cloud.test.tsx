import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { FakeAgentRuntime } from "@/test/fakeAgentRuntime";
import type { HarnessInfo, Project } from "@/types/session";
import type { CloudProviderSummary } from "@/lib/api";
import { ProvidersPaused } from "@/lib/hiddenProviders";
import type { CloudProject } from "@/types/target";
import { accessibilityPress, mouseClick } from "@/test/press";

// PRO-61 (CS-13 subset): the project row's `+` opens the same new-session
// form, preset with "Runs in: <Org> cloud". Start reuses or wakes a
// workspace, or creates one at once: Create is the confirmation (PRO-409).
// No local path command runs for a cloud draft.

const { invoke, flow, draft, mayStart, noLocal, modelConnection, catalog, launchAccount, here, privacyMode } = vi.hoisted(() => ({
  invoke: vi.fn(),
  privacyMode: { ready: true, enabled: false, managed: false },
  launchAccount: { value: null as import("@/lib/api").AccountStatus | null },
  /** What the form reads as the cloud catalog: the new workspace's start is followed there. */
  catalog: { value: { orgs: {} } as unknown },
  modelConnection: { client: null as import("@terminalx/portable/workspace").WorkspaceRpcClient | null, targets: vi.fn() },
  flow: {
    planCloudStart: vi.fn(),
    startInWorkspace: vi.fn(),
    prepareCloudCreate: vi.fn(),
    confirmCloudCreate: vi.fn(),
    cloudIdleOptions: vi.fn(),
    cloudPlacementOffers: vi.fn(),
    checkCloudPlacement: vi.fn(),
    quoteCloudPlacement: vi.fn(),
  },
  here: vi.fn(),
  draft: { value: null as { project: CloudProject | null; orgName: string; mayStart: boolean | null } | null },
  /** Whether this account may start cloud sessions in the organization (an owner or admin). */
  mayStart: { value: true as boolean | null },
  /** This computer has no local projects (a member who only uses the organization's cloud projects). */
  noLocal: { value: false },
}));

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => vi.fn()) }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonScene: () => null }));
vi.mock("@/components/chat/Dictation", () => ({
  DictationStatus: () => null,
  MicButton: () => null,
  NEW_SESSION_TARGET: "new-session",
  useDictationInto: () => ({ dictating: false, toggle: vi.fn() }),
  useDictationShortcuts: vi.fn(),
}));
vi.mock("@/lib/dictation", () => ({ stopDictation: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn(), useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "bypassPermissions", label: "Bypass", hint: "" }],
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => [
    { id: "opus", label: "Opus", harness: "claude", efforts: [], defaultEffort: null, isDefault: true, alias: true, resolved: "claude-opus-5-5" },
    { id: "claude-opus-5", label: "Opus 5", harness: "claude", efforts: [], defaultEffort: null, isDefault: false },
  ],
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({ useWorktree: true, lastAgent: "claude", lastModel: { claude: "claude-opus-5" }, lastEffort: {}, lastMode: "bypassPermissions", lastProject: null }),
  getPrefs: () => ({ cloudIssuePipelines: {} }),
  setPrefs: vi.fn(),
  subscribePrefs: () => () => {},
}));
const local = { path: "/repos/raccoon", name: "raccoon" } as Project;
// Claude is not installed on this computer; it is on the cloud workspace.
const harness = { id: "claude", name: "Claude", available: false, installHint: "" } as HarnessInfo;
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ projects: noLocal.value ? [] : [local], harnesses: [harness], selectedProject: local.path, workspaces: {}, newSessionPreset: null, cloudSessionPreset: { projectKey: "cloud:org-a:github.com/acme/api" } }),
  addProject: vi.fn(),
  clearNewSessionPreset: vi.fn(),
  selectProject: vi.fn(),
  selectProjectInSidebar: vi.fn(),
  selectSession: vi.fn(),
  upsertSession: vi.fn(),
  startCloudSessionIn: vi.fn(),
  runNewSessionHere: here,
}));
vi.mock("./CloudNewSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./CloudNewSession")>()),
  useCloudDraft: () => draft.value,
  useCloudProjectChoices: () => [{ orgId: "org-a", orgName: "Acme", mayStart: mayStart.value, projects: [project, { ...project, key: "cloud:org-a:blank/scratch", identity: "blank/scratch", fullName: "scratch", blank: true }] }],
}));
vi.mock("@/lib/dataPrivacy", async (original) => ({
  ...(await original<typeof import("@/lib/dataPrivacy")>()),
  useDataPrivacy: () => ({ ...privacyMode }),
}));
vi.mock("@/lib/cloudNewSession", async (original) => ({ ...(await original<typeof import("@/lib/cloudNewSession")>()), ...flow }));
vi.mock("@/lib/account", async (original) => {
  const account = await original<typeof import("@/lib/account")>();
  return {
    ...account,
    getAccount: () => ({ ...account.getAccount(), status: launchAccount.value ?? account.getAccount().status }),
    useAccount: () => {
      const current = account.useAccount();
      return { ...current, status: launchAccount.value ?? current.status };
    },
  };
});
vi.mock("@/lib/cloudCatalog", async (original) => ({
  ...(await original<typeof import("@/lib/cloudCatalog")>()),
  useCloudCatalog: () => catalog.value,
}));
vi.mock("@/lib/cloudModels", async (original) => ({
  ...(await original<typeof import("@/lib/cloudModels")>()),
  useCloudModelClient: (target: unknown) => {
    modelConnection.targets(target);
    return target ? modelConnection.client : null;
  },
}));
vi.mock("@/components/cloud/RunningLimitNotice", () => ({
  RunningLimitNotice: ({ orgId }: { orgId: string }) => <div data-testid="running-limit-notice">{orgId}</div>,
}));

const { NewSessionView } = await import("./NewSessionView");

const node = { key: "cloud:org-a:ws-1", item: { workspace: { id: "ws-1", orgId: "org-a", name: "fix-login", state: "suspended" } }, placedBy: "server" };
const project: CloudProject = { key: "cloud:org-a:github.com/acme/api", orgId: "org-a", identity: "github.com/acme/api", fullName: "acme/api", selected: true, pinned: false, blank: false, workspaces: [] };

const prepared = {
  orgId: "org-a",
  project,
  quota: { used: 1, limit: 2 },
  providerLabel: "Box",
  quote: {
    id: "q",
    currency: "USD",
    pricing: "provider-rate",
    activeHourlyMicros: 120_000,
    estimatedSuspendedMonthlyMicros: null,
    configuration: { machineClassLabel: "Small", vcpu: 2, memoryMiB: 4096, locationLabel: "Frankfurt", idleSuspendMinutes: 30 },
  },
};

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (command: string) => {
    throw new Error(`no local command for a cloud draft: ${command}`);
  });
  for (const fn of Object.values(flow)) fn.mockReset();
  // The organization's "Stop when idle" windows for a new workspace (PRO-410): the provider's default is 30 minutes.
  flow.cloudIdleOptions.mockResolvedValue({ choices: [15, 30, 60, 0], defaultMinutes: 30, cap: null });
  modelConnection.client = null;
  modelConnection.targets.mockClear();
  mayStart.value = true;
  noLocal.value = false;
  catalog.value = { orgs: {} };
  launchAccount.value = null;
  Object.assign(privacyMode, { ready: true, enabled: false });
  here.mockReset().mockImplementation(() => { draft.value = null; });
  draft.value = { project, orgName: "Acme", mayStart: true };
});

afterEach(() => cleanup());

const type = (text: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });

describe("new session in a cloud project", () => {
  it("says where it runs, keeps the worktree toggle on from the local preference, and reads only local transcription preferences", () => {
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    expect(screen.getByTestId("cloud-runs-in").textContent?.trim()).toBe("Acme cloud");
    expect(screen.getByText("acme/api", { selector: "span" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    expect(screen.getByRole("switch", { name: "New worktree on the cloud workspace" }).getAttribute("aria-checked")).toBe("true");
    // An agent not installed here still runs there.
    expect(screen.queryByText(/isn't installed/)).toBeNull();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["transcription_personalization_load"]);
    expect(flow.cloudPlacementOffers).not.toHaveBeenCalled();
    expect(flow.checkCloudPlacement).not.toHaveBeenCalled();
  });

  it("starts in an existing workspace (a wake for a stopped one) with the prompt and the worktree preference", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "wake", node });
    flow.startInWorkspace.mockResolvedValue("cloud:org-a:ws-1:s1");
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Fix the login redirect");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(flow.startInWorkspace).toHaveBeenCalledTimes(1));
    // The reader last pinned Opus 5 for local work. The workspace's CLI may not have it, so the alias goes instead,
    // and the button claims no version for it.
    expect(screen.getByRole("button", { name: "Opus" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Permissions: Bypass" })).toBeTruthy();
    expect(flow.startInWorkspace).toHaveBeenCalledWith({ kind: "wake", node }, { agent: "claude", model: "opus", effort: null, mode: "bypassPermissions", prompt: "Fix the login redirect", useWorktree: true });
    expect(flow.prepareCloudCreate).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["transcription_personalization_load"]);
  });

  it("uses the existing workspace's versions, and falls back to aliases when it stops", async () => {
    const runtime = new FakeAgentRuntime();
    const base = { efforts: [], defaultEffort: null, acceptsImages: true, upgrade: null, description: null };
    runtime.agents[0].models = [
      { ...base, id: "opus", label: "Opus", alias: true, resolved: "claude-opus-4-6", isDefault: true },
      { ...base, id: "claude-opus-4-6", label: "Opus 4.6", isDefault: false },
    ];
    const client = new WorkspaceRpcClient(runtime);
    runtime.connect();
    modelConnection.client = client;
    flow.planCloudStart.mockReturnValue({ kind: "reuse", node: { ...node, item: { workspace: { ...node.item.workspace, state: "ready" } } } });
    flow.startInWorkspace.mockResolvedValue("cloud:org-a:ws-1:s1");
    const view = render(<NewSessionView />);
    const button = await screen.findByRole("button", { name: "Opus 4.6" });
    expect(modelConnection.targets).toHaveBeenLastCalledWith({ orgId: "org-a", workspaceId: "ws-1" });
    mouseClick(button);
    const top = await screen.findByRole("menu");
    // The models are one level in.
    fireEvent.keyDown(within(top).getByRole("menuitem", { name: /^Model/ }), { key: "ArrowRight" });
    const menu = (await screen.findAllByRole("menu")).at(-1)!;
    expect(within(menu).getByRole("menuitemradio", { name: "Opus 4.6" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitemradio", { name: "Opus 5" })).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.keyDown(top, { key: "Escape" });
    act(() => runtime.emit({ state: "suspended" }));
    flow.planCloudStart.mockReturnValue({ kind: "wake", node });
    view.rerender(<NewSessionView />);
    expect(modelConnection.targets).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "Opus" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Permissions: Bypass" })).toBeTruthy();
  });

  /** The catalog with the workspace Create just made, at this point of its start. */
  const listed = (launch: Record<string, unknown>) => ({ orgs: { "org-a": { workspaces: [{ workspace: { id: "ws-new", orgId: "org-a", name: "Start the API", state: "provisioning", launch } }] } } });
  // A new element each time: React skips a rerender handed the same one, and the catalog would not be read again.
  const form = () => <NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />;

  it("creates the workspace on Create, with no second confirmation, and stays busy until its session opens (PRO-409)", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    flow.prepareCloudCreate.mockResolvedValue(prepared);
    flow.confirmCloudCreate.mockResolvedValue({ workspace: { id: "ws-new" } });
    const view = render(form());
    type("Start the API");
    // "Stop when idle" is offered once the organization's windows are read.
    await screen.findByTestId("cloud-idle-line");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(flow.confirmCloudCreate).toHaveBeenCalledWith(prepared));
    expect(flow.confirmCloudCreate).toHaveBeenCalledTimes(1);
    // The new workspace stops itself after the provider's default idle window unless another is chosen (PRO-410).
    expect(flow.prepareCloudCreate.mock.calls[0][1]).toMatchObject({ idleSuspendMinutes: 30 });
    expect(screen.queryByTestId("cloud-create-confirm")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create workspace and start" })).toBeNull();
    await waitFor(() => expect(screen.getByTestId("cloud-start-status").textContent).toContain("Starting the workspace"));
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);

    // Where the start is comes from the catalog.
    catalog.value = listed({ phase: "syncing-repository" });
    view.rerender(form());
    await waitFor(() => expect(screen.getByTestId("cloud-start-status").textContent).toContain("syncing repository"));

    // Its first session is there: the wait is over (the session is opened by `followLaunch`).
    catalog.value = listed({ phase: "running", sessionId: "s-1" });
    view.rerender(form());
    await waitFor(() => expect(screen.queryByTestId("cloud-start-status")).toBeNull());
  });

  it("shows gated launch progress immediately after Create, before a runtime session ID exists", async () => {
    launchAccount.value = {
      state: "signed-in", identity: { email: "creator@example.test", name: "Creator", organization: "Acme", organizationId: "org-a" },
      context: { account: "account", scope: "org-a", revision: "1" }, expiresAt: null, lastError: null,
      organizations: [{ id: "org-a", name: "Acme", role: "owner", isPersonal: false, cloud: { enabled: true, flags: {} } }],
      phase2Readiness: { "org-a": ["cloud.workspaces.start-progress.v1"] },
    };
    try {
      flow.planCloudStart.mockReturnValue({ kind: "create" });
      flow.prepareCloudCreate.mockResolvedValue(prepared);
      flow.confirmCloudCreate.mockResolvedValue({ workspace: { id: "ws-new" } });
      const view = render(form());
      type("Start the API");
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      await waitFor(() => expect(flow.confirmCloudCreate).toHaveBeenCalledTimes(1));
      catalog.value = {
        owner: "creator@example.test",
        orgs: { "org-a": { source: "live", workspaces: [{ workspace: {
          id: "ws-new", orgId: "org-a", provider: "local-docker", name: "Start the API", state: "provisioning",
          launch: { launchId: "launch-one", phase: "booting", hasPrompt: true },
        } }] } },
      };
      view.rerender(form());
      expect(await screen.findByText("Start the machine")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    } finally {
      launchAccount.value = null;
    }
  });

  it("releases Create and says why when the new workspace's start fails", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    flow.prepareCloudCreate.mockResolvedValue(prepared);
    flow.confirmCloudCreate.mockResolvedValue({ workspace: { id: "ws-new" } });
    const view = render(form());
    type("Start the API");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("cloud-start-status").textContent).toContain("Starting the workspace"));
    catalog.value = listed({ phase: "failed", state: "failed", category: "payload-invalid" });
    view.rerender(form());
    expect(await screen.findByText(/The launch settings were not accepted by the workspace\./)).toBeTruthy();
    expect(screen.queryByTestId("cloud-start-status")).toBeNull();
  });

  it("resends the same create after an unknown outcome, so Create again cannot make a second workspace", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    // The prepared create carries the request it was made from, as the real one does.
    flow.prepareCloudCreate.mockImplementation(async (_project: unknown, request: { prompt: string; agent: string; model: string; effort: string | null; mode: string; idleSuspendMinutes?: number }) => ({
      ...prepared,
      form: { prompt: request.prompt, agent: request.agent, model: request.model, effort: request.effort ?? "", mode: request.mode, idleSuspendMinutes: request.idleSuspendMinutes },
    }));
    flow.confirmCloudCreate.mockRejectedValueOnce({ code: "cloud_workspace_request_timeout", status: 0, retryWithSameIdempotencyKey: true }).mockResolvedValue({ workspace: { id: "ws-new" } });
    render(form());
    type("Start the API");
    await screen.findByTestId("cloud-idle-line");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(flow.confirmCloudCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(flow.confirmCloudCreate).toHaveBeenCalledTimes(2));
    // Prepared once: the second press sent the first request again, key and all.
    expect(flow.prepareCloudCreate).toHaveBeenCalledTimes(1);
    expect(flow.confirmCloudCreate.mock.calls[1][0]).toBe(flow.confirmCloudCreate.mock.calls[0][0]);
  });

  it("at the limit, says so and creates nothing", async () => {
    const { CreateRefused } = await import("@/lib/cloudCreate");
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    flow.prepareCloudCreate.mockRejectedValue(new CreateRefused("cloud_workspace_quota_exceeded"));
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("One more");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/at its cloud workspace limit/)).toBeTruthy();
    expect(flow.confirmCloudCreate).not.toHaveBeenCalled();
  });
});

describe("a start refused for lack of role (a demoted admin with the form still open)", () => {
  it.each([
    // The runtime's refusal of a session this connection may no longer start, an Error from the RPC client, and the server's own code.
    ["the runtime's forbidden", () => Object.assign(new Error("forbidden"), { code: "forbidden" }), "wake"],
    ["the server's organization_admin_required", () => ({ code: "organization_admin_required", status: 403 }), "create"],
  ] as const)("says who may and that the role changed, never the bare code, and reads the roles again (%s)", async (_name, refusal, kind) => {
    const roles = await import("@/lib/accountRoles");
    const refresh = vi.fn(async () => undefined);
    roles.registerAccountRoles({ refresh, listed: vi.fn() });
    if (kind === "wake") {
      flow.planCloudStart.mockReturnValue({ kind: "wake", node });
      flow.startInWorkspace.mockRejectedValue(refusal());
    } else {
      flow.planCloudStart.mockReturnValue({ kind: "create" });
      flow.prepareCloudCreate.mockRejectedValue(refusal());
    }
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("echo:erin after demotion");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Only an organization owner or admin can start a new cloud session (your role changed).")).toBeTruthy();
    expect(screen.queryByText(/forbidden|could not be created|organization_admin_required/)).toBeNull();
    expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    roles.registerAccountRoles(null);
  });

  it("asks nothing of the account for any other refusal", async () => {
    const roles = await import("@/lib/accountRoles");
    const refresh = vi.fn(async () => undefined);
    roles.registerAccountRoles({ refresh, listed: vi.fn() });
    flow.planCloudStart.mockReturnValue({ kind: "wake", node });
    flow.startInWorkspace.mockRejectedValue({ code: "cloud_workspace_unreachable" });
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Fix the login redirect");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("The cloud workspace did not come up in time. Try again.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    roles.registerAccountRoles(null);
  });
});

describe("a start the workspace's runtime refused", () => {
  it("shows the runtime's reason, never a create failure", async () => {
    const { WorkspaceRpcError } = await import("@terminalx/portable/workspace");
    flow.planCloudStart.mockReturnValue({ kind: "wake", node });
    flow.startInWorkspace.mockRejectedValue(new WorkspaceRpcError("unavailable", "Claude Code is not installed in this workspace", "session.create"));
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Fix the login redirect");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Claude Code is not installed in this workspace")).toBeTruthy();
    expect(screen.queryByText(/could not be created|unavailable/)).toBeNull();
  });

  it.each([
    ["empty", "   "],
    ["not a string", { text: "no" } as unknown as string],
  ])("falls back to the code's wording when the runtime's message is %s", async (_name, message) => {
    const { WorkspaceRpcError } = await import("@terminalx/portable/workspace");
    const refusal = new WorkspaceRpcError("unavailable", "", "session.create");
    Object.defineProperty(refusal, "message", { value: message });
    flow.planCloudStart.mockReturnValue({ kind: "wake", node });
    flow.startInWorkspace.mockRejectedValue(refusal);
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Fix the login redirect");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("The workspace could not be created (unavailable).")).toBeTruthy();
  });

  it("keeps a long runtime message to 300 characters", async () => {
    const { WorkspaceRpcError } = await import("@terminalx/portable/workspace");
    flow.planCloudStart.mockReturnValue({ kind: "wake", node });
    flow.startInWorkspace.mockRejectedValue(new WorkspaceRpcError("unavailable", ` ${"x".repeat(400)} `, "session.create"));
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Fix the login redirect");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("x".repeat(300))).toBeTruthy();
  });
});

describe("the running limit (saas PRO-76)", () => {
  it("explains a resume refused at the running limit and offers to stop a running workspace", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "wake", node });
    flow.startInWorkspace.mockRejectedValue({ code: "cloud_workspace_concurrency_exceeded", status: 409 });
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Fix the login redirect");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/running as many cloud workspaces as its limit allows\. Stop one to start another\./)).toBeTruthy();
    expect(screen.getByTestId("running-limit-notice").textContent).toBe("org-a");
    expect(screen.queryByText(/outcome|may have created/i)).toBeNull();
  });

  it("explains a create refused at the running limit as a definite refusal", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    flow.prepareCloudCreate.mockResolvedValue(prepared);
    flow.confirmCloudCreate.mockRejectedValue({ code: "cloud_workspace_concurrency_exceeded", status: 409, retryWithSameIdempotencyKey: false });
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("One more");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/Stop one to start another\./)).toBeTruthy();
    expect(screen.getByTestId("running-limit-notice")).toBeTruthy();
  });

  it("offers nothing to stop for other refusals", async () => {
    const { CreateRefused } = await import("@/lib/cloudCreate");
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    flow.prepareCloudCreate.mockRejectedValue(new CreateRefused("cloud_provisioning_paused"));
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("One more");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/paused new cloud workspaces/)).toBeTruthy();
    expect(screen.queryByTestId("running-limit-notice")).toBeNull();
  });
});

describe("keyboard", () => {
  it("Return in the composer starts it, as it does locally", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "reuse", node });
    flow.startInWorkspace.mockResolvedValue("cloud:org-a:ws-1:s1");
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Fix the login redirect");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(flow.startInWorkspace).toHaveBeenCalledTimes(1));
    // Shift+Return is a new line.
    type("Line one");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
    expect(flow.startInWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("the project picker", () => {
  it("opens on a plain click (as an accessibility press sends) and lists Local, then the organization's cloud projects", async () => {
    const sessions = await import("@/lib/sessions");
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    // A press through the accessibility tree is a click with no pointerdown.
    fireEvent.click(screen.getByRole("button", { name: /acme\/api/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Local")).toBeTruthy();
    expect(within(menu).getByText("Acme cloud")).toBeTruthy();
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual(["raccoon", "acme/api", "scratchno repo", "Add a project…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /scratch/ }));
    expect(sessions.startCloudSessionIn).toHaveBeenCalledWith("cloud:org-a:blank/scratch");
  });
});

describe("the project picker with no local projects", () => {
  it("shows no Local heading over nothing, and starts with the organization's group (no rule above it)", async () => {
    noLocal.value = true;
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /acme\/api/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Local")).toBeNull();
    expect(within(menu).queryByText("Projects")).toBeNull();
    expect(within(menu).getByText("Acme cloud")).toBeTruthy();
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual(["acme/api", "scratchno repo", "Add a project…"]);
    // The first thing in the menu is the cloud group's heading, not a separator under an empty section.
    const group = within(menu).getByRole("group", { name: "Acme cloud projects" });
    expect(menu.firstElementChild).toBe(group);
    expect(group.firstElementChild?.textContent).toBe("Acme cloud");
    // One rule is left: the one above "Add a project…".
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  });
});

describe("a member, who may not start cloud sessions", () => {
  it("lists the organization's cloud projects in the picker but offers none, with the reason", async () => {
    const sessions = await import("@/lib/sessions");
    vi.mocked(sessions.startCloudSessionIn).mockClear();
    mayStart.value = false;
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /acme\/api/ }));
    const menu = await screen.findByRole("menu");
    const reason = within(menu).getByTestId("cloud-start-locked");
    expect(reason.textContent).toBe("Only an organization owner or admin can start a new cloud session.");
    // Helper text in sentence case, not a section header (those are upper case).
    expect(reason.getAttribute("role")).toBe("note");
    expect(reason.className).not.toMatch(/\buppercase\b|tracking-wide/);
    for (const name of [/acme\/api/, /scratch/]) {
      const entry = within(menu).getByRole("menuitem", { name });
      expect(entry.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(entry);
    }
    expect(sessions.startCloudSessionIn).not.toHaveBeenCalled();
    // The local project stays offered.
    expect(within(menu).getByRole("menuitem", { name: "raccoon" }).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("offers nothing while the account's role in the organization is not known yet", async () => {
    mayStart.value = null;
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /acme\/api/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /acme\/api/ }).getAttribute("aria-disabled")).toBe("true");
    // Not known is not refused: no reason is claimed yet.
    expect(within(menu).queryByTestId("cloud-start-locked")).toBeNull();
  });

  it("keeps Start off, with the reason, if the form is already open for a cloud project", () => {
    draft.value = { project, orgName: "Acme", mayStart: false };
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("fix the login bug");
    expect(screen.getByTestId("cloud-start-locked").textContent).toBe("Only an organization owner or admin can start a new cloud session");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(flow.planCloudStart).not.toHaveBeenCalled();
    expect(flow.prepareCloudCreate).not.toHaveBeenCalled();
  });
});

describe("the composer's pickers", () => {
  // hidden: an open modal menu hides the rest of the page from the accessibility tree.
  const picker = (name: RegExp) => screen.getByRole("button", { name, hidden: true });

  it("project, and agent with model and permissions, each open on a real mouse click, and a second click closes it", async () => {
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    for (const [name, label] of [[/acme\/api/, "Acme cloud"], [/^Opus/, "Agent"], [/^Opus/, "Model"], [/^Permissions/, "Permissions"]] as const) {
      mouseClick(picker(name));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByText(label)).toBeTruthy();
      expect(picker(name).getAttribute("aria-expanded")).toBe("true");
      mouseClick(picker(name));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
  });

  it("each opens on an accessibility press (a click with no pointerdown)", async () => {
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    for (const name of [/acme\/api/, /^Opus/]) {
      accessibilityPress(picker(name));
      await screen.findByRole("menu");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
  });
});

describe("ready organization session placement", () => {
  const defaults = { machineClassId: "small", locationId: "eu", idleSuspendMinutes: 30 };
  function placementOffer(id: string, label: string) {
    return { id, label, error: null, setup: { provider: id, defaults, allowedIdleSuspendMinutes: [30, 60], currency: "USD", pricing: "estimate",
      machineClasses: [{ id: "small", label: "Small", vcpu: 2, memoryMiB: 4096, activeHourlyMicros: 120_000 }],
      locations: [{ id: "eu", label: "Frankfurt" }],
    } };
  }
  beforeEach(() => {
    launchAccount.value = { state: "signed-in", identity: null, expiresAt: null, lastError: null, phase2Readiness: { "org-a": ["cloud.workspaces.session-placement.v1"] } };
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    flow.cloudPlacementOffers.mockResolvedValue([
      placementOffer("box", "Box"),
      placementOffer("boat", "Boat"),
      { id: "paused", label: "Paused", setup: null, error: new Error("New machines are paused.") },
    ]);
    flow.checkCloudPlacement.mockResolvedValue(undefined);
    flow.quoteCloudPlacement.mockImplementation(async (_orgId, setup) => ({ ...prepared.quote, provider: setup.provider, expiresAt: Date.now() + 30_000 }));
  });

  it.each([null, 3])("shows the caller's usage and cap %s as an advisory snapshot", async (limit) => {
    launchAccount.value!.phase2Readiness = { "org-a": ["cloud.workspaces.precreate-usage.v1"] };
    const fallback = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === "cloud_workspace_precreate_usage"
      ? Promise.resolve({ callerOwnedRunning: 2, callerOwnedRunningLimit: limit, quota: { used: 5, running: { used: 5, limit: 8 } } })
      : fallback(command, args));
    render(<NewSessionView />);
    const usage = await screen.findByTestId("cloud-placement-usage");
    expect(usage.textContent).toContain("At last check, you held 2 of 5 organization running slots.");
    expect(usage.textContent).toContain(limit === null ? "No per-member running limit." : "Per-member running limit: 3.");
    expect(usage.textContent).toContain("Organization running limit: 8. Create checks capacity again.");
    expect(invoke.mock.calls.filter(([command]) => command === "cloud_workspace_precreate_usage"))
      .toEqual([["cloud_workspace_precreate_usage", { orgId: "org-a" }]]);
  });

  it("offers providers and keeps the chosen machine and visibility through prompt edits until Create", async () => {
    catalog.value = { viewerUserId: "me", orgs: { "org-a": { source: "live", quota: { running: { used: 2, limit: 3 } },
      workspaces: [{ workspace: { id: "mine", state: "ready", createdBy: "me" } }],
    } } };
    flow.prepareCloudCreate.mockResolvedValue(prepared);
    flow.confirmCloudCreate.mockResolvedValue({ workspace: { id: "ws-new" } });
    render(<NewSessionView />);
    await screen.findByText(/Cloud preflight checked for Claude in Acme/);
    expect(screen.getByTestId("cloud-placement-machine").textContent).toMatch(/Small.*\$0.12 an hour/);

    await accessibilityPress(screen.getByRole("button", { name: "Where it runs: Acme · Box" }));
    expect(screen.getByTestId("where-this-mac")).toBeTruthy();
    const boat = screen.getByTestId("where-cloud-org-a-boat");
    expect(boat.textContent).toMatch(/Small.*2 vCPU.*4 GB.*Frankfurt.*About \$0.12 an hour/);
    expect(screen.getByTestId("where-cloud-org-a-paused").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("New machines are paused.")).toBeTruthy();
    expect(screen.queryByTestId("cloud-placement-usage")).toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === "cloud_workspace_precreate_usage")).toBe(false);
    fireEvent.click(boat);

    await screen.findByRole("button", { name: "Where it runs: Acme · Boat" });
    await accessibilityPress(screen.getByRole("button", { name: "Visible to Only me" }));
    expect(screen.getByText("Who can open this session")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Everyone at Acme" }));
    expect(screen.getByRole("button", { name: "Visible to Acme" })).toBeTruthy();

    type("A draft");
    type("Start the API");
    expect(flow.prepareCloudCreate).not.toHaveBeenCalled();
    expect(flow.confirmCloudCreate).not.toHaveBeenCalled();
    const create = screen.getByRole("button", { name: "Create in cloud" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(flow.prepareCloudCreate).toHaveBeenCalledWith(project, expect.objectContaining({ prompt: "Start the API" }), {
      accessMode: "organization", defaultIdleSuspendMinutes: 30, quote: expect.objectContaining({ provider: "boat" }),
    }));
    expect(flow.confirmCloudCreate).toHaveBeenCalledTimes(1);
  });

  it("lets an admin allow new machines before Create and refreshes placement without starting anything", async () => {
    const paused: CloudProviderSummary = {
      id: "box", displayName: "Box", availability: "disabled-for-create", canManage: true,
      connection: null, descriptor: null,
      capabilities: { suspend: true, resume: true, releaseDisposition: "destroyed", locationSelection: "required", sourceSelection: "none", pricing: "estimate" },
    };
    launchAccount.value = { ...launchAccount.value!, context: { account: "account", scope: "org-a", revision: "scope:1" } };
    flow.cloudPlacementOffers.mockReset().mockResolvedValueOnce([
      { id: paused.id, label: paused.displayName, setup: null, error: new ProvidersPaused([paused]) },
    ]).mockResolvedValue([placementOffer("box", "Box")]);
    const allowed = { ...paused, availability: "available" };
    invoke.mockImplementation(async (command: string) => {
      if (command === "cloud_provider_set_creation_enabled") return allowed;
      if (command === "cloud_providers") return { providers: [allowed] };
      throw new Error(command);
    });
    render(<NewSessionView />);
    type("Start when machines are allowed");
    const allow = await screen.findByRole("button", { name: "Allow new machines" });
    const create = screen.getByRole("button", { name: "Create in cloud" });
    expect(create.hasAttribute("disabled")).toBe(true);
    fireEvent.click(allow);
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    expect(invoke).toHaveBeenCalledWith("cloud_provider_set_creation_enabled", { provider: "box", contextRevision: "scope:1", enabled: true });
    expect(flow.cloudPlacementOffers).toHaveBeenCalledTimes(2);
    expect(flow.prepareCloudCreate).not.toHaveBeenCalled();
    expect(flow.confirmCloudCreate).not.toHaveBeenCalled();
  });

  it("does not read placement offers or preflight while privacy status is unknown or enabled", async () => {
    privacyMode.ready = false;
    const view = render(<NewSessionView />);
    expect(flow.cloudPlacementOffers).not.toHaveBeenCalled();
    expect(flow.checkCloudPlacement).not.toHaveBeenCalled();
    Object.assign(privacyMode, { ready: true, enabled: true });
    view.rerender(<NewSessionView />);
    expect(flow.cloudPlacementOffers).not.toHaveBeenCalled();
    expect(flow.checkCloudPlacement).not.toHaveBeenCalled();
    privacyMode.enabled = false;
    view.rerender(<NewSessionView />);
    await screen.findByText(/Cloud preflight checked/);
    expect(flow.cloudPlacementOffers).toHaveBeenCalledOnce();
    expect(flow.checkCloudPlacement).toHaveBeenCalledOnce();
  });

  it("distinguishes an unavailable machine price from a quote in progress", async () => {
    let failQuote!: (error: Error) => void;
    flow.quoteCloudPlacement.mockReturnValueOnce(new Promise((_, reject) => { failQuote = reject; }));
    render(<NewSessionView />);
    await screen.findByText("Machine price pending");
    await act(async () => failQuote(new Error("Could not read the machine price.")));
    expect(await screen.findByText("Machine price unavailable")).toBeTruthy();
    expect(screen.queryByText("Machine price pending")).toBeNull();
  });

  it.each([
    "Could not verify the agent login for this organization.",
    "No environment version is ready for this organization.",
  ])("blocks Create and provider selection when preflight reports %s", async (reason) => {
    flow.checkCloudPlacement.mockRejectedValue(new Error(reason));
    render(<NewSessionView />);
    type("Wait for readiness");
    await screen.findByText(reason);
    expect(screen.getByRole("button", { name: "Create in cloud" }).hasAttribute("disabled")).toBe(true);
    await accessibilityPress(screen.getByTestId("cloud-runs-in"));
    expect(screen.getByTestId("where-cloud-org-a-box").getAttribute("aria-disabled")).toBe("true");
    expect(flow.prepareCloudCreate).not.toHaveBeenCalled();
  });

  it("blocks new cloud placement at the organization's running limit and lets This Mac restore the local form", async () => {
    catalog.value = { orgs: { "org-a": { quota: { running: { used: 3, limit: 3 } } } } };
    const view = render(<NewSessionView />);
    type("Keep this draft");
    expect(await screen.findByText("Your organization is running 3 of 3 cloud workspaces. Stop one to start another.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create in cloud" }).hasAttribute("disabled")).toBe(true);
    await accessibilityPress(screen.getByTestId("cloud-runs-in"));
    fireEvent.click(screen.getByTestId("where-this-mac"));
    expect(here).toHaveBeenCalledTimes(1);
    view.rerender(<NewSessionView />);
    expect(screen.queryByRole("button", { name: "Create in cloud" })).toBeNull();
    expect(screen.getByDisplayValue("Keep this draft")).toBeTruthy();
  });

  it("blocks placement at the total workspace limit even with a running slot available", async () => {
    catalog.value = { orgs: { "org-a": { quota: { used: 1, limit: 3, running: { used: 1, limit: 3 }, total: { used: 5, limit: 5 } } } } };
    render(<NewSessionView />);
    type("Wait for a workspace slot");
    expect(await screen.findByText("The organization has reached its cloud workspace limit.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create in cloud" }).hasAttribute("disabled")).toBe(true);
    await accessibilityPress(screen.getByTestId("cloud-runs-in"));
    expect(screen.getByTestId("where-cloud-org-a-box").getAttribute("aria-disabled")).toBe("true");
    expect(flow.prepareCloudCreate).not.toHaveBeenCalled();
  });
});
