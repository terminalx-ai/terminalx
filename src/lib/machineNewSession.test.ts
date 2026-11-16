import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcError, type MachineProject, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { MachineConnectionState } from "@/types/machines";

// PRO-348: the "Where it runs" rows, the project a machine draft starts on,
// and the create that runs on the machine once, however often it is resent.

const { newCloudAgentTab, selectCloudSession } = vi.hoisted(() => ({
  newCloudAgentTab: vi.fn(),
  selectCloudSession: vi.fn(),
}));
vi.mock("@/lib/cloudAgents", () => ({ newCloudAgentTab }));
vi.mock("@/lib/sessions", () => ({ selectCloudSession }));

const {
  CreateAttempt,
  agentSignIn,
  createMachineSession,
  machineCreateParams,
  machineWhereRow,
  memoryText,
  noSignedInAgent,
  pickMachineProject,
} = await import("./machineNewSession");

const NOW = new Date(2026, 10, 16, 15, 0).getTime();
const direct: MachineConnectionState = { state: "direct", route: { kind: "lan", endpoint: "ws://192.168.1.20:6768/machine/1" }, since: 1, rttMs: 4 };
const relay: MachineConnectionState = { state: "relay", route: { kind: "relay", endpoint: "wss://relay.example/machine/1" }, since: 1, rttMs: 40 } as MachineConnectionState;
const claude = { id: "claude", name: "Claude Code" };
const codex = { id: "codex", name: "Codex" };
const project = (name: string, fields: Partial<MachineProject> = {}) => ({ projectId: `p-${name}`, name, path: `/Users/dev/code/${name}`, archived: false, ...fields }) as MachineProject;

const row = (state: MachineConnectionState, fields: Partial<Parameters<typeof machineWhereRow>[0]> = {}) =>
  machineWhereRow({ state, machine: { lastSeenAt: null }, running: 3, freeBytes: 14_200_000_000, agents: [claude], projects: [project("raccoon")], wantedProject: "raccoon", ...fields }, NOW);

describe("Where it runs: a machine's row", () => {
  it("a connected machine: route, sessions running, memory free", () => {
    expect(row(direct)).toEqual({ enabled: true, detail: "Direct · 3 sessions running · 14 GB memory free" });
    expect(row(relay, { running: 1, freeBytes: 9_240_000_000 })).toEqual({ enabled: true, detail: "Relay · 1 session running · 9.2 GB memory free" });
    expect(row(direct, { running: 0, freeBytes: 8_000_000_000 }).detail).toBe("Direct · no sessions running · 8 GB memory free");
  });

  it("leaves out what the machine has not said yet", () => {
    expect(row(direct, { running: null, freeBytes: null }).detail).toBe("Direct");
    expect(row(direct, { agents: null, projects: null }).detail).toBe("Direct · 3 sessions running · 14 GB memory free");
  });

  it("says why it may not start a session, in place of the memory, and stays choosable", () => {
    expect(row(direct, { agents: [] })).toEqual({ enabled: true, detail: "Direct · 3 sessions running · no agent installed there" });
    expect(row(direct, { agents: [{ ...claude, signIn: "signedOut" }, { ...codex, signIn: "signedOut" }] }).detail).toBe("Direct · 3 sessions running · no agent signed in there");
    // One signed in, or a sign-in nobody reported, is no reason.
    expect(row(direct, { agents: [{ ...claude, signIn: "signedOut" }, { ...codex, signIn: "signedIn" }] }).detail).toMatch(/memory free$/);
    expect(row(direct, { agents: [{ ...claude, signIn: "unknown" }] }).detail).toMatch(/memory free$/);
    expect(row(direct, { projects: [project("api")] }).detail).toBe("Direct · 3 sessions running · raccoon is not a project there");
    expect(row(direct, { projects: [project("raccoon", { archived: true })], wantedProject: null }).detail).toBe("Direct · 3 sessions running · no projects there yet");
  });

  it("an offline machine cannot be chosen and says when it was last seen", () => {
    const seen = new Date(2026, 10, 16, 9, 41).getTime();
    const offline = row({ state: "offline", lastSeenAt: seen, retryInMs: 10_000 });
    expect(offline.enabled).toBe(false);
    expect(offline.detail).toMatch(/^Offline · last seen today at /);
    // The paired record's time when the connection has none.
    expect(machineWhereRow({ state: { state: "offline", lastSeenAt: null, retryInMs: 1 }, machine: { lastSeenAt: seen - 86_400_000 }, running: null, freeBytes: null, agents: null, projects: null, wantedProject: null }, NOW).detail).toMatch(/^Offline · last seen yesterday at /);
    expect(row({ state: "offline", lastSeenAt: null, retryInMs: 1 })).toEqual({ enabled: false, detail: "Offline · never reached from this Mac" });
  });

  it("a machine that needs an update, is updating, refuses this Mac or is not connected cannot be chosen, with why", () => {
    expect(row({ state: "needsUpdate", version: "0.2.20", side: "machine" })).toEqual({ enabled: false, detail: "Needs update · it runs an older TerminalX" });
    expect(row({ state: "needsUpdate", version: "0.2.40", side: "thisMac" })).toEqual({ enabled: false, detail: "Needs update · it runs a newer TerminalX than this Mac" });
    expect(row({ state: "updating", version: "0.2.34", since: 1 })).toEqual({ enabled: false, detail: "Updating · back in under a minute" });
    expect(row({ state: "accessRemoved" })).toEqual({ enabled: false, detail: "No longer allows this Mac · pair again in Settings → Machines" });
    expect(row({ state: "connecting", trying: ["lan"] })).toEqual({ enabled: false, detail: "Connecting…" });
    expect(row({ state: "reconnecting", lostAt: 1, attempt: 1, retryInMs: 1, trying: ["relay"] })).toEqual({ enabled: false, detail: "Reconnecting…" });
    expect(row({ state: "idle" })).toEqual({ enabled: false, detail: "Not connected" });
  });

  it("memory in decimal gigabytes, as the screen says it", () => {
    expect(memoryText(14_200_000_000)).toBe("14 GB");
    expect(memoryText(9_240_000_000)).toBe("9.2 GB");
    expect(memoryText(3_000_000_000)).toBe("3 GB");
    expect(noSignedInAgent(null)).toBeNull();
  });
});

describe("the machine draft's project and agent", () => {
  const projects = [project("archive", { archived: true }), project("api"), project("raccoon")];

  it("the one asked for, else the one named like the form's, else the first; never an archived one", () => {
    expect(pickMachineProject(projects, "p-api", "raccoon")?.name).toBe("api");
    expect(pickMachineProject(projects, null, "raccoon")?.name).toBe("raccoon");
    expect(pickMachineProject(projects, null, "elsewhere")?.name).toBe("api");
    expect(pickMachineProject(projects, "p-archive", "archive")?.name).toBe("api");
    expect(pickMachineProject([project("old", { archived: true })], null, null)).toBeNull();
  });

  it("reads the chosen agent's sign-in there, nothing when unknown", () => {
    expect(agentSignIn([{ ...claude, signIn: "signedIn" }], "claude")).toBe("signedIn");
    expect(agentSignIn([claude], "claude")).toBeNull();
    expect(agentSignIn(null, "claude")).toBeNull();
    expect(agentSignIn([claude], null)).toBeNull();
  });
});

describe("one create, once", () => {
  it("keeps the id while the request is the same and only a lost answer keeps it after", () => {
    let n = 0;
    const attempt = new CreateAttempt(() => `id-${++n}`);
    const request = { projectId: "p1", prompt: "Add read markers" };
    expect(attempt.idFor(request)).toBe("id-1");
    // The connection gave up before the answer: Create again is the same create.
    attempt.settle(new Error("connection closed"));
    expect(attempt.idFor({ ...request })).toBe("id-1");
    // An edited prompt is another create.
    expect(attempt.idFor({ ...request, prompt: "Add read markers to the list" })).toBe("id-2");
    // The runtime answered (a refusal): the next press is new.
    attempt.settle(new WorkspaceRpcError("invalid_params", "bad", "session.create"));
    expect(attempt.idFor(request)).toBe("id-3");
    attempt.settle(null);
    expect(attempt.idFor(request)).toBe("id-4");
    attempt.reset();
    expect(attempt.idFor(request)).toBe("id-5");
  });
});

describe("creating the session on the machine", () => {
  const client = (capabilities: string[]) => ({ hasCapability: (name: string) => capabilities.includes(name) }) as unknown as WorkspaceRpcClient;
  const request = {
    machineId: "m-1",
    projectId: "p-raccoon",
    agent: "claude",
    model: "opus",
    effort: "high",
    mode: "bypassPermissions",
    prompt: "Work on PRO-12",
    title: "PRO-12 Read markers",
    useWorktree: true,
    worktreeName: "pro-12-read-markers",
    baseRef: "release/2",
    issue: { ref: { provider: "linear" as const, id: "i-12", identifier: "PRO-12", title: "Read markers", url: "https://linear.app/x/issue/PRO-12" }, body: "Mark read", pipeline: true },
  };

  beforeEach(() => {
    newCloudAgentTab.mockReset().mockResolvedValue({ tabId: "t-9", sessionId: "s-9", pipeline: null, pipelineNote: null, startError: null });
    selectCloudSession.mockReset();
  });

  it("creates with the machine's project id and the kept request id, then opens the machine session", async () => {
    const rpc = client(["pipeline/1", "session-base/1"]);
    const created = await createMachineSession(rpc, request, "req-1");
    expect(newCloudAgentTab).toHaveBeenCalledWith({ organizationId: "", workspaceId: "machine:m-1" }, rpc, {
      ...machineCreateParams(request),
      clientRequestId: "req-1",
    });
    expect(newCloudAgentTab.mock.calls[0][2]).toMatchObject({ projectId: "p-raccoon", useWorktree: true, worktreeName: "pro-12-read-markers", baseRef: "release/2", issue: request.issue.ref, issueBody: "Mark read", pipeline: true });
    expect(created).toEqual({ key: "machine:m-1:p-raccoon:s-9", sessionId: "s-9", tabId: "t-9", startError: null, pipelineNote: null });
    expect(selectCloudSession).toHaveBeenCalledWith("machine:m-1:p-raccoon:s-9");
  });

  it("sends no issue to a machine without pipelines, and no worktree name or base without a worktree", async () => {
    await createMachineSession(client([]), { ...request, useWorktree: false }, "req-2", { select: false });
    const params = newCloudAgentTab.mock.calls[0][2];
    expect(params).not.toHaveProperty("issue");
    expect(params).not.toHaveProperty("issueBody");
    expect(params).not.toHaveProperty("pipeline");
    expect(params).toMatchObject({ useWorktree: false, worktreeName: null, baseRef: null });
    expect(selectCloudSession).not.toHaveBeenCalled();
  });

  it("the same request makes the same parameters, so its digest holds across presses", () => {
    expect(machineCreateParams(request)).toEqual(machineCreateParams({ ...request }));
    expect(machineCreateParams({ ...request, model: "" })).not.toHaveProperty("model", "");
  });
});
