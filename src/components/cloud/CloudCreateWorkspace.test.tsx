import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { CloudCreateWorkspace } from "./CloudCreateWorkspace";

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
  },
}));
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  useModels: (harness: string) =>
    harness === "claude"
      ? [{ id: "sonnet", label: "Sonnet", harness: "claude", efforts: ["low", "high"], defaultEffort: "high", acceptsImages: true, isDefault: true, upgrade: null, description: null }]
      : [],
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

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

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(mocked)) fn.mockReset();
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
  mocked.cloudWorkspaceQuote.mockResolvedValue({ id: "quote-1" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function fill() {
  render(<CloudCreateWorkspace organizationId="org-1" onOpen={vi.fn()} />);
  await screen.findByRole("option", { name: "acme/app" });
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/acme/app.git" } });
  fireEvent.change(screen.getByLabelText("Additional repository"), { target: { value: "https://github.com/acme/lib.git" } });
  fireEvent.change(screen.getByLabelText("Base branch of acme/app"), { target: { value: "feature/login" } });
  fireEvent.change(screen.getByLabelText("Initial prompt"), { target: { value: "Fix the login" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "sonnet" } });
  fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
  fireEvent.click(screen.getByRole("radio", { name: "Organization" }));
}

describe("CloudCreateWorkspace", () => {
  it("lists the organization's repositories and creates with branches, prompt, agent settings and visibility", async () => {
    mocked.cloudWorkspaceCreate.mockResolvedValue(snapshot("allocating"));
    await fill();
    expect(screen.getByRole("option", { name: /acme\/gone/ })).toHaveProperty("disabled", true);
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).value).toBe("app");
    expect((screen.getByLabelText("Base branch of acme/lib") as HTMLInputElement).placeholder).toBe("trunk");
    fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));

    await screen.findByTestId("cloud-create-progress");
    expect(mocked.cloudWorkspacePreflight).toHaveBeenCalledWith([
      { cloneUrl: "https://github.com/acme/app.git", ref: "feature/login" },
      { cloneUrl: "https://github.com/acme/lib.git", ref: null },
    ], null);
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

  it("refuses an invalid base branch before anything is quoted", async () => {
    await fill();
    fireEvent.change(screen.getByLabelText("Base branch of acme/app"), { target: { value: "bad..branch" } });
    expect(screen.getByText("Not a valid branch name.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create workspace/ })).toHaveProperty("disabled", true);
    expect(mocked.cloudWorkspaceQuote).not.toHaveBeenCalled();
  });

  it("shows quota and policy refusals in words, without a retry", async () => {
    mocked.cloudWorkspaceCreate.mockRejectedValue({ code: "cloud_workspace_quota_exceeded", retryWithSameIdempotencyKey: false });
    await fill();
    fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
    const alert = await screen.findByTestId("cloud-create-error");
    expect(alert.textContent).toMatch(/workspace limit/);
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("retries an unconfirmed create with the same key and request", async () => {
    mocked.cloudWorkspaceCreate
      .mockRejectedValueOnce({ code: "cloud_workspace_create_outcome_unknown", retryWithSameIdempotencyKey: true })
      .mockResolvedValueOnce(snapshot("booting"));
    await fill();
    fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
    const progress = await screen.findByTestId("cloud-create-progress");
    expect(progress.dataset.phase).toBe("allocating");
    await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
    await waitFor(() => expect(progress.dataset.phase).toBe("syncing-repository"));
    expect(screen.getByText("Allocating").closest("li")?.dataset.state).toBe("done");
    expect(screen.getByText("Syncing repository").closest("li")?.dataset.state).toBe("current");
    await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
    await waitFor(() => expect(progress.dataset.phase).toBe("running"));
    expect(screen.getByText(/Ready in 6.4 s/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByTestId("cloud-create-progress").dataset.phase).toBe("canceled"));
    expect(mocked.cloudWorkspaceOperationCancel).toHaveBeenCalledWith("op-1");
    expect(screen.getByText(/first prompt was not sent/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("retries a failed create by resuming the same workspace", async () => {
    mocked.cloudWorkspaceCreate.mockResolvedValue(
      snapshot("failed", { workspace: { state: "attention-required" }, operation: { state: "failed", stage: "connecting-relay", cancelable: false, errorCode: "provider_retry_exhausted" } }),
    );
    mocked.cloudWorkspaceResume.mockResolvedValue(snapshot("allocating", { operation: { id: "op-2", stage: "queued", state: "queued", cancelable: false } }));
    await fill();
    fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
    expect((await screen.findByText(/Provisioning failed/)).textContent).toMatch(/provider_retry_exhausted/);
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(screen.getByTestId("cloud-create-progress").dataset.phase).toBe("allocating"));
    expect(mocked.cloudWorkspaceResume).toHaveBeenCalledWith("ws-1");
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
    fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
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
    const { loadPending } = await import("@/lib/cloudCreate");
    localStorage.setItem("terminalx.cloudCreate.pending.org-1", JSON.stringify({ idempotencyKey: "k", createdAt: Date.now() - 25 * 3600 * 1000, request: { name: "old", launch: { prompt: "secret plan" } } }));
    expect(loadPending("org-1")).toBeNull();
    expect(localStorage.getItem("terminalx.cloudCreate.pending.org-1")).toBeNull();
  });
});
