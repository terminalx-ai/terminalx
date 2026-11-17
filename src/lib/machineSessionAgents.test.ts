import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuationContext } from "@terminalx/portable/continuation";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { MachinePr } from "@/lib/machineSessionBranch";

const mocks = vi.hoisted(() => ({ instructions: "" }));
vi.mock("@/lib/prefs", () => ({ getPrefs: () => ({ fixErrorsInstructions: mocks.instructions }) }));

const { agentsBlocked, continueMachineTab, failingChecksOf, fixMachineChecks, useMachineSessionChecks, useMachineSessionUsage } = await import("./machineSessionAgents");

const context = (patch: Partial<ContinuationContext> = {}): ContinuationContext => ({
  sessionId: "s1",
  tabId: "tab-1",
  title: "Work",
  provider: "claude",
  providerSessionId: "p-1",
  cwd: "/Users/me/code/api",
  sourceActive: false,
  transcriptPath: "/Users/me/.claude/projects/api/p-1.jsonl",
  fullUnavailableReason: null,
  lastPrompt: "Add the chip",
  lastUpdate: "Done",
  partialCapture: null,
  ...patch,
});

function pr(patch: Partial<MachinePr> = {}): MachinePr {
  return {
    number: 7,
    title: "Feature",
    url: "https://github.com/octo/app/pull/7",
    state: "OPEN",
    isDraft: false,
    base: "main",
    head: "feature",
    checks: [
      { name: "test", state: "failure", url: "https://github.com/octo/app/actions/runs/1/job/2", actions: { runId: 1, jobId: 2 } },
      { name: "lint", state: "success", url: "https://github.com/octo/app/actions/runs/3/job/4", actions: { runId: 3, jobId: 4 } },
      { name: "external", state: "failure", url: "https://ci.example.com/1" },
    ],
    ...patch,
  } as MachinePr;
}

let client: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.instructions = "";
  client = {
    hasCapability: vi.fn((capability: string) => capability === "machine/10"),
    prepareContinuation: vi.fn(async () => context()),
    checkFailures: vi.fn(async () => ({ path: "/Users/me/.raccoon/attachments/s1/checks.log", truncated: false })),
    sessionUsage: vi.fn(async () => ({ usage: { sessionId: "s1", title: "Work", tabs: [], models: [], total: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.42 }, estimate: true }, loginMethods: { claude: "Claude account" }, windows: [] })),
  };
});
const rpc = () => client as unknown as WorkspaceRpcClient;

describe("Continue in a new tab on a machine (PRO-408)", () => {
  it("reads the tab's context on the machine, adds the new tab there and sends it the prompt naming the machine's transcript", async () => {
    const order: string[] = [];
    const addTab = vi.fn(async () => (order.push("add"), "tab-2"));
    const send = vi.fn(async () => (order.push("send"), { events: [], queued: false }));
    const outcome = await continueMachineTab({ client: rpc(), sessionId: "s1", request: { sourceTabId: "tab-1", agent: "codex", model: "gpt-5" }, addTab, send });
    expect(client.prepareContinuation).toHaveBeenCalledWith("s1", "tab-1");
    expect(addTab).toHaveBeenCalledWith({ agent: "codex", model: "gpt-5", effort: undefined, mode: undefined });
    expect(order).toEqual(["add", "send"]);
    const [tabId, prompt] = send.mock.calls[0] as unknown as [string, string];
    expect(tabId).toBe("tab-2");
    expect(prompt).toContain("/Users/me/.claude/projects/api/p-1.jsonl");
    expect(outcome).toEqual({ tabId: "tab-2", queued: false });
  });

  it("adds no tab when the conversation has nothing to carry on", async () => {
    client.prepareContinuation.mockResolvedValue(context({ transcriptPath: null, partialCapture: null }));
    const addTab = vi.fn(async () => "tab-2");
    const send = vi.fn();
    await expect(continueMachineTab({ client: rpc(), sessionId: "s1", request: { sourceTabId: "tab-1", agent: "claude" }, addTab, send })).rejects.toThrow("No usable saved context");
    expect(addTab).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Fix check errors on a machine (PRO-408)", () => {
  it("names the open pull request's failed Actions runs, as the machine's git.prs read them", () => {
    const failing = failingChecksOf(pr())!;
    expect(failing.prUrl).toBe("https://github.com/octo/app/pull/7");
    expect(failing.checks.map((check) => check.name)).toEqual(["test"]);
    expect(failingChecksOf(pr({ state: "MERGED" }))).toBeNull();
    expect(failingChecksOf(pr({ checks: [{ name: "lint", state: "success", url: "u", actions: { runId: 3, jobId: 4 } }] }))).toBeNull();
    expect(failingChecksOf(null)).toBeNull();
  });

  it("saves the logs on the machine and sends the tab the prompt naming the machine's file", async () => {
    mocks.instructions = "Keep it small.";
    const send = vi.fn(async () => ({ events: [], queued: true }));
    const notice = await fixMachineChecks({ client: rpc(), name: "Mac mini", sessionId: "s1", tabId: "tab-1", prUrl: "https://github.com/octo/app/pull/7", instructions: "Keep it small.", send });
    expect(client.checkFailures).toHaveBeenCalledWith("s1", "tab-1", "https://github.com/octo/app/pull/7");
    const [, prompt] = send.mock.calls[0] as unknown as [string, string];
    expect(prompt).toContain("@/Users/me/.raccoon/attachments/s1/checks.log");
    expect(prompt).toContain("Keep it small.");
    expect(notice).toBe("Queued failed check logs to the agent on Mac mini.");
  });

  it("is the manager's, on a connected machine with machine/10, and defaults to the failing pull request", async () => {
    const send = vi.fn(async () => ({ events: [], queued: false }));
    const mount = (manage: boolean) => renderHook(() => useMachineSessionChecks({ client: rpc(), connected: true, manage, name: "Mac mini", sessionId: "s1", pr: pr(), send }));
    const managed = mount(true);
    expect(managed.result.current.served).toBe(true);
    expect(managed.result.current.failing?.prNumber).toBe(7);
    await act(async () => {
      await managed.result.current.fix("tab-1");
    });
    expect(client.checkFailures).toHaveBeenCalledWith("s1", "tab-1", "https://github.com/octo/app/pull/7");
    const viewer = mount(false);
    expect(viewer.result.current.blocked).toBe("Only a computer paired with Mac mini can use Fix check errors");
    await expect(viewer.result.current.fix("tab-1")).rejects.toThrow("Only a computer paired");
    expect(client.checkFailures).toHaveBeenCalledTimes(1);
  });

  it("says why it cannot run, naming the machine", () => {
    const ok = { name: "Mac mini", connected: true, served: true, manage: true, what: "Fix check errors" };
    expect(agentsBlocked(ok)).toBeNull();
    expect(agentsBlocked({ ...ok, connected: false })).toBe("Fix check errors works once Mac mini is back");
    expect(agentsBlocked({ ...ok, served: false })).toBe("Mac mini runs an older TerminalX. Update it to use Fix check errors from here.");
  });
});

describe("useMachineSessionUsage (the model's `usage`)", () => {
  it("reads the session's usage on the machine on connect and again when a turn ends", async () => {
    const { result, rerender } = renderHook((props: { working: boolean }) => useMachineSessionUsage({ client: rpc(), connected: true, sessionId: "s1", generation: "g1", working: props.working }), { initialProps: { working: false } });
    await waitFor(() => expect(result.current.read?.usage.total.costUsd).toBe(0.42));
    expect(result.current.read?.loginMethods).toEqual({ claude: "Claude account" });
    rerender({ working: true });
    rerender({ working: false });
    await waitFor(() => expect(client.sessionUsage).toHaveBeenCalledTimes(2));
  });

  it("reads nothing on a machine without machine/10", () => {
    client.hasCapability.mockReturnValue(false);
    const { result } = renderHook(() => useMachineSessionUsage({ client: rpc(), connected: true, sessionId: "s1", generation: "g1", working: false }));
    expect(result.current.served).toBe(false);
    expect(client.sessionUsage).not.toHaveBeenCalled();
  });
});
