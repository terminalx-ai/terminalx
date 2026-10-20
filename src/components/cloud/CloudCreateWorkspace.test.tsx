import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ModelInfo } from "@/lib/api";
// First, as the app loads it: the session store reached earlier would load the
// real account module inside its mock, and the cloud catalog would keep that one.
import { CloudCreateWorkspace } from "./CloudCreateWorkspace";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { refreshHarnesses } from "@/lib/sessions";
import { BypassDialog } from "@/components/session/BypassDialog";
import type { HarnessInfo } from "@/types/session";

vi.mock("@/lib/api", () => ({
  api: {
    cloudProviders: vi.fn(),
    cloudWorkspaceRepositories: vi.fn(),
    cloudWorkspacePreflight: vi.fn(),
    cloudWorkspaceSetup: vi.fn(),
    cloudWorkspaceQuote: vi.fn(),
    cloudWorkspaceCreate: vi.fn(),
    cloudWorkspaceOperation: vi.fn(),
    cloudWorkspaceOperationCancel: vi.fn(),
    cloudWorkspaceResume: vi.fn(),
    listHarnesses: vi.fn(),
  },
}));
const account = vi.hoisted(() => ({ multiOrg: false }));
vi.mock("@/lib/account", async (original) => ({
  ...(await original<typeof import("@/lib/account")>()),
  getAccount: () => ({ status: { state: "signed-in", identity: { email: "a@example.com", organizationId: "org-1" }, multiOrg: account.multiOrg }, ready: true, busy: false }),
}));
const catalog = vi.hoisted(() => ({ models: [] as ModelInfo[] }));
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  useModels: (harness: string) => catalog.models.filter((m) => m.harness === harness),
}));

const model = (id: string, label: string, harness: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id, label, harness, efforts: [], defaultEffort: null, acceptsImages: true, isDefault: false, upgrade: null, description: null, ...extra,
});
const MODELS = [
  model("sonnet", "Sonnet", "claude", { alias: true, isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }),
  model("opus", "Opus", "claude", { alias: true, resolved: "claude-opus-5-5", efforts: ["low", "high", "max"], defaultEffort: "high" }),
  model("haiku", "Haiku", "claude", { alias: true }),
  // Pinned on this computer: a new workspace's CLI may not run it.
  model("claude-opus-5", "Opus 5", "claude"),
  model("gpt-6-astra", "GPT-6 Astra", "codex", { isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }),
  model("gpt-5.6-sol", "GPT-5.6 Sol", "codex", { efforts: ["medium", "high"], defaultEffort: "high" }),
];
// Claude Code is not installed on this computer; the workspace runs it.
const HARNESSES = [
  { id: "claude", name: "Claude Code", available: false },
  { id: "codex", name: "Codex", available: true },
] as HarnessInfo[];

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const QUOTE = {
  id: "quote-1", currency: "USD", pricing: "estimate", activeHourlyMicros: 120_000, estimatedSuspendedMonthlyMicros: 3_000_000, expiresAt: 0,
  configuration: { machineClassLabel: "Standard", vcpu: 4, memoryMiB: 8192, locationLabel: "Frankfurt", idleSuspendMinutes: 10 },
};

/** Show the price, then create: the form creates nothing before its price is on screen. */
async function create() {
  fireEvent.click(screen.getByRole("button", { name: /Show price/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Create workspace/ }));
}

const timings = { requestedAt: 1000, bootingAt: null, authenticatingAt: null, syncingAt: null, startingAgentAt: null, runningAt: null, failedAt: null };
const snapshot = (phase: string, patch: { workspace?: object; operation?: object; launch?: object } = {}) => ({
  workspace: {
    id: "ws-1", orgId: "org-1", name: "app", provider: "box", state: "provisioning", accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null,
    launch: {
      launchId: "launch_1", phase, state: "pending", workBranch: "terminalx/app-3f9a2c1b7d4e", agent: "claude", model: "sonnet", effort: "high", mode: "acceptEdits",
      hasPrompt: true, category: null, sessionId: null, tabId: null, timings, ...patch.launch,
    },
    ...patch.workspace,
  },
  operation: {
    id: "op-1", workspaceId: "ws-1", type: "create", action: null, state: "running", stage: "creating-machine", cancelable: true, createdAt: 1, updatedAt: 1,
    lastProviderContactAt: null, nextAttemptAt: null, retryReason: null, errorCode: null, progress: null, events: null, ...patch.operation,
  },
});

beforeEach(async () => {
  account.multiOrg = false;
  localStorage.clear();
  for (const fn of Object.values(mocked)) fn.mockReset();
  catalog.models = MODELS;
  mocked.listHarnesses.mockResolvedValue(HARNESSES);
  await refreshHarnesses();
  setPrefs({ lastAgent: "claude", lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", bypassConfirmed: false });
  mocked.cloudProviders.mockResolvedValue({ providers: [{ id: "box", displayName: "Boat", availability: "available", canManage: true, connection: null, capabilities: {} }] });
  mocked.cloudWorkspaceRepositories.mockResolvedValue({
    configured: true,
    repositories: [
      { fullName: "acme/app", cloneUrl: "https://github.com/acme/app.git", defaultBranch: "main", private: true, state: "accessible", reason: null },
      { fullName: "acme/lib", cloneUrl: "https://github.com/acme/lib.git", defaultBranch: "trunk", private: false, state: "accessible", reason: null },
      { fullName: "acme/gone", cloneUrl: "https://github.com/acme/gone.git", defaultBranch: "main", private: false, state: "missing", reason: "github_repository_unavailable" },
    ],
  });
  mocked.cloudWorkspacePreflight.mockResolvedValue({ ready: true, checks: [] });
  mocked.cloudWorkspaceSetup.mockResolvedValue({ defaults: { sourceId: "s", locationId: "l", machineClassId: "m", idleSuspendMinutes: 10, retentionDays: 30, networkPolicy: "provider-public-network" } });
  mocked.cloudWorkspaceQuote.mockResolvedValue(QUOTE);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function fill() {
  // The bypass confirmation is the app's, mounted beside the form as AppShell mounts it.
  render(
    <>
      <CloudCreateWorkspace organizationId="org-1" onOpen={vi.fn()} />
      <BypassDialog />
    </>,
  );
  await screen.findByRole("option", { name: "acme/app" });
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/acme/app.git" } });
  fireEvent.change(screen.getByLabelText("Additional repository"), { target: { value: "https://github.com/acme/lib.git" } });
  fireEvent.change(screen.getByLabelText("Base branch of acme/app"), { target: { value: "feature/login" } });
  fireEvent.change(screen.getByLabelText("Initial prompt"), { target: { value: "Fix the login" } });
  fireEvent.click(screen.getByRole("radio", { name: "Organization" }));
}

/** Open one of the shared launch pickers by its title and choose an item. */
async function choose(picker: string, name: string | RegExp, role: "menuitem" | "menuitemradio" = "menuitemradio") {
  fireEvent.click(screen.getByTitle(picker));
  fireEvent.click(await screen.findByRole(role, { name }));
}

const pill = (title: string) => screen.getByTitle(title).textContent;

/** The launch intent of the one workspace created. */
async function createdLaunch() {
  await create();
  await screen.findByTestId("cloud-create-progress");
  expect(mocked.cloudWorkspaceCreate).toHaveBeenCalledTimes(1);
  return mocked.cloudWorkspaceCreate.mock.calls[0][0].launch;
}

describe("CloudCreateWorkspace", () => {
  it("lists the organization's repositories and creates with branches, prompt, agent settings and visibility", async () => {
    mocked.cloudWorkspaceCreate.mockResolvedValue(snapshot("allocating"));
    await fill();
    expect(screen.getByRole("option", { name: /acme\/gone/ })).toHaveProperty("disabled", true);
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).value).toBe("app");
    expect((screen.getByLabelText("Base branch of acme/lib") as HTMLInputElement).placeholder).toBe("trunk");
    await create();

    await screen.findByTestId("cloud-create-progress");
    expect(mocked.cloudWorkspacePreflight).toHaveBeenCalledWith([
      { cloneUrl: "https://github.com/acme/app.git", ref: "feature/login" },
      { cloneUrl: "https://github.com/acme/lib.git", ref: null },
    ], null, "claude");
    expect(mocked.cloudWorkspaceQuote).toHaveBeenCalledWith(expect.objectContaining({ provider: "box", sourceId: "s" }), null);
    const input = mocked.cloudWorkspaceCreate.mock.calls[0][0];
    expect(input).toMatchObject({
      name: "app",
      quoteId: "quote-1",
      accessMode: "organization",
      repositories: [
        { cloneUrl: "https://github.com/acme/app.git", ref: "feature/login" },
        { cloneUrl: "https://github.com/acme/lib.git", ref: null },
      ],
      launch: { agent: "claude", model: "sonnet", effort: "high", mode: "bypassPermissions", prompt: "Fix the login" },
    });
    expect(input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByText("terminalx/app-3f9a2c1b7d4e")).toBeTruthy();
  });

  it("shows the price before anything is created, and asks for it again after a change", async () => {
    mocked.cloudWorkspaceCreate.mockResolvedValue(snapshot("allocating"));
    await fill();
    expect(screen.queryByRole("button", { name: /Create workspace/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show price/ }));
    const price = await screen.findByTestId("cloud-create-quote-price");
    expect(price.textContent).toBe("$0.12 an hour while it runs (estimate), about $3.00 a month while stopped. It stops itself after 10 idle minutes.");
    expect(screen.getByTestId("cloud-create-quote").textContent).toContain("Boat · Standard (4 vCPU, 8 GB) · Frankfurt");
    expect(mocked.cloudWorkspaceCreate).not.toHaveBeenCalled();
    // A change to the form: the price shown is no longer this form's.
    fireEvent.change(screen.getByLabelText("Initial prompt"), { target: { value: "Fix the logout" } });
    expect(screen.queryByTestId("cloud-create-quote")).toBeNull();
    await create();
    await screen.findByTestId("cloud-create-progress");
    expect(mocked.cloudWorkspaceCreate).toHaveBeenCalledTimes(1);
    expect(mocked.cloudWorkspaceCreate.mock.calls[0][0].launch.prompt).toBe("Fix the logout");
  });

  it("refuses an invalid base branch before anything is quoted", async () => {
    await fill();
    fireEvent.change(screen.getByLabelText("Base branch of acme/app"), { target: { value: "bad..branch" } });
    expect(screen.getByText("Not a valid branch name.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show price/ })).toHaveProperty("disabled", true);
    expect(mocked.cloudWorkspaceQuote).not.toHaveBeenCalled();
  });

  it("shows quota and policy refusals in words, without a retry", async () => {
    mocked.cloudWorkspaceCreate.mockRejectedValue({ code: "cloud_workspace_quota_exceeded", retryWithSameIdempotencyKey: false });
    await fill();
    await create();
    const alert = await screen.findByTestId("cloud-create-error");
    expect(alert.textContent).toMatch(/workspace limit/);
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("retries an unconfirmed create with the same key and request", async () => {
    mocked.cloudWorkspaceCreate
      .mockRejectedValueOnce({ code: "cloud_workspace_create_outcome_unknown", retryWithSameIdempotencyKey: true })
      .mockResolvedValueOnce(snapshot("booting"));
    await fill();
    await create();
    fireEvent.click(await screen.findByRole("button", { name: /Retry/ }));
    await screen.findByTestId("cloud-create-progress");
    expect(mocked.cloudWorkspaceCreate).toHaveBeenCalledTimes(2);
    expect(mocked.cloudWorkspaceCreate.mock.calls[1][0]).toEqual(mocked.cloudWorkspaceCreate.mock.calls[0][0]);
    expect(mocked.cloudWorkspaceQuote).toHaveBeenCalledTimes(1);
  });

  it("follows the phases to running and opens the session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onOpen = vi.fn();
    mocked.cloudWorkspaceCreate.mockResolvedValue(snapshot("allocating"));
    mocked.cloudWorkspaceOperation
      .mockResolvedValueOnce(snapshot("syncing-repository", { operation: { state: "succeeded", stage: "ready", cancelable: false }, workspace: { state: "ready" } }))
      .mockResolvedValueOnce(
        snapshot("running", { operation: { state: "succeeded", stage: "ready", cancelable: false }, workspace: { state: "ready" }, launch: { state: "started", tabId: "tab-1", timings: { ...timings, runningAt: 7400 } } }),
      );
    render(<CloudCreateWorkspace organizationId="org-1" onOpen={onOpen} />);
    await screen.findByRole("option", { name: "acme/app" });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/acme/app.git" } });
    await create();
    const progress = await screen.findByTestId("cloud-create-progress");
    expect(progress.dataset.phase).toBe("allocating");
    await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
    await waitFor(() => expect(progress.dataset.phase).toBe("syncing-repository"));
    expect(screen.getByText("Allocating").closest("li")?.dataset.state).toBe("done");
    expect(screen.getByText("Syncing repository").closest("li")?.dataset.state).toBe("current");
    await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
    await waitFor(() => expect(progress.dataset.phase).toBe("running"));
    expect(screen.getByText(/Ready in 6s\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ workspace: expect.objectContaining({ id: "ws-1" }) }));
    // Settled: polling stops.
    await act(async () => void (await vi.advanceTimersByTimeAsync(6000)));
    expect(mocked.cloudWorkspaceOperation).toHaveBeenCalledTimes(2);
  });

  it("cancels during the build", async () => {
    mocked.cloudWorkspaceCreate.mockResolvedValue(snapshot("booting", { operation: { stage: "bootstrapping" } }));
    mocked.cloudWorkspaceOperationCancel.mockResolvedValue(
      snapshot("canceled", { operation: { state: "canceled", stage: "cleanup", cancelable: false }, launch: { state: "canceled" } }),
    );
    await fill();
    await create();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByTestId("cloud-create-progress").dataset.phase).toBe("canceled"));
    expect(mocked.cloudWorkspaceOperationCancel).toHaveBeenCalledWith("op-1", null);
    expect(screen.getByText(/first prompt was not sent/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("names the workspace's organization when polling, cancelling and retrying on a multi-org server (CS-18)", async () => {
    account.multiOrg = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocked.cloudWorkspaceCreate.mockResolvedValue(snapshot("booting", { operation: { stage: "bootstrapping" } }));
    mocked.cloudWorkspaceOperation.mockResolvedValue(snapshot("booting", { operation: { stage: "bootstrapping" } }));
    mocked.cloudWorkspaceOperationCancel.mockResolvedValue(
      snapshot("failed", { workspace: { state: "attention-required" }, operation: { state: "failed", stage: "connecting-relay", cancelable: false, errorCode: "provider_retry_exhausted" } }),
    );
    mocked.cloudWorkspaceResume.mockResolvedValue(snapshot("allocating", { operation: { id: "op-2", stage: "queued", state: "queued", cancelable: false } }));
    await fill();
    await create();
    await screen.findByRole("button", { name: "Cancel" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
    expect(mocked.cloudWorkspaceOperation).toHaveBeenCalledWith("op-1", "org-1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocked.cloudWorkspaceOperationCancel).toHaveBeenCalledWith("op-1", "org-1"));
    fireEvent.click(await screen.findByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(mocked.cloudWorkspaceResume).toHaveBeenCalledWith("ws-1", "org-1"));
    vi.useRealTimers();
  });

  it("retries a failed create by resuming the same workspace", async () => {
    mocked.cloudWorkspaceCreate.mockResolvedValue(
      snapshot("failed", { workspace: { state: "attention-required" }, operation: { state: "failed", stage: "connecting-relay", cancelable: false, errorCode: "provider_retry_exhausted" } }),
    );
    mocked.cloudWorkspaceResume.mockResolvedValue(snapshot("allocating", { operation: { id: "op-2", stage: "queued", state: "queued", cancelable: false } }));
    await fill();
    await create();
    expect((await screen.findByText(/Provisioning failed/)).textContent).toMatch(/provider_retry_exhausted/);
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(screen.getByTestId("cloud-create-progress").dataset.phase).toBe("allocating"));
    expect(mocked.cloudWorkspaceResume).toHaveBeenCalledWith("ws-1", null);
    expect(mocked.cloudWorkspaceCreate).toHaveBeenCalledTimes(1);
  });

  it("says when a Ready workspace's runtime never picks up the first task, and still opens the session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(100_000);
    const onOpen = vi.fn();
    const onProgress = vi.fn();
    const stuck = snapshot("authenticating-runtime", {
      workspace: { state: "ready" },
      operation: { state: "succeeded", stage: "ready", cancelable: false, updatedAt: 100_000 },
    });
    mocked.cloudWorkspaceCreate.mockResolvedValue(stuck);
    mocked.cloudWorkspaceOperation.mockResolvedValue(stuck);
    render(<CloudCreateWorkspace organizationId="org-1" onOpen={onOpen} onProgress={onProgress} />);
    await screen.findByRole("option", { name: "acme/app" });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/acme/app.git" } });
    await create();
    const progress = await screen.findByTestId("cloud-create-progress");
    expect(progress.dataset.phase).toBe("authenticating-runtime");
    expect(onProgress).toHaveBeenCalledWith(stuck);
    expect(screen.queryByTestId("cloud-create-not-picked-up")).toBeNull();
    // Ready, so the session can be opened before the agent runs.
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ workspace: expect.objectContaining({ id: "ws-1", state: "ready" }) }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 2100)));
    expect((await screen.findByTestId("cloud-create-not-picked-up")).textContent).toMatch(/has not picked up the first task/);
    expect(screen.getByRole("button", { name: "Open session" })).toBeTruthy();
    // Each poll reaches the list too.
    expect(onProgress.mock.calls.length).toBeGreaterThan(2);
  });

  it("names a runtime that cannot start agents from a first prompt", async () => {
    mocked.cloudWorkspaceCreate.mockResolvedValue(
      snapshot("failed", { workspace: { state: "ready" }, operation: { state: "succeeded", stage: "ready", cancelable: false }, launch: { state: "failed", category: "runtime-unsupported" } }),
    );
    await fill();
    await create();
    expect(await screen.findByText(/runtime cannot start agents from a first prompt/)).toBeTruthy();
    expect(screen.queryByText(/runtime-unsupported/)).toBeNull();
  });
});

describe("CloudCreateWorkspace repository list", () => {
  it("says the list failed to load instead of claiming none are selected, and retries", async () => {
    mocked.cloudWorkspaceRepositories.mockRejectedValueOnce({ code: "cloud_workspace_unavailable" });
    render(<CloudCreateWorkspace organizationId="org-1" onOpen={vi.fn()} />);
    const alert = await screen.findByText(/could not be loaded/);
    expect(alert.textContent).toContain("cloud_workspace_unavailable");
    expect(screen.queryByText(/No repositories are selected/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("option", { name: "acme/app" });
  });

  it("forgets an unconfirmed create older than a day, prompt included", async () => {
    const { loadPending, setPendingCreateUser } = await import("@/lib/cloudCreate");
    setPendingCreateUser("a@example.com");
    const key = "terminalx.cloudCreate.pending.a%40example%2Ecom.org-1";
    localStorage.setItem(key, JSON.stringify({ idempotencyKey: "k", createdAt: Date.now() - 25 * 3600 * 1000, request: { name: "old", launch: { prompt: "secret plan" } } }));
    expect(loadPending("org-1")).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    setPendingCreateUser(null);
  });
});

describe("CloudCreateWorkspace launch settings", () => {
  beforeEach(() => mocked.cloudWorkspaceCreate.mockResolvedValue(snapshot("allocating")));

  it("starts from what New Session would launch with, in the shared pickers, and saves nothing it picks", async () => {
    setPrefs({ lastAgent: "codex", lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "medium" }, lastMode: "manual" });
    await fill();
    const launch = screen.getByTestId("cloud-create-launch");
    expect(["Agent", "Model", "Effort", "Permissions"].map((title) => within(launch).getByTitle(title).textContent)).toEqual(["Codex", "GPT-5.6 Sol", "Medium", "Ask every time"]);
    // No copy of the pickers is left on the form.
    for (const name of ["Agent", "Model", "Effort", "Permission mode"]) expect(screen.queryByRole("combobox", { name })).toBeNull();
    await choose("Effort", "High");
    expect(await createdLaunch()).toMatchObject({ agent: "codex", model: "gpt-5.6-sol", effort: "high", mode: "manual" });
    expect(mocked.cloudWorkspacePreflight).toHaveBeenCalledWith(expect.any(Array), null, "codex");
    expect(getPrefs()).toMatchObject({ lastAgent: "codex", lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "medium" }, lastMode: "manual" });
  });

  it("offers the agents New Session offers for a cloud project, installed on this computer or not", async () => {
    await fill();
    fireEvent.click(screen.getByTitle("Agent"));
    const agents = await screen.findAllByRole("menuitem");
    expect(agents.map((item) => item.textContent)).toEqual(HARNESSES.map((h) => h.name));
    // The agent runs on the workspace, so one missing here is still offered.
    expect(agents.map((item) => item.getAttribute("aria-disabled"))).toEqual([null, null]);
  });

  it("offers the cloud's aliases, never a version pinned on this computer", async () => {
    await fill();
    expect(pill("Model")).toBe("Sonnet (latest)");
    fireEvent.click(screen.getByTitle("Model"));
    const offered = await screen.findAllByRole("menuitemradio");
    expect(offered.map((item) => item.firstChild?.textContent)).toEqual(["Sonnet", "Opus", "Haiku"]);
  });

  it("switches agent to that agent's saved model and effort, and never keeps an effort a model does not take", async () => {
    setPrefs({ lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "high" } });
    await fill();
    expect([pill("Agent"), pill("Model"), pill("Effort")]).toEqual(["Claude Code", "Sonnet (latest)", "High"]);

    await choose("Agent", "Codex", "menuitem");
    expect([pill("Model"), pill("Effort")]).toEqual(["GPT-5.6 Sol", "High"]);
    // GPT-6 Astra takes High too, so it stays.
    await choose("Model", "GPT-6 Astra");
    expect(pill("Effort")).toBe("High");

    await choose("Agent", "Claude Code", "menuitem");
    await choose("Model", /^Opus/);
    await choose("Effort", "Max");
    // Sonnet has no Max: its own default, not the one picked for Opus.
    await choose("Model", /^Sonnet/);
    expect(pill("Effort")).toBe("High");
    await choose("Model", /^Haiku/);
    expect(screen.queryByTitle("Effort")).toBeNull();

    expect(await createdLaunch()).toMatchObject({ agent: "claude", model: "haiku", effort: null, mode: "bypassPermissions" });
    expect(getPrefs()).toMatchObject({ lastAgent: "claude", lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "high" } });
  });

  it("asks before bypass as New Session does, and keeps the answer to this workspace", async () => {
    setPrefs({ lastMode: "manual" });
    await fill();
    expect(pill("Permissions")).toBe("Ask every time");

    await choose("Permissions", /^Bypass permissions/);
    const dialog = await screen.findByRole("dialog", { name: "Let Claude Code run without asking?" });
    // Nothing changes until it is agreed to.
    expect(pill("Permissions")).toBe("Ask every time");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pill("Permissions")).toBe("Ask every time");

    await choose("Permissions", /^Bypass permissions/);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Bypass permissions" }));
    await waitFor(() => expect(pill("Permissions")).toBe("Bypass permissions"));

    expect((await createdLaunch()).mode).toBe("bypassPermissions");
    expect(getPrefs().lastMode).toBe("manual");
  });

  it("takes bypass at once after the reader said not to ask again", async () => {
    setPrefs({ lastMode: "manual", bypassConfirmed: true });
    await fill();
    await choose("Permissions", /^Bypass permissions/);
    expect(pill("Permissions")).toBe("Bypass permissions");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((await createdLaunch()).mode).toBe("bypassPermissions");
  });
});
