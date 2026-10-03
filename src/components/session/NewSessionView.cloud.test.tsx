import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo, Project } from "@/types/session";
import type { CloudProject } from "@/types/target";
import { accessibilityPress, mouseClick } from "@/test/press";

// PRO-61 (CS-13 subset): the project row's `+` opens the same new-session
// form, preset with "Runs in: <Org> cloud". Start reuses or wakes a
// workspace, or asks for the one-time cost confirmation before creating one.
// No local path command runs for a cloud draft.

const { invoke, flow, draft, mayStart } = vi.hoisted(() => ({
  invoke: vi.fn(),
  flow: {
    planCloudStart: vi.fn(),
    startInWorkspace: vi.fn(),
    prepareCloudCreate: vi.fn(),
    confirmCloudCreate: vi.fn(),
  },
  draft: { value: null as { project: CloudProject | null; orgName: string; mayStart: boolean | null } | null },
  /** Whether this account may start cloud sessions in the organization (an owner or admin). */
  mayStart: { value: true as boolean | null },
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
}));
vi.mock("@/lib/dictation", () => ({ stopDictation: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn() }));
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "bypassPermissions", label: "Bypass", hint: "" }],
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => [{ id: "opus", label: "Opus", efforts: [], defaultEffort: null, isDefault: true }],
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({ useWorktree: true, lastAgent: "claude", lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", lastProject: null }),
  setPrefs: vi.fn(),
}));
const local = { path: "/repos/raccoon", name: "raccoon" } as Project;
// Claude is not installed on this computer; it is on the cloud workspace.
const harness = { id: "claude", name: "Claude", available: false, installHint: "" } as HarnessInfo;
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ projects: [local], harnesses: [harness], selectedProject: local.path, workspaces: {}, newSessionPreset: null, cloudSessionPreset: { projectKey: "cloud:org-a:github.com/acme/api" } }),
  addProject: vi.fn(),
  clearNewSessionPreset: vi.fn(),
  selectProject: vi.fn(),
  selectProjectInSidebar: vi.fn(),
  selectSession: vi.fn(),
  upsertSession: vi.fn(),
  startCloudSessionIn: vi.fn(),
}));
vi.mock("./CloudNewSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./CloudNewSession")>()),
  useCloudDraft: () => draft.value,
  useCloudProjectChoices: () => [{ orgId: "org-a", orgName: "Acme", mayStart: mayStart.value, projects: [project, { ...project, key: "cloud:org-a:blank/scratch", identity: "blank/scratch", fullName: "scratch", blank: true }] }],
}));
vi.mock("@/lib/cloudNewSession", () => flow);
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
  mayStart.value = true;
  draft.value = { project, orgName: "Acme", mayStart: true };
});

afterEach(() => cleanup());

const type = (text: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });

describe("new session in a cloud project", () => {
  it("says where it runs, keeps the worktree toggle on from the local preference, and runs no local command", () => {
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    expect(screen.getByTestId("cloud-runs-in").textContent?.trim()).toBe("Runs in: Acme cloud");
    expect(screen.getByText("acme/api", { selector: "span" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "New worktree on the cloud workspace" }).getAttribute("aria-checked")).toBe("true");
    // An agent not installed here still runs there.
    expect(screen.queryByText(/isn't installed/)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("starts in an existing workspace (a wake for a stopped one) with the prompt and the worktree preference", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "wake", node });
    flow.startInWorkspace.mockResolvedValue("cloud:org-a:ws-1:s1");
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Fix the login redirect");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(flow.startInWorkspace).toHaveBeenCalledTimes(1));
    expect(flow.startInWorkspace).toHaveBeenCalledWith({ kind: "wake", node }, { agent: "claude", model: "opus", effort: null, mode: "bypassPermissions", prompt: "Fix the login redirect", useWorktree: true });
    expect(flow.prepareCloudCreate).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks once for the cost, showing the quota, before creating a workspace", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    flow.prepareCloudCreate.mockResolvedValue(prepared);
    flow.confirmCloudCreate.mockResolvedValue({});
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Start the API");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const card = await screen.findByTestId("cloud-create-confirm");
    expect(screen.getByTestId("cloud-create-quota").textContent).toBe("Acme has 1 of 2 cloud workspaces in use; this adds one.");
    expect(screen.getByTestId("cloud-create-price").textContent).toContain("an hour while it runs");
    expect(flow.confirmCloudCreate).not.toHaveBeenCalled();
    // Start is off while the confirmation is open: one confirmation, one create.
    expect(screen.getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("cloud-create-confirm-button"));
    await waitFor(() => expect(flow.confirmCloudCreate).toHaveBeenCalledWith(prepared));
    await waitFor(() => expect(card.isConnected).toBe(false));
    expect(screen.getByTestId("cloud-start-status").textContent).toContain("The session opens when its agent is running");
  });

  it("at the limit, says so and creates nothing", async () => {
    const { CreateRefused } = await import("@/lib/cloudCreate");
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    flow.prepareCloudCreate.mockRejectedValue(new CreateRefused("cloud_workspace_quota_exceeded"));
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("One more");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("The cloud workspace did not come up in time. Try again.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    roles.registerAccountRoles(null);
  });
});

describe("the running limit (saas PRO-76)", () => {
  it("explains a resume refused at the running limit and offers to stop a running workspace", async () => {
    flow.planCloudStart.mockReturnValue({ kind: "wake", node });
    flow.startInWorkspace.mockRejectedValue({ code: "cloud_workspace_concurrency_exceeded", status: 409 });
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("Fix the login redirect");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(await screen.findByTestId("cloud-create-confirm-button"));
    expect(await screen.findByText(/Stop one to start another\./)).toBeTruthy();
    expect(screen.getByTestId("running-limit-notice")).toBeTruthy();
  });

  it("offers nothing to stop for other refusals", async () => {
    const { CreateRefused } = await import("@/lib/cloudCreate");
    flow.planCloudStart.mockReturnValue({ kind: "create" });
    flow.prepareCloudCreate.mockRejectedValue(new CreateRefused("cloud_provisioning_paused"));
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    type("One more");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
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

  it("project, agent, model and permissions each open on a real mouse click, and a second click closes it", async () => {
    render(<NewSessionView useWorktree onUseWorktreeChange={vi.fn()} />);
    for (const [name, label] of [[/acme\/api/, "Acme cloud"], [/^Claude/, "Agent"], [/^Opus/, "Model"], [/^Bypass/, "Permissions"]] as const) {
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
    for (const name of [/^Claude/, /^Opus/, /^Bypass/]) {
      accessibilityPress(picker(name));
      await screen.findByRole("menu");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
  });
});
