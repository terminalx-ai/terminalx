import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { AgentTabInfo, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CachedTab, Checkpoint, OutboxEntry } from "@/lib/cloudAgentApi";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));

import {
  applyLiveTabs,
  attachCloudAgentTab,
  configureCloudAgentTab,
  decideCloudAgent,
  getCloudAgents,
  loadCloudAgents,
  refreshFromCheckpoint,
  resetCloudAgents,
  sendToCloudAgent,
  POLL_MAX_MS,
} from "./cloudAgents";
import { getTabLog } from "./agentEvents";

const scope = { organizationId: "org-1", workspaceId: "ws-1" };

const tabInfo = (fields: Partial<AgentTabInfo> = {}): AgentTabInfo => ({
  sessionId: "s-1",
  tabId: "t-1",
  title: null,
  harness: "claude",
  model: "",
  effort: null,
  permissionMode: "manual",
  status: "idle",
  process: "running",
  pendingPermissions: [],
  followUps: [],
  lastSeq: 0,
  created: "2026-09-29T00:00:00Z",
  modified: "2026-09-29T00:00:00Z",
  ...fields,
});

const ev = (seq: number, payload: Payload, sessionId = "s-1", tabId = "t-1"): AgentEvent => ({
  id: `${tabId}-e${seq}`,
  seq,
  sessionId,
  tabId,
  harness: "claude",
  ts: "2026-09-29T00:00:00Z",
  payload,
});

/** The Rust side of the mailbox, cache and checkpoints, as the spec describes it. */
class FakeBackend {
  calls: { cmd: string; args: Record<string, unknown> }[] = [];
  cache: Record<string, CachedTab> = {};
  metas: { tabId: string; epoch: number; version: number }[] = [];
  checkpoints: Record<string, Checkpoint> = {};
  outbox: OutboxEntry[] = [];
  /** What the next syncs report, one list per call. */
  syncs: OutboxEntry[][] = [];
  next = 0;

  handle = async (cmd: string, args: Record<string, unknown> = {}) => {
    this.calls.push({ cmd, args });
    switch (cmd) {
      case "cloud_agent_cache_load":
        return { tabs: this.cache };
      case "cloud_agent_cache_save":
        if (args.entry) this.cache[String(args.tabId)] = args.entry as CachedTab;
        else delete this.cache[String(args.tabId)];
        return undefined;
      case "cloud_agent_outbox":
        return this.outbox;
      case "cloud_agent_checkpoints":
        return this.metas;
      case "cloud_agent_checkpoint": {
        const found = this.checkpoints[String(args.tabId)];
        if (!found) return null;
        const after = args.afterEpoch == null ? null : { epoch: Number(args.afterEpoch), version: Number(args.afterVersion) };
        if (after && !(found.epoch > after.epoch || (found.epoch === after.epoch && found.version > after.version))) return null;
        return found;
      }
      case "cloud_agent_enqueue": {
        const payload = args.payload as Record<string, unknown>;
        const entry: OutboxEntry = {
          clientCommandId: `cmd-${++this.next}`,
          tabId: String(args.tabId),
          kind: args.kind as OutboxEntry["kind"],
          text: (payload.text as string) ?? null,
          requestId: (payload.requestId as string) ?? null,
          state: "queued",
          wake: "not-needed",
          createdAt: this.next,
          updatedAt: this.next,
        };
        this.outbox.push(entry);
        return entry;
      }
      case "cloud_agent_outbox_sync":
        return this.syncs.shift() ?? this.outbox;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  };

  count(cmd: string) {
    return this.calls.filter((call) => call.cmd === cmd).length;
  }
}

let backend: FakeBackend;

function fakeClient(connected = true) {
  const client = {
    connection: { state: connected ? "connected" : "suspended" },
    subscribeSession: vi.fn(async (_s: string, _t: string, _on: (event: unknown) => void, _options?: Record<string, unknown>) => () => undefined),
    nudgeMailbox: vi.fn(async () => undefined),
    markAgentTabRead: vi.fn(async () => undefined),
    configureAgentTab: vi.fn(async (params: Record<string, unknown>) => tabInfo({ model: String(params.model ?? "") })),
    listAgentTabs: vi.fn(async () => [] as AgentTabInfo[]),
    onNotification: vi.fn(() => () => undefined),
  };
  return client as typeof client & WorkspaceRpcClient;
}

beforeEach(() => {
  backend = new FakeBackend();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => backend.handle(cmd, args));
});

afterEach(() => {
  resetCloudAgents();
  vi.useRealTimers();
});

describe("cloud agent tabs store", () => {
  it("opens a tab from the cache, then a newer checkpoint, and never reads a checkpoint once it streams live", async () => {
    backend.cache["t-1"] = {
      tab: tabInfo(),
      events: [ev(1, { type: "user_message", text: "hi", queued: false }), ev(2, { type: "assistant_text", text: "hello" })],
      cursor: "7:2",
      checkpoint: { epoch: 7, version: 3 },
      unread: false,
      completed: false,
      updatedAt: 1,
    };
    backend.checkpoints["t-1"] = {
      epoch: 7,
      version: 5,
      projection: {
        v: 1,
        sessionId: "s-1",
        tabId: "t-1",
        title: "Fix the build",
        harness: "claude",
        model: "opus",
        effort: null,
        permissionMode: "manual",
        status: "completed",
        process: "exited",
        events: [ev(2, { type: "assistant_text", text: "hello" }), ev(3, { type: "user_message", text: "more", queued: false }), ev(4, { type: "assistant_text", text: "done" })],
        truncated: true,
        followUps: [],
        updatedAt: 10,
      },
    };
    await loadCloudAgents(scope);
    expect(backend.calls.map((c) => c.cmd)).toEqual(["cloud_agent_cache_load", "cloud_agent_outbox", "cloud_agent_checkpoints"]);
    expect(getTabLog("s-1", "t-1").events.map((e) => e.seq)).toEqual([1, 2]);

    expect(await refreshFromCheckpoint(scope, "t-1")).toBe(true);
    expect(backend.calls.at(-1)).toMatchObject({ cmd: "cloud_agent_checkpoint", args: { tabId: "t-1", afterEpoch: 7, afterVersion: 3 } });
    expect(getTabLog("s-1", "t-1").events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const tab = getCloudAgents(scope).tabs[0]!;
    expect(tab.info).toMatchObject({ title: "Fix the build", status: "completed", process: "exited" });
    expect(tab.unread).toBe(true);
    expect(tab.checkpoint).toEqual({ epoch: 7, version: 5 });
    // The same checkpoint again is not newer: nothing changes.
    expect(await refreshFromCheckpoint(scope, "t-1")).toBe(false);

    const client = fakeClient();
    await attachCloudAgentTab(scope, "t-1", client);
    expect(client.subscribeSession).toHaveBeenCalledWith("s-1", "t-1", expect.any(Function), expect.objectContaining({ sinceCursor: "7:2" }));
    const reads = backend.count("cloud_agent_checkpoint");
    expect(await refreshFromCheckpoint(scope, "t-1")).toBe(false);
    expect(backend.count("cloud_agent_checkpoint")).toBe(reads);
  });

  it("merges a live replay that overlaps the cache by seq instead of duplicating it", async () => {
    applyLiveTabs(scope, [tabInfo()]);
    const client = fakeClient();
    await attachCloudAgentTab(scope, "t-1", client);
    const onEvent = client.subscribeSession.mock.calls[0]![2];
    const onCursor = (client.subscribeSession.mock.calls[0]![3] as { onCursor: (cursor?: string) => void }).onCursor;
    for (const seq of [1, 2, 1, 2, 3]) onEvent(ev(seq, { type: "assistant_text", text: `line ${seq}` }));
    onCursor("8:3");
    expect(getTabLog("s-1", "t-1").events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(getCloudAgents(scope).tabs[0]!.cursor).toBe("8:3");
  });

  it("treats the runtime's tab list as authoritative and marks a finished tab unread", () => {
    applyLiveTabs(scope, [tabInfo(), tabInfo({ tabId: "t-2", sessionId: "s-2", created: "2026-09-29T00:00:01Z" })]);
    expect(getCloudAgents(scope).tabs.map((t) => t.tabId)).toEqual(["t-1", "t-2"]);
    applyLiveTabs(scope, [tabInfo({ status: "completed" })]);
    const tabs = getCloudAgents(scope).tabs;
    expect(tabs.map((t) => t.tabId)).toEqual(["t-1"]);
    expect(tabs[0]!.unread).toBe(true);
  });

  it("enqueues one decision per permission request, however often it is clicked", async () => {
    applyLiveTabs(scope, [tabInfo()]);
    const client = fakeClient();
    const decision = { requestId: "req-1", optionId: "allow" };
    const [first, second] = await Promise.all([decideCloudAgent(scope, "t-1", decision, client), decideCloudAgent(scope, "t-1", decision, client)]);
    expect(backend.count("cloud_agent_enqueue")).toBe(1);
    expect(first?.clientCommandId).toBe("cmd-1");
    expect(second).toBeNull();
    // A later click (or a reconnect's retry) returns the same command.
    expect((await decideCloudAgent(scope, "t-1", { requestId: "req-1", optionId: "deny" }, client))?.clientCommandId).toBe("cmd-1");
    expect(backend.count("cloud_agent_enqueue")).toBe(1);
    expect(backend.calls.find((c) => c.cmd === "cloud_agent_enqueue")!.args).toMatchObject({
      organizationId: "org-1",
      workspaceId: "ws-1",
      tabId: "t-1",
      kind: "permission-decision",
      payload: { requestId: "req-1", optionId: "allow" },
    });
    expect(client.nudgeMailbox).toHaveBeenCalledTimes(1);
  });

  it("polls the outbox until every command settled, backing off, and never resends one whose outcome is unknown", async () => {
    vi.useFakeTimers();
    applyLiveTabs(scope, [tabInfo()]);
    const entry = await sendToCloudAgent(scope, "t-1", "run the tests", null);
    expect(entry.state).toBe("queued");
    backend.syncs = [
      [{ ...entry, state: "queued" }],
      [{ ...entry, state: "queued" }],
      [{ ...entry, state: "outcome-unknown", updatedAt: 99 }],
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(backend.count("cloud_agent_outbox_sync")).toBe(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(backend.count("cloud_agent_outbox_sync")).toBe(3);
    expect(getCloudAgents(scope).outbox[0]!.state).toBe("outcome-unknown");
    await vi.advanceTimersByTimeAsync(POLL_MAX_MS * 4);
    expect(backend.count("cloud_agent_outbox_sync")).toBe(3);
    expect(backend.count("cloud_agent_enqueue")).toBe(1);
  });

  it("carries a model chosen while offline in the next message, and configures at once while connected", async () => {
    applyLiveTabs(scope, [tabInfo()]);
    await configureCloudAgentTab(scope, "t-1", { model: "opus", effort: "high" }, null);
    expect(getCloudAgents(scope).tabs[0]!.info).toMatchObject({ model: "opus", effort: "high" });
    await sendToCloudAgent(scope, "t-1", "go", null);
    expect(backend.calls.find((c) => c.cmd === "cloud_agent_enqueue")!.args.payload).toEqual({ text: "go", model: "opus", effort: "high" });
    await sendToCloudAgent(scope, "t-1", "again", null);
    expect(backend.calls.filter((c) => c.cmd === "cloud_agent_enqueue")[1]!.args.payload).toEqual({ text: "again" });

    const client = fakeClient();
    await configureCloudAgentTab(scope, "t-1", { model: "sonnet" }, client);
    expect(client.configureAgentTab).toHaveBeenCalledWith({ sessionId: "s-1", tabId: "t-1", model: "sonnet" });
  });
});
