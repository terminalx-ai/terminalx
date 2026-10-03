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
  settledStatus,
  attachCloudAgentTab,
  configureCloudAgentTab,
  configuresLive,
  decideCloudAgent,
  DEV_SCOPE_NOTICE,
  discardPendingConfig,
  flushCloudAgentCache,
  getCloudAgents,
  loadCloudAgents,
  markCloudAgentsOffline,
  reconcileCloudAgents,
  refreshFromCheckpoint,
  resetCloudAgents,
  SAVE_DEBOUNCE_MS,
  sendToCloudAgent,
  steerCloudAgent,
  stopCloudAgent,
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

function fakeClient(connected = true, connection: Record<string, unknown> = {}) {
  const client = {
    // A manage attachment unless a test says who is behind the connection.
    connection: { state: connected ? "connected" : "suspended", authority: "manage", ...connection },
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

  it("never shows an agent that cannot sign in as working (PRO-78)", async () => {
    const signIn = { provider: "claude", state: "not-connected" };
    applyLiveTabs(scope, [tabInfo({ status: "in_progress", signIn })]);
    expect(getCloudAgents(scope).tabs[0]!.info).toMatchObject({ status: "idle", signIn });
    // A status event from the stream says "in progress" too: the prompt went to a sign-in screen.
    const client = fakeClient();
    await attachCloudAgentTab(scope, "t-1", client);
    const { onStatus } = client.subscribeSession.mock.calls[0]![3] as { onStatus: (change: { status: string }) => void };
    onStatus({ status: "in_progress" });
    expect(getCloudAgents(scope).tabs[0]!.info.status).toBe("idle");
    // Once the login is connected the same reports mean what they say.
    applyLiveTabs(scope, [tabInfo({ status: "in_progress" })]);
    expect(getCloudAgents(scope).tabs[0]!.info.status).toBe("in_progress");
    expect(settledStatus({ signIn }, "waiting")).toBe("waiting");
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

  it("sends an approver's setting change with their next message instead of a live configure the runtime would refuse", async () => {
    applyLiveTabs(scope, [tabInfo()]);
    // A driver who may approve, on a participate attachment: `session.configure` needs manage.
    const approver = fakeClient(true, { authority: "participate", you: { userId: "u-bob", role: "driver", canApprove: true } });
    expect(configuresLive(approver)).toBe(false);
    await configureCloudAgentTab(scope, "t-1", { mode: "acceptEdits" }, approver);
    expect(approver.configureAgentTab).not.toHaveBeenCalled();
    // The picker shows what was chosen, and the tab says it is still waiting for a message.
    expect(getCloudAgents(scope).tabs[0]).toMatchObject({ info: { permissionMode: "acceptEdits" }, pendingConfig: { mode: "acceptEdits" } });
    // The runtime's next tab list (still the old mode) does not snap the picker back.
    applyLiveTabs(scope, [tabInfo()]);
    expect(getCloudAgents(scope).tabs[0]!.info.permissionMode).toBe("acceptEdits");

    await sendToCloudAgent(scope, "t-1", "go", approver);
    expect(backend.calls.find((c) => c.cmd === "cloud_agent_enqueue")!.args.payload).toEqual({ text: "go", mode: "acceptEdits" });
    expect(getCloudAgents(scope).tabs[0]!.pendingConfig).toBeNull();
    // Once it went out, the runtime's word is shown again.
    applyLiveTabs(scope, [tabInfo({ permissionMode: "acceptEdits" })]);
    expect(getCloudAgents(scope).tabs[0]!.info.permissionMode).toBe("acceptEdits");
  });

  it("says so when the runtime ignored a message's settings, and stops promising them", async () => {
    vi.useFakeTimers();
    applyLiveTabs(scope, [tabInfo()]);
    const approver = fakeClient(true, { authority: "participate", you: { userId: "u-bob", role: "driver", canApprove: true } });
    await configureCloudAgentTab(scope, "t-1", { mode: "acceptEdits" }, approver);
    const entry = await sendToCloudAgent(scope, "t-1", "go", approver);
    expect(getCloudAgents(scope).tabs[0]).toMatchObject({ pendingConfig: null });
    expect(getCloudAgents(scope).tabs[0]!.settingsIgnored).toBeFalsy();
    // Approval was revoked before the runtime applied it: the receipt says the settings were ignored.
    backend.syncs = [[{ ...entry, state: "applied", updatedAt: 50, receipt: { settingsIgnored: true } }]];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCloudAgents(scope).tabs[0]!.settingsIgnored).toBe(true);
    // The runtime's own mode is what the picker shows again.
    applyLiveTabs(scope, [tabInfo()]);
    expect(getCloudAgents(scope).tabs[0]!.info.permissionMode).toBe(tabInfo().permissionMode);
    // The same receipt seen again says nothing new once the notice is gone.
    await configureCloudAgentTab(scope, "t-1", { mode: "plan" }, approver);
    expect(getCloudAgents(scope).tabs[0]).toMatchObject({ settingsIgnored: false, pendingConfig: { mode: "plan" } });
    backend.syncs = [[{ ...entry, state: "applied", updatedAt: 51, receipt: { settingsIgnored: true } }]];
    await sendToCloudAgent(scope, "t-1", "again", approver);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCloudAgents(scope).tabs[0]!.settingsIgnored).toBeFalsy();
  });

  it("drops an unsent setting change, with the notice, for someone who may no longer make it", async () => {
    applyLiveTabs(scope, [tabInfo()]);
    await configureCloudAgentTab(scope, "t-1", { model: "opus" }, null);
    discardPendingConfig(scope, "t-1");
    expect(getCloudAgents(scope).tabs[0]).toMatchObject({ pendingConfig: null, settingsIgnored: true });
    await sendToCloudAgent(scope, "t-1", "go", null);
    // The message goes without settings the runtime would only ignore.
    expect(backend.calls.find((c) => c.cmd === "cloud_agent_enqueue")!.args.payload).toEqual({ text: "go" });
    // Nothing pending: nothing to drop, nothing to say.
    resetCloudAgents();
    applyLiveTabs(scope, [tabInfo()]);
    discardPendingConfig(scope, "t-1");
    expect(getCloudAgents(scope).tabs[0]!.settingsIgnored).toBeFalsy();
  });

  it("configures live only for a manage attachment whose person is still a manager", () => {
    expect(configuresLive(null)).toBe(false);
    expect(configuresLive(fakeClient(false))).toBe(false);
    expect(configuresLive(fakeClient())).toBe(true);
    expect(configuresLive(fakeClient(true, { you: { userId: "u-a", role: "manager", canApprove: true } }))).toBe(true);
    // A demoted admin's lingering manage attachment, and every participate one.
    expect(configuresLive(fakeClient(true, { you: { userId: "u-a", role: "driver", canApprove: true } }))).toBe(false);
    expect(configuresLive(fakeClient(true, { authority: "participate" }))).toBe(false);
    // No member list yet: the attachment decides, as before sharing existed.
    expect(configuresLive(fakeClient(true, { you: { userId: "u-a", role: "none", canApprove: false, listed: false } }))).toBe(true);
  });

  it("keeps an offline setting across a restart, and a change made while a send is queued goes with the next one", async () => {
    vi.useFakeTimers();
    applyLiveTabs(scope, [tabInfo()]);
    await configureCloudAgentTab(scope, "t-1", { model: "opus" }, null);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(backend.cache["t-1"]!.pendingConfig).toEqual({ model: "opus" });

    // The app restarts: the cache brings the unsent setting back.
    resetCloudAgents();
    await loadCloudAgents(scope);
    expect(getCloudAgents(scope).tabs[0]!.pendingConfig).toEqual({ model: "opus" });

    // A change lands while the send is being enqueued: it is not dropped.
    let release!: () => void;
    const original = backend.handle;
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "cloud_agent_enqueue") await new Promise<void>((resolve) => (release = resolve));
      return original(cmd, args);
    });
    const sending = sendToCloudAgent(scope, "t-1", "go", null);
    await vi.advanceTimersByTimeAsync(0);
    await configureCloudAgentTab(scope, "t-1", { effort: "high" }, null);
    release();
    await sending;
    expect(backend.calls.find((c) => c.cmd === "cloud_agent_enqueue")!.args.payload).toEqual({ text: "go", model: "opus" });
    expect(getCloudAgents(scope).tabs[0]!.pendingConfig).toEqual({ model: "opus", effort: "high" });
  });

  it("runs one outbox polling loop per workspace however many commands are sent while a sync is in flight", async () => {
    vi.useFakeTimers();
    applyLiveTabs(scope, [tabInfo()]);
    let inFlight = 0;
    let maxInFlight = 0;
    const original = backend.handle;
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== "cloud_agent_outbox_sync") return original(cmd, args);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      inFlight--;
      return original(cmd, args);
    });
    await sendToCloudAgent(scope, "t-1", "one", null);
    await vi.advanceTimersByTimeAsync(1_000); // the first sync starts and hangs for 5 s
    await sendToCloudAgent(scope, "t-1", "two", null);
    await sendToCloudAgent(scope, "t-1", "three", null);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(maxInFlight).toBe(1);
    const syncs = backend.count("cloud_agent_outbox_sync");
    // One chain: at most one sync per (5 s sync + its delay) window.
    expect(syncs).toBeLessThanOrEqual(4);
  });

  it("keeps the process state when a status change does not carry it", async () => {
    applyLiveTabs(scope, [tabInfo({ process: "exited" })]);
    const client = fakeClient();
    await attachCloudAgentTab(scope, "t-1", client);
    const onStatus = (client.subscribeSession.mock.calls[0]![3] as { onStatus: (change: Record<string, unknown>) => void }).onStatus;
    onStatus({ sessionId: "s-1", tabId: "t-1", status: "in_progress" });
    expect(getCloudAgents(scope).tabs[0]!.info).toMatchObject({ status: "in_progress", process: "exited" });
  });

  it("merges by event id, and a saved event replaces an unsaved indicator whose seq a restarted runtime reused", async () => {
    applyLiveTabs(scope, [tabInfo()]);
    const client = fakeClient();
    await attachCloudAgentTab(scope, "t-1", client);
    const onEvent = client.subscribeSession.mock.calls[0]![2];
    onEvent(ev(1, { type: "assistant_text", text: "hello" }));
    onEvent({ ...ev(2, { type: "usage_update", inputTokens: 1 } as unknown as Payload), id: "usage-before-restart" });
    // The runtime restarted: its next saved event takes seq 2, and the full resync replays seq 1 again.
    onEvent(ev(1, { type: "assistant_text", text: "hello" }));
    onEvent({ ...ev(2, { type: "status", text: "The workspace runtime restarted" }), id: "status-after-restart" });
    const events = getTabLog("s-1", "t-1").events;
    expect(events.map((e) => e.id)).toEqual(["t-1-e1", "status-after-restart"]);
  });

  it("sends over live RPC for a development runtime and refuses what needs the mailbox", async () => {
    const dev = { organizationId: "", workspaceId: "dev-runtime" };
    await loadCloudAgents(dev);
    expect(backend.calls).toEqual([]);
    applyLiveTabs(dev, [tabInfo()]);
    const client = Object.assign(fakeClient(), { mutate: vi.fn(async () => ({})) });
    const entry = await sendToCloudAgent(dev, "t-1", "hello", client);
    expect(client.mutate).toHaveBeenCalledWith("session.send", { sessionId: "s-1", tabId: "t-1", text: "hello" });
    expect(entry.state).toBe("applied");
    await expect(steerCloudAgent(dev, "t-1", "x", client)).rejects.toThrow(DEV_SCOPE_NOTICE);
    await expect(stopCloudAgent(dev, "t-1", client)).rejects.toThrow(DEV_SCOPE_NOTICE);
    await expect(decideCloudAgent(dev, "t-1", { requestId: "r", optionId: "allow" }, client)).rejects.toThrow(DEV_SCOPE_NOTICE);
    await flushCloudAgentCache(dev);
    expect(backend.calls).toEqual([]);
  });

  // Found in a live two-user test: a pane kept "chunk 98 of 150 / Working" long after the turn had finished.
  describe("a turn that finished while this desktop was away", () => {
    const projection = (status: AgentTabInfo["status"], events: AgentEvent[]): Checkpoint["projection"] => ({
      v: 1,
      sessionId: "s-1",
      tabId: "t-1",
      title: null,
      harness: "claude",
      model: "",
      effort: null,
      permissionMode: "manual",
      status,
      process: "running",
      events,
      truncated: false,
      followUps: [],
      updatedAt: 10,
    });

    it("takes the finished turn from the checkpoint once the connection is gone, never while it is up", async () => {
      applyLiveTabs(scope, [tabInfo({ status: "in_progress", lastSeq: 2 })]);
      backend.checkpoints["t-1"] = { epoch: 7, version: 5, projection: projection("completed", [ev(2, { type: "assistant_text", text: "chunk 98" }), ev(3, { type: "assistant_text", text: "chunk 150" })]) };
      // Connected: the runtime's own word is newer than any checkpoint.
      await refreshFromCheckpoint(scope, "t-1");
      expect(getCloudAgents(scope).tabs[0]!.info.status).toBe("in_progress");
      // The connection went away: that status is only the last one known.
      backend.checkpoints["t-1"] = { ...backend.checkpoints["t-1"]!, version: 6 };
      markCloudAgentsOffline(scope);
      expect(await refreshFromCheckpoint(scope, "t-1")).toBe(true);
      const tab = getCloudAgents(scope).tabs[0]!;
      expect(tab.info.status).toBe("completed");
      expect(tab.unread).toBe(true);
      expect(getTabLog("s-1", "t-1").events.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("never goes back to an older checkpoint's status", async () => {
      applyLiveTabs(scope, [tabInfo({ status: "in_progress", lastSeq: 9 })]);
      markCloudAgentsOffline(scope);
      // Taken before the turn this desktop saw start: its "completed" is the turn before.
      backend.checkpoints["t-1"] = { epoch: 7, version: 5, projection: projection("completed", [ev(4, { type: "assistant_text", text: "the turn before" })]) };
      await refreshFromCheckpoint(scope, "t-1");
      expect(getCloudAgents(scope).tabs[0]!.info.status).toBe("in_progress");
    });

    it("never takes the status of an empty checkpoint, or of one behind the transcript held here", async () => {
      // The runtime's tab list said seq 2; the transcript streamed here went on to seq 6.
      applyLiveTabs(scope, [tabInfo({ status: "in_progress", lastSeq: 2 })]);
      const client = fakeClient();
      client.subscribeSession.mockImplementation(async (_s, _t, onEvent) => {
        for (const seq of [3, 4, 5, 6]) onEvent(ev(seq, { type: "assistant_text", text: `chunk ${seq}` }));
        return () => undefined;
      });
      (await attachCloudAgentTab(scope, "t-1", client))();
      markCloudAgentsOffline(scope);
      // No events to tell by: its "completed" may be any turn's.
      backend.checkpoints["t-1"] = { epoch: 7, version: 5, projection: projection("completed", []) };
      await refreshFromCheckpoint(scope, "t-1");
      expect(getCloudAgents(scope).tabs[0]!.info.status).toBe("in_progress");
      // Past the tab list's seq (2) but behind the transcript (6): still older than what was seen.
      backend.checkpoints["t-1"] = { epoch: 7, version: 6, projection: projection("completed", [ev(4, { type: "assistant_text", text: "chunk 4" })]) };
      await refreshFromCheckpoint(scope, "t-1");
      expect(getCloudAgents(scope).tabs[0]!.info.status).toBe("in_progress");
      // As far as the transcript: its status is the newer one.
      backend.checkpoints["t-1"] = { epoch: 7, version: 7, projection: projection("completed", [ev(6, { type: "assistant_text", text: "chunk 6" }), ev(7, { type: "assistant_text", text: "chunk 7" })]) };
      await refreshFromCheckpoint(scope, "t-1");
      expect(getCloudAgents(scope).tabs[0]!.info.status).toBe("completed");
    });

    it("on a connect, takes each tab's status from the runtime and the tail of a tab nothing streams from its checkpoint", async () => {
      applyLiveTabs(scope, [tabInfo({ status: "in_progress", lastSeq: 2 }), tabInfo({ tabId: "t-2", status: "in_progress", lastSeq: 1 })]);
      markCloudAgentsOffline(scope);
      backend.checkpoints["t-1"] = { epoch: 7, version: 5, projection: projection("completed", [ev(2, { type: "assistant_text", text: "chunk 98" }), ev(3, { type: "assistant_text", text: "chunk 150" })]) };
      const client = fakeClient();
      // The open tab streams live: it replays from its cursor, not from a checkpoint.
      await attachCloudAgentTab(scope, "t-2", client);
      client.listAgentTabs.mockResolvedValue([tabInfo({ status: "completed", lastSeq: 3 }), tabInfo({ tabId: "t-2", status: "idle", lastSeq: 8 })]);
      await reconcileCloudAgents(scope, client);
      const tabs = getCloudAgents(scope).tabs;
      expect(tabs.map((tab) => [tab.tabId, tab.info.status])).toEqual([["t-1", "completed"], ["t-2", "idle"]]);
      expect(getTabLog("s-1", "t-1").events.map((e) => e.seq)).toEqual([2, 3]);
      expect(backend.calls.filter((call) => call.cmd === "cloud_agent_checkpoint").map((call) => call.args.tabId)).toEqual(["t-1"]);
    });
  });
});
