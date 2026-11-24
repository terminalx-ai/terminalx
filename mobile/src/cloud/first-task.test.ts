import { describe, expect, it } from "vitest";
import { CloudApiError } from "./api";
import { RUNTIME_PICKUP_MS, TASK_PHASES, agentLoginFailure, launchOf, taskAgent, taskAgents, taskFacts, taskFailure, taskProgress, taskSettled, taskTooLong, taskUnderWay } from "./first-task";
import { codexLogin, claudeKey, githubToken, operation, workspace } from "./testing/server";
import { account } from "./testing/account";

// PRO-547 (25.09): the first task's own rules, apart from the screens.
describe("the agents a first task can start", () => {
  it("are the ticked agent logins, by the runtime's name, once each, never GitHub", () => {
    expect(taskAgents([codexLogin, githubToken, claudeKey, { ...claudeKey, displayIdentity: "second" }] as never)).toEqual([
      { id: "codex", label: "Codex", detail: "alex@example.com" },
      { id: "claude", label: "Claude Code", detail: expect.any(String) },
    ]);
  });

  it("keep the chosen one while it is ticked, and otherwise fall to the first", () => {
    const agents = taskAgents([codexLogin, claudeKey] as never);
    expect(taskAgent("claude", agents)?.id).toBe("claude");
    expect(taskAgent("cursor", agents)?.id).toBe("codex");
    expect(taskAgent(null, [])).toBeNull();
  });
});

describe("the launch a first task sends", () => {
  const agents = taskAgents([codexLogin, claudeKey] as never);

  it("always names a mode a phone may send, leaves the model to the agent, and drops a blank prompt", () => {
    expect(launchOf({ agent: "claude", mode: "plan", text: "Fix it" }, agents)).toEqual({ v: 1, agent: "claude", mode: "plan", prompt: "Fix it" });
    expect(launchOf({ agent: "claude", mode: "bypassPermissions" as never, text: " \n " }, agents)).toEqual({ v: 1, agent: "claude", mode: "manual" });
    expect(launchOf({ agent: "claude", mode: "auto", text: "x" }, [])).toBeUndefined();
  });

  it("is at most 32 KB, counted in UTF-8 bytes as the server counts them", () => {
    expect(taskTooLong("a".repeat(32 * 1024))).toBe(false);
    expect(taskTooLong("a".repeat(32 * 1024 + 1))).toBe(true);
    expect(taskTooLong("é".repeat(16 * 1024 + 1))).toBe(true);
  });

  it("is refused by the client before anything is sent when it breaks the server's parser", async () => {
    const { api, calls } = account();
    for (const launch of [{ v: 1, agent: "Claude", mode: "manual" }, { v: 1, agent: "claude", mode: "bypassPermissions" }, { v: 1, agent: "claude", mode: "manual", prompt: "" }, { v: 1, agent: "claude", mode: "manual", prompt: "a\u0000b" }, { v: 1, agent: "claude", mode: "manual", effort: "High" }]) {
      await expect(api.createWorkspace("org-1", { name: "x", quoteId: "q", confirmProviderSpend: true, launch: launch as never }, globalThis.crypto.randomUUID())).rejects.toBeInstanceOf(CloudApiError);
    }
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("is listed in the review in full, with None for no task", () => {
    expect(taskFacts({ v: 1, agent: "codex", mode: "acceptEdits", prompt: "Line one\nLine two" })).toEqual([
      { label: "Agent", value: "Codex" }, { label: "Model", value: "Agent’s default" }, { label: "Permission mode", value: "Accept edits" }, { label: "Task", value: "Line one\nLine two", block: true },
    ]);
    expect(taskFacts({ v: 1, agent: "claude", model: "opus", effort: "high", mode: "manual" }).slice(1, 2)).toEqual([{ label: "Model", value: "opus · high" }]);
    expect(taskFacts({ v: 1, agent: "claude", mode: "manual" }).at(-1)).toEqual({ label: "Task", value: "None" });
  });
});

describe("why a first task did not start", () => {
  it("is one of the desktop's sentences for every category the runtime and server report", () => {
    const said = Object.fromEntries(["agent-unavailable", "agent-start-failed", "agent-model-unavailable", "repository-clone-failed", "repository-access-denied", "repository-branch-not-found", "repository-clone-timed-out", "repository-path-occupied", "repository-empty", "workspace-disk-full", "repository-sync-failed", "branch-create-failed", "runtime-interrupted", "runtime-storage-replaced", "payload-invalid", "launch-intent-unavailable", "runtime-unsupported", "prompt-send-failed"].map((category) => [category, taskFailure({ state: "failed", category })]));
    expect(said).toMatchObject({
      "agent-unavailable": "The agent is not installed in the workspace image.",
      "repository-empty": "The repository has no commits yet, so there is nothing to start from.",
      "runtime-unsupported": "This workspace's runtime cannot start agents from a first prompt, so it was not sent. Open the workspace to start the agent yourself.",
      "prompt-send-failed": "The agent started, but the first task may not have reached it.",
    });
    for (const sentence of Object.values(said)) expect(sentence).not.toBe("The agent did not start.");
  });

  it("names the agent's login for every login category, in the phone's own place for fixing it", () => {
    for (const category of ["agent-sign-in-required", "agent_credential_expired", "credential-revoked", "credential_reauth"]) {
      expect(agentLoginFailure(category)).toBe(true);
      expect(taskFailure({ state: "failed", category })).toMatch(/^The agent has no working login in this workspace.*An owner or admin can see which in Agent logins\.$/);
    }
    expect(agentLoginFailure("repository-empty")).toBe(false);
  });

  it("says the prompt expired, and never shows a code it does not know", () => {
    expect(taskFailure({ state: "expired" })).toBe("The workspace took too long to start, and its first prompt expired.");
    expect(taskFailure({ state: "failed", category: "brand-new-category" })).toBe("The agent did not start.");
    expect(taskFailure({ state: "failed" })).toBe("The agent did not start.");
  });
});

describe("where a launch with a first task stands", () => {
  const at = (launch: Record<string, unknown>, op: Record<string, unknown> = {}, ws: Record<string, unknown> = {}, now = 1_795_000_300_000) =>
    taskProgress({ workspace: workspace({ launch, ...ws }) as never, operation: operation(op) as never }, 0, now);

  it("follows the server's phase, and has the six rows the board draws", () => {
    expect(TASK_PHASES).toEqual(["Creating the machine", "Installing the runtime", "Connecting to the runtime", "Syncing the repository", "Starting the agent", "Running"]);
    expect(at({ phase: "allocating", state: "pending" }, { stage: "preflight" })).toMatchObject({ phase: "launching", stage: 0, detail: "Checking the provider", cancelable: true });
    expect(at({ phase: "syncing-repository", state: "claimed" }, { state: "succeeded" }, { state: "ready" })).toMatchObject({ phase: "starting", stage: 3, cancelable: false });
    expect(at({ phase: "starting-agent", state: "claimed", agent: "claude", model: "opus" }, { state: "succeeded" }, { state: "ready" })).toMatchObject({ stage: 4, detail: "Claude Code · opus" });
    expect(at({ phase: "running", state: "started", hasPrompt: true }, { state: "succeeded" }, { state: "ready" })).toMatchObject({ phase: "running", stage: 5, status: "finished", hasPrompt: true });
  });

  it("puts the cross where the launch stopped, from its timings", () => {
    expect(at({ phase: "failed", state: "failed", category: "repository-empty", timings: { syncingAt: 1 } }, { state: "succeeded" })).toMatchObject({ phase: "task-failed", stage: 3, detail: "The repository has no commits yet, so there is nothing to start from." });
    expect(at({ phase: "failed", state: "pending", timings: { bootingAt: 1 } }, { state: "failed", stage: "bootstrapping" })).toMatchObject({ phase: "failed", stage: 1 });
  });

  it("is settled once it runs, failed, or was canceled; not while it goes on", () => {
    expect(taskSettled({ phase: "starting" })).toBe(false);
    expect(taskSettled({ phase: "canceling" })).toBe(false);
    for (const phase of ["running", "task-failed", "task-unsure", "failed", "canceled"] as const) expect(taskSettled({ phase })).toBe(true);
  });

  it("warns after two minutes with the task unclaimed in a running workspace", () => {
    const launch = { phase: "authenticating-runtime", state: "pending", timings: { requestedAt: 0, authenticatingAt: 1_000 } };
    expect(at(launch, { state: "succeeded" }, { state: "ready" }, 1_000 + RUNTIME_PICKUP_MS - 1).notPickedUp).toBe(false);
    expect(at(launch, { state: "succeeded" }, { state: "ready" }, 1_000 + RUNTIME_PICKUP_MS).notPickedUp).toBe(true);
  });

  it("keeps a listed workspace on its launch page while its task is on its way, not forever", () => {
    expect(taskUnderWay({ phase: "syncing-repository", state: "claimed" }, 0)).toBe(true);
    expect(taskUnderWay({ phase: "authenticating-runtime", state: "pending", timings: { requestedAt: 0 } }, RUNTIME_PICKUP_MS)).toBe(true);
    expect(taskUnderWay({ phase: "authenticating-runtime", state: "pending", timings: { requestedAt: 0 } }, 2 * RUNTIME_PICKUP_MS)).toBe(false);
    expect(taskUnderWay({ phase: "running", state: "started" }, 0)).toBe(false);
    expect(taskUnderWay(null, 0)).toBe(false);
  });
});
