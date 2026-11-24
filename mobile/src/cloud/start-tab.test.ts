import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcError, type RuntimeAgent, type RuntimeAgentsReport } from "@terminalx/portable/workspace";
import type { CloudCommand, CloudWorkspace } from "./api";
import { b64, type CommandEnvelope } from "./crypto";
import { NOW, pairingCode, Refusal, Runtime, SILENT } from "./fake-runtime";
import {
  chooseAgent, chooseModel, conversationTitle, initialStartChoices, keepsRequest, START_WORDS, startAgents, startFailure, startOffer, startParams, startRows,
} from "./start-tab";
import { outboxLine } from "./words";
import { CloudWorkspaceSession } from "./workspace";

const model = (id: string, label: string, fields: Partial<RuntimeAgent["models"][number]> = {}) => ({ id, label, efforts: [] as string[], defaultEffort: null, isDefault: false, ...fields }) as RuntimeAgent["models"][number];
const CLAUDE: RuntimeAgent = {
  id: "claude", name: "Claude Code", caps: {} as never, defaultMode: "bypassPermissions", signIn: "signedIn",
  modes: ["plan", "manual", "auto", "acceptEdits", "bypassPermissions"],
  models: [model("opus", "Opus", { isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" }), model("sonnet", "Sonnet", { efforts: ["low", "medium"], defaultEffort: "medium" })],
};
const CODEX: RuntimeAgent = { id: "codex", name: "Codex", caps: {} as never, defaultMode: "bypassPermissions", modes: [], models: [] };
const REPORT: RuntimeAgentsReport = { agents: [CODEX, CLAUDE, { ...CLAUDE, id: "gemini", name: "Gemini", signIn: "signedOut" }], missing: [{ id: "opencode", name: "OpenCode" } as never] };

describe("what the start sheet offers (25.10)", () => {
  it("offers pickable agents first, then one not signed in and one not installed, both with their reason and not pickable", () => {
    const agents = startAgents(REPORT);
    expect(agents.map((agent) => [agent.name, agent.blocked, agent.detail])).toEqual([
      ["Codex", null, null],
      ["Claude Code", null, START_WORDS.signedIn],
      ["Gemini", "Not signed in in this workspace", "Not signed in in this workspace"],
      ["OpenCode", "Not installed in this workspace", "Not installed in this workspace"],
    ]);
    // Bypass permissions is never offered, whoever lists it.
    expect(agents[1]!.modes).toEqual(["plan", "manual", "auto", "acceptEdits"]);
  });

  it("opens on the first pickable agent's defaults and Ask every time, never the runtime's default mode", () => {
    const agents = startAgents({ agents: [CLAUDE], missing: null });
    const choices = initialStartChoices(agents);
    expect(choices).toEqual({ agent: "claude", model: "opus", effort: "high", mode: "manual" });
    expect(startRows(agents, choices)).toEqual({ agent: "Claude Code", model: "Opus", effort: "High", mode: "Ask every time" });
  });

  it("an agent with no models, efforts or modes reads Agent's default, and has no Effort or Permission mode row; its request still names a mode", () => {
    const agents = startAgents({ agents: [CODEX], missing: null });
    const choices = initialStartChoices(agents);
    expect(startRows(agents, choices)).toEqual({ agent: "Codex", model: null, effort: null, mode: null });
    expect(startParams(agents, choices)).toEqual({ agent: "codex", mode: "manual" });
  });

  it("changing the model keeps an effort the new one offers and otherwise takes its default; an agent not signed in changes nothing", () => {
    const agents = startAgents(REPORT);
    let choices = chooseAgent(agents, initialStartChoices(agents), "claude");
    choices = { ...choices, effort: "low", mode: "plan" };
    expect(chooseModel(agents, choices, "sonnet")).toMatchObject({ model: "sonnet", effort: "low" });
    expect(chooseModel(agents, { ...choices, effort: "xhigh" }, "sonnet")).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(chooseAgent(agents, choices, "gemini")).toBe(choices);
    // The mode is kept from agent to agent where the new one lists it.
    expect(chooseAgent(agents, choices, "codex")).toEqual({ agent: "codex", model: "", effort: null, mode: "manual" });
  });

  it("never sends bypass or no mode, whatever the choices hold", () => {
    const agents = startAgents({ agents: [CLAUDE], missing: null });
    const sent = startParams(agents, { agent: "claude", model: "opus", effort: "high", mode: "bypassPermissions" as never });
    expect(sent).toEqual({ agent: "claude", model: "opus", effort: "high", mode: "manual" });
    expect(() => startParams(agents, { agent: null, model: "", effort: null, mode: "manual" })).toThrow();
  });

  it("names a conversation after the first line of its message, as the runtime names a launched tab, else the next Agent number", () => {
    expect(conversationTitle("Fix the login bug\nthen push", 0)).toBe("Fix the login bug");
    expect(conversationTitle("   ", 1)).toBe("Agent 2");
    const long = "x".repeat(90);
    expect(conversationTitle(long, 0)).toBe(`${"x".repeat(79)}…`);
  });

  it("says who may start: a manager on a runtime with canStart, a too-old runtime, someone who may not, and nothing while not known", () => {
    const up = { state: "connected" } as never;
    expect(startOffer(up, { userId: "u", role: "manager", canApprove: true, canStart: true }, null)).toBe("yes");
    expect(startOffer(up, { userId: "u", role: "manager", canApprove: true }, null)).toBe("old");
    expect(startOffer(up, { userId: "u", role: "manager", canApprove: true, canStart: false }, null)).toBe("no");
    expect(startOffer(up, { userId: "u", role: "driver", canApprove: true, canStart: false }, null)).toBe("no");
    expect(startOffer(up, { userId: "u", role: "none", canApprove: false, listed: false }, "manager")).toBeNull();
    expect(startOffer({ state: "stopped" } as never, null, "manager")).toBeNull();
  });

  it("words each failure from the wording table, and asks again with the same request only when no answer came", () => {
    const refused = startFailure(new WorkspaceRpcError("forbidden", "session.create needs a workspace manager", "session.create", { role: "driver" }), true);
    expect(refused).toEqual({ kind: "refused", text: "Only this workspace's creator or an organization owner or admin can do that." });
    expect(startFailure(new WorkspaceRpcError("invalid_params", "x", "session.create", { reason: "mode-required" }), true).text).toBe("That did not work. Try again in a moment.");
    const silent = startFailure(new Error("RPC timed out: session.create"), true);
    expect(silent).toEqual({ kind: "no-answer", text: "No answer came back. Try again: nothing is started twice." });
    expect(startFailure(new Error("RPC transport unavailable"), false)).toEqual({ kind: "offline", text: "Not connected to this workspace." });
    expect([refused, silent].map(keepsRequest)).toEqual([false, true]);
  });

  it("says a message for a tab that is gone was not sent", () => {
    expect(outboxLine({ state: "rejected", category: "tab-unknown" } as never)).toEqual({ tone: "warn", text: START_WORDS.gone });
  });
});

// ---- against the fake runtime ---------------------------------------------------

const scope = { organizationId: "org-1", workspaceId: "ws-1" };
const key = new Uint8Array(randomBytes(32));

function harness(you: Record<string, unknown>) {
  const listed = { id: "ws-1", orgId: "org-1", name: "fix-login", provider: "box", state: "ready", you: { role: "manager", canApprove: true } } as CloudWorkspace;
  const runtimes: Runtime[] = [];
  const posted: CommandEnvelope[] = [];
  let tabs = [{ sessionId: "s1", tabId: "t1", title: "Fix login", harness: "claude", status: "idle", pendingPermissions: [] }];
  const command = (envelope: CommandEnvelope, state = "queued"): CloudCommand => ({ clientCommandId: envelope.clientCommandId, tabId: envelope.tabId, kind: envelope.kind, state, keyId: envelope.keyId, createdAt: 1, updatedAt: 1 });
  const api = {
    open: vi.fn(async () => ({ id: "a1", workspaceId: "ws-1", state: "ready" as const, authority: "participate" as const, expiresAt: NOW + 600_000, pairingCode: pairingCode(), attachTicket: { v: 1 as const, token: "attach-jwt", expiresAt: NOW + 60_000, runtimeGeneration: 3, protocol: "terminalx-workspace-rpc/1" as const } })),
    enqueue: vi.fn(async (_org: string, _ws: string, envelope: CommandEnvelope) => (posted.push(envelope), { command: command(envelope), existing: false, wake: "not-needed" })),
    commandStatuses: vi.fn(async (): Promise<CloudCommand[]> => []),
    cancelCommand: vi.fn(async (_org: string, _ws: string, id: string) => command(posted.find((sent) => sent.clientCommandId === id)!, "cancelled")),
    checkpoints: vi.fn(async () => []),
    checkpoint: vi.fn(async () => null),
  };
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {};
  const blobs = new Map<string, string>();
  const secrets = new Map<string, string>();
  const session = new CloudWorkspaceSession({
    scope,
    api: api as never,
    secrets: { get: async (name) => secrets.get(name) ?? null, set: async (name, value) => void secrets.set(name, value), delete: async (name) => void secrets.delete(name) },
    storage: { getItem: async (name) => blobs.get(name) ?? null, setItem: async (name, value) => void blobs.set(name, value), removeItem: async (name) => void blobs.delete(name) },
    listed: () => listed,
    clientInstallationId: "install-1",
    appVersion: "0.1.0",
    link: {
      now: () => NOW,
      createSocket: (url) => {
        const runtime = new Runtime();
        runtime.url = url;
        runtime.you = you;
        runtime.methods = {
          "keys.get": () => ({ currentKeyId: "k1", keys: [{ keyId: "k1", key: b64(key), createdAt: 1, retiredAt: null }] }),
          "session.tabs": () => ({ tabs }),
          "session.subscribe": () => ({ subscriptionId: "sub-1", events: [], cursor: "c0" }),
          "session.nudge": () => ({}),
          "runtime.agents": () => ({ agents: [CLAUDE, CODEX] }),
          ...answers,
        };
        runtimes.push(runtime);
        queueMicrotask(() => runtime.onopen?.());
        return runtime as never;
      },
    },
  });
  const sent = (method: string) => runtimes.flatMap((runtime) => runtime.requests).filter((request) => request.method === method).map((request) => request.params as Record<string, unknown>);
  return { session, api, runtimes, answers, sent, setTabs: (next: typeof tabs) => (tabs = next) };
}

const live = (h: ReturnType<typeof harness>) => vi.waitFor(() => expect(h.session.getSnapshot().tabs[0]?.source).toBe("live"));
const MANAGER = { userId: "u-me", role: "manager", canApprove: true, canStart: true };

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("starting from the phone in a running workspace (PRO-546's calls)", () => {
  it("reads canStart from the hello, and a runtime that sends none is too old", async () => {
    const h = harness(MANAGER);
    await h.session.start();
    await live(h);
    expect(h.session.getSnapshot().startOffer).toBe("yes");
    h.session.close();

    const old = harness({ userId: "u-me", role: "manager", canApprove: true });
    await old.session.start();
    await live(old);
    expect(old.session.getSnapshot().startOffer).toBe("old");
    old.session.close();
  });

  it("reads the agents from runtime.agents", async () => {
    const h = harness(MANAGER);
    await h.session.start();
    await live(h);
    expect((await h.session.startAgents()).map((agent) => agent.id)).toEqual(["claude", "codex"]);
    h.session.close();
  });

  it("starts a conversation with session.create in the narrow form: agent, model, effort, mode, title, prompt and the request id; the new tab shows at once", async () => {
    const h = harness(MANAGER);
    h.answers["session.create"] = () => ({ sessionId: "s2", tabId: "t2", tab: { sessionId: "s2", tabId: "t2", title: "Fix the login bug", status: "in_progress" }, startError: null });
    await h.session.start();
    await live(h);
    const started = await h.session.startConversation({ agent: "claude", model: "opus", effort: "high", mode: "manual" }, { title: "Fix the login bug", prompt: "Fix the login bug" }, "req-1");
    expect(started).toEqual({ sessionId: "s2", tabId: "t2", promptNotSent: false });
    expect(h.sent("session.create")).toEqual([{ agent: "claude", model: "opus", effort: "high", mode: "manual", title: "Fix the login bug", prompt: "Fix the login bug", clientRequestId: "req-1" }]);
    expect(h.session.getSnapshot().tabs.map((tab) => [tab.tabId, tab.title])).toContainEqual(["t2", "Fix the login bug"]);
    h.session.close();
  });

  it("sends no prompt for an empty first message, and says when the runtime could not send the first message", async () => {
    const h = harness(MANAGER);
    h.answers["session.create"] = (params) => ({ sessionId: "s2", tabId: "t2", tab: null, startError: params.prompt ? "The session was created, but its first prompt could not be sent: agent exited" : null });
    await h.session.start();
    await live(h);
    await h.session.startConversation({ agent: "codex", mode: "manual" }, { title: "Agent 2", prompt: "  " }, "req-1");
    expect(h.sent("session.create")[0]).toEqual({ agent: "codex", mode: "manual", title: "Agent 2", clientRequestId: "req-1" });
    expect(await h.session.startConversation({ agent: "codex", mode: "manual" }, { title: "Go", prompt: "Go" }, "req-2")).toMatchObject({ promptNotSent: true });
    h.session.close();
  });

  it("adds a tab with session.addTab: the session, agent, settings and request id, no title and no prompt", async () => {
    const h = harness(MANAGER);
    h.answers["session.addTab"] = () => ({ sessionId: "s1", tabId: "t3", session: {}, tab: { sessionId: "s1", tabId: "t3", title: null, status: "idle" } });
    await h.session.start();
    await live(h);
    expect(await h.session.addAgentTab("s1", { agent: "claude", model: "sonnet", effort: "low", mode: "plan" }, "req-9")).toEqual({ sessionId: "s1", tabId: "t3" });
    expect(h.sent("session.addTab")).toEqual([{ sessionId: "s1", agent: "claude", model: "sonnet", effort: "low", mode: "plan", clientRequestId: "req-9" }]);
    // No title of its own: the strip names it by its place ("Agent 2").
    expect(h.session.getSnapshot().tabs.find((tab) => tab.tabId === "t3")?.title).toBeNull();
    h.session.close();
  });

  it("a refusal from the runtime is a refusal: worded for who may, and the next try is a new request", async () => {
    const h = harness(MANAGER);
    h.answers["session.create"] = () => new Refusal("forbidden", "session.create needs a workspace manager", { role: "driver" });
    await h.session.start();
    await live(h);
    const error = await h.session.startConversation({ agent: "claude", mode: "manual" }, { title: "x", prompt: "x" }, "req-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceRpcError);
    expect(startFailure(error, true)).toEqual({ kind: "refused", text: START_WORDS.refused });
    h.answers["session.create"] = () => new Refusal("invalid_params", "mode is required", { reason: "mode-required" });
    h.session.close();
  });

  it("no answer: said so, and asking again resends the same request id, which the runtime answers with what it started", async () => {
    const h = harness(MANAGER);
    let calls = 0;
    h.answers["session.create"] = () => (++calls === 1 ? SILENT : { sessionId: "s2", tabId: "t2", tab: null, startError: null });
    await h.session.start();
    await live(h);
    const first = h.session.startConversation({ agent: "claude", mode: "manual" }, { title: "x", prompt: "x" }, "req-1").catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(31_000);
    const error = await first;
    expect(startFailure(error, true).kind).toBe("no-answer");
    await h.session.startConversation({ agent: "claude", mode: "manual" }, { title: "x", prompt: "x" }, "req-1");
    // The client may itself have sent it again meanwhile: every send is the one request.
    const ids = h.sent("session.create").map((params) => params.clientRequestId);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids)).toEqual(new Set(["req-1"]));
    h.session.close();
  });
});

describe("a tab that is gone (25.10)", () => {
  it("stays while this phone holds a message for it, and leaves when that message is let go", async () => {
    const h = harness(MANAGER);
    await h.session.start();
    await live(h);
    const entry = await h.session.send("t1", "Run the tests");
    // Closed from elsewhere: the runtime no longer names it.
    h.setTabs([]);
    h.runtimes[0]!.encrypted({ event: "session.tabs", params: { tabs: [] } });
    await vi.waitFor(() => expect(h.session.getSnapshot().tabs[0]).toMatchObject({ tabId: "t1", gone: true }));
    await h.session.cancel(entry.clientCommandId);
    await h.session.dismiss(entry.clientCommandId);
    expect(h.session.getSnapshot().tabs).toEqual([]);
    h.session.close();
  });

  it("a tab closed with nothing held for it simply goes", async () => {
    const h = harness(MANAGER);
    await h.session.start();
    await live(h);
    h.runtimes[0]!.encrypted({ event: "session.tabs", params: { tabs: [] } });
    await vi.waitFor(() => expect(h.session.getSnapshot().tabs).toEqual([]));
    h.session.close();
  });
});
