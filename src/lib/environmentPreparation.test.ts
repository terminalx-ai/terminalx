import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { cloudWorkspaceSetup: vi.fn(), cloudAgentLogins: vi.fn(), cloudWorkspaceQuote: vi.fn(), cloudWorkspaceCreate: vi.fn(), cloudWorkspaceOperation: vi.fn(), cloudWorkspaceSuspend: vi.fn(), cloudWorkspaceDelete: vi.fn() },
  policy: vi.fn(),
  retain: vi.fn(),
  connected: vi.fn(),
  readRemoteFile: vi.fn(),
  writeRemoteFile: vi.fn(),
  listRepositories: vi.fn(),
  verifyProposal: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/lib/organizationCompute", () => ({ organizationCompute: { policy: mocks.policy }, effectiveRunningLimit: (view: { limit: number }) => view.limit }));
vi.mock("@/lib/cloudConnections", () => ({ retainCloudConnection: mocks.retain, waitCloudConnected: mocks.connected }));
vi.mock("@/lib/cloudLifecycle", () => ({ isOpen: (operation: { state: string }) => ["queued", "running"].includes(operation.state) }));
vi.mock("@terminalx/portable/workspaceFiles", () => ({ readRemoteFile: mocks.readRemoteFile, writeRemoteFile: mocks.writeRemoteFile }));
vi.mock("@terminalx/portable/workspaceGit", () => ({ listRepositories: mocks.listRepositories }));
vi.mock("@/lib/environmentVerification", async (original) => ({ ...(await original<typeof import("@/lib/environmentVerification")>()), verifyProposal: mocks.verifyProposal }));

const { PreparationError, offerPreparation, runPreparation, stopPreparation, terminalRunner } = await import("./environmentPreparation");

const view = (running: number, limit = 2, paused = false) => ({ policy: { provisioningPaused: paused }, counts: { running, workspaces: running }, limit, contextRevision: "rev-1" });
const quote = { id: "quote-1", activeHourlyMicros: 20_000, currency: "USD", pricing: "provider-rate" };
const repositories = [{ owner: "acme", name: "widgets", defaultBranch: "main" }];
const offer = { provider: "local-docker" as const, quote: quote as never, idleSuspendMinutes: 5, running: 1, runningLimit: 2, agents: ["claude" as const], contextRevision: "rev-1" };
const request = { offer, agent: "claude" as const, repositories, idempotencyKey: "key-1" };
const workspace = { id: "workspace_1", orgId: "org-1", createdAt: Date.now(), preparation: { stopAfter: Date.now() + 60 * 60_000 } };
const file = JSON.stringify({ installScript: "", repositories: [{ owner: "acme", name: "widgets", setup: [], commands: { test: "pnpm test" }, reported: { test: { status: "passed", exitCode: 0 } } }] });
const tab = (status: string) => ({ status, pendingPermissions: [], signIn: null });
const lease = { release: vi.fn() };
const client = { listAgentTabs: vi.fn(), mutate: vi.fn(), createPty: vi.fn(), attachPty: vi.fn(), write: vi.fn(), killPty: vi.fn() };
const verified = { observedBy: "verification", machine: null, repositories: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.policy.mockResolvedValue(view(1));
  mocks.api.cloudWorkspaceSetup.mockResolvedValue({ defaults: { sourceId: "s", locationId: "l", machineClassId: "m", idleSuspendMinutes: 30, retentionDays: 30, networkPolicy: "relay-only" }, allowedIdleSuspendMinutes: [0, 60, 15, 5] });
  mocks.api.cloudAgentLogins.mockResolvedValue({ credentials: [{ provider: "claude" }] });
  mocks.api.cloudWorkspaceQuote.mockResolvedValue(quote);
  mocks.api.cloudWorkspaceCreate.mockResolvedValue({ workspace, operation: { id: "op-1", state: "succeeded" } });
  mocks.api.cloudWorkspaceSuspend.mockResolvedValue({});
  mocks.api.cloudWorkspaceDelete.mockResolvedValue({});
  mocks.retain.mockResolvedValue(lease);
  mocks.connected.mockResolvedValue(client);
  mocks.listRepositories.mockResolvedValue([{ repo: "widgets", remote: "https://github.com/acme/widgets.git" }]);
  mocks.readRemoteFile.mockResolvedValue({ text: file });
  mocks.verifyProposal.mockResolvedValue(verified);
  client.listAgentTabs.mockResolvedValue([tab("completed")]);
  client.mutate.mockResolvedValue({});
  client.createPty.mockResolvedValue({ ptyId: "pty-1" });
  client.attachPty.mockImplementation(async (_id: string, handlers: { onExit: (code: number) => void }) => {
    queueMicrotask(() => handlers.onExit(0));
    return { detach: vi.fn() };
  });
  client.write.mockResolvedValue(undefined);
  client.killPty.mockResolvedValue(undefined);
});

describe("offerPreparation", () => {
  it("prices a machine with the shortest idle stop, and starts none", async () => {
    const offered = await offerPreparation("local-docker");
    expect(offered).toMatchObject({ idleSuspendMinutes: 5, running: 1, runningLimit: 2, agents: ["claude"] });
    expect(mocks.api.cloudWorkspaceQuote).toHaveBeenCalledWith(expect.objectContaining({ provider: "local-docker", idleSuspendMinutes: 5 }));
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();
  });

  it("refuses at the running limit before asking for a quote", async () => {
    mocks.policy.mockResolvedValue(view(2));
    await expect(offerPreparation("local-docker")).rejects.toMatchObject({ code: "running-limit", message: expect.stringMatching(/2 of 2 running/) });
    expect(mocks.api.cloudWorkspaceQuote).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceCreate).not.toHaveBeenCalled();
  });

  it("refuses when machines are paused, when there is no agent login, or no short idle stop", async () => {
    mocks.policy.mockResolvedValueOnce(view(0, 2, true));
    await expect(offerPreparation("local-docker")).rejects.toMatchObject({ code: "provisioning-paused" });
    mocks.api.cloudAgentLogins.mockResolvedValueOnce({ credentials: [] });
    await expect(offerPreparation("local-docker")).rejects.toMatchObject({ code: "no-agent-login" });
    mocks.api.cloudWorkspaceSetup.mockResolvedValueOnce({ defaults: {}, allowedIdleSuspendMinutes: [0, 30, 60] });
    await expect(offerPreparation("local-docker")).rejects.toMatchObject({ code: "no-idle-window" });
    expect(mocks.api.cloudWorkspaceQuote).not.toHaveBeenCalled();
  });
});

describe("runPreparation", () => {
  it("creates a private preparation workspace with the fixed task, verifies, and stops the machine", async () => {
    const phases: string[] = [];
    const result = await runPreparation(request, { onPhase: (phase) => phases.push(phase.step) });
    expect(mocks.api.cloudWorkspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        preparation: true,
        accessMode: "private",
        confirmProviderSpend: true,
        idempotencyKey: "key-1",
        quoteId: "quote-1",
        repositories: [{ cloneUrl: "https://github.com/acme/widgets", ref: "main" }],
        launch: expect.objectContaining({ agent: "claude", prompt: expect.stringMatching(/Never edit code, tests or configuration/) }),
      }),
    );
    // It only connects; it never wakes a stopped machine.
    expect(mocks.retain).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "workspace_1" }, "connect");
    expect(mocks.readRemoteFile).toHaveBeenCalledWith(client, "widgets/.terminalx/environment-recipe.json", expect.anything());
    expect(mocks.verifyProposal.mock.calls[0][2]).toMatchObject({ directories: { "acme/widgets": "widgets" } });
    expect(result).toMatchObject({ workspaceId: "workspace_1", observations: { observedBy: "verification" }, stopped: true });
    expect(mocks.api.cloudWorkspaceSuspend).toHaveBeenCalledWith("workspace_1", "org-1");
    expect(lease.release).toHaveBeenCalled();
    expect(phases[0]).toBe("creating");
    expect(phases.at(-1)).toBe("stopping");
  });

  it("stops the machine when the agent leaves no proposal, and when the machine cannot be reached", async () => {
    vi.useFakeTimers();
    try {
      mocks.readRemoteFile.mockRejectedValue({ code: "not_found" });
      const run = runPreparation(request);
      const settled = expect(run).rejects.toMatchObject({ code: "no-proposal" });
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      expect(mocks.api.cloudWorkspaceSuspend).toHaveBeenCalledTimes(1);
      expect(mocks.verifyProposal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    mocks.connected.mockRejectedValueOnce(new Error("timeout"));
    await expect(runPreparation(request)).rejects.toMatchObject({ code: "unreachable" });
    expect(mocks.api.cloudWorkspaceSuspend).toHaveBeenCalledTimes(2);
  });

  it("stops the machine on a cancel, and refuses a proposal for other repositories", async () => {
    const controller = new AbortController();
    client.listAgentTabs.mockImplementation(async () => {
      controller.abort();
      return [tab("in_progress")];
    });
    await expect(runPreparation(request, { signal: controller.signal })).rejects.toMatchObject({ code: "canceled" });
    expect(mocks.api.cloudWorkspaceSuspend).toHaveBeenCalledTimes(1);

    client.listAgentTabs.mockResolvedValue([tab("completed")]);
    mocks.readRemoteFile.mockResolvedValue({ text: JSON.stringify({ installScript: "", repositories: [{ owner: "evil", name: "other", setup: [] }] }) });
    await expect(runPreparation(request)).rejects.toMatchObject({ code: "bad-proposal" });
    expect(mocks.api.cloudWorkspaceSuspend).toHaveBeenCalledTimes(2);
  });

  it("keeps the agent's account labelled as the agent's when TerminalX could not run the commands", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.verifyProposal.mockRejectedValue(new Error("terminal lost"));
    const result = await runPreparation(request);
    quiet.mockRestore();
    expect(result.observations.observedBy).toBe("agent");
    expect(result.observations.repositories[0].checks[2]).toMatchObject({ kind: "test", status: "passed", exitCode: 0 });
    expect(result.stopped).toBe(true);
  });

  it("starts nothing more when the create is refused, and says a lost answer may have started a machine", async () => {
    mocks.api.cloudWorkspaceCreate.mockRejectedValueOnce({ code: "cloud_workspace_concurrency_exceeded" });
    await expect(runPreparation(request)).rejects.toMatchObject({ message: expect.stringMatching(/running limit/) });
    mocks.api.cloudWorkspaceCreate.mockRejectedValueOnce(new Error("network"));
    await expect(runPreparation(request)).rejects.toMatchObject({ message: expect.stringMatching(/may have been started/) });
    expect(mocks.retain).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
  });

  it("deletes a machine whose create failed or is still in flight, since it cannot be suspended", async () => {
    mocks.api.cloudWorkspaceCreate.mockResolvedValueOnce({ workspace, operation: { id: "op-1", state: "failed" } });
    mocks.api.cloudWorkspaceSuspend.mockRejectedValue({ code: "cloud_workspace_operation_in_progress" });
    await expect(runPreparation(request)).rejects.toBeInstanceOf(PreparationError);
    expect(mocks.api.cloudWorkspaceDelete).toHaveBeenCalledWith("workspace_1", true, "org-1");
    mocks.api.cloudWorkspaceSuspend.mockRejectedValue({ code: "cloud_provider_unavailable" });
    expect(await stopPreparation(workspace)).toBe(false);
  });
});

describe("terminalRunner", () => {
  it("writes the script to a file, runs it in a terminal of its own, and reports the terminal's exit code", async () => {
    client.attachPty.mockImplementationOnce(async (_id: string, handlers: { onExit: (code: number) => void }) => {
      queueMicrotask(() => handlers.onExit(3));
      return { detach: vi.fn() };
    });
    const run = terminalRunner(client as never);
    const result = await run("exit 3", 5000);
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(client.mutate).toHaveBeenCalledWith("fs.mkdir", { path: ".terminalx-verify" });
    expect(mocks.writeRemoteFile).toHaveBeenCalledWith(client, ".terminalx-verify/run-1.sh", "exit 3\n", undefined);
    // No command text is typed into the terminal: only the fixed line that runs the file.
    expect(client.write).toHaveBeenCalledWith("pty-1", "exec bash .terminalx-verify/run-1.sh\r");
    expect(client.killPty).toHaveBeenCalledWith("pty-1");
  });

  it("ends a command that outlives its time and reports a timeout, not an exit code", async () => {
    vi.useFakeTimers();
    try {
      client.attachPty.mockResolvedValueOnce({ detach: vi.fn() });
      const pending = terminalRunner(client as never)("sleep 999", 1000);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await pending).toMatchObject({ exitCode: null, timedOut: true });
      expect(client.killPty).toHaveBeenCalledWith("pty-1");
    } finally {
      vi.useRealTimers();
    }
  });
});
