import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { AgentTabInfo, WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CachedTab, Checkpoint, OutboxEntry } from "@/lib/cloudAgentApi";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/models", () => ({
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "manual", label: "Ask every time", hint: "" }],
  useModels: () => [],
}));
// The composer's own behaviour is covered by Composer.test; here it only needs to send and stop.
vi.mock("@/components/chat/Composer", () => ({
  Composer: (props: { draft: string; busy: boolean; onDraftChange: (v: string) => void; onSend: (t: string, i: unknown[]) => Promise<void>; onStop: () => void; disabledReason?: string | null }) => (
    <div>
      {props.disabledReason && <p>{props.disabledReason}</p>}
      <textarea aria-label="Prompt" value={props.draft} onChange={(e) => props.onDraftChange(e.target.value)} />
      <button onClick={() => void props.onSend(props.draft, []).then(() => props.onDraftChange(""), () => undefined)}>{props.busy ? "Queue" : "Send"}</button>
      {props.busy && <button onClick={props.onStop}>Stop</button>}
    </div>
  ),
}));

// jsdom has no canvas for the chat's idle animation.
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));

import { CloudAgentsView } from "./CloudAgents";
import { resetCloudAgents } from "@/lib/cloudAgents";
import { TooltipProvider } from "@/components/ui/tooltip";

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

let cache: Record<string, CachedTab>;
let checkpoints: Record<string, Checkpoint>;
let outbox: OutboxEntry[];
let enqueued: Record<string, unknown>[];

function backend(cmd: string, args: Record<string, unknown> = {}) {
  switch (cmd) {
    case "cloud_agent_cache_load":
      return Promise.resolve({ tabs: cache });
    case "cloud_agent_cache_save":
      return Promise.resolve();
    case "cloud_agent_outbox":
    case "cloud_agent_outbox_sync":
      return Promise.resolve(outbox);
    case "cloud_agent_checkpoints":
      return Promise.resolve(Object.values(checkpoints).map((c) => ({ tabId: c.projection.tabId, epoch: c.epoch, version: c.version })));
    case "cloud_agent_checkpoint":
      return Promise.resolve(checkpoints[String(args.tabId)] ?? null);
    case "cloud_agent_enqueue": {
      enqueued.push(args);
      const payload = args.payload as Record<string, unknown>;
      const entry: OutboxEntry = {
        clientCommandId: `cmd-${enqueued.length}`,
        tabId: String(args.tabId),
        kind: args.kind as OutboxEntry["kind"],
        text: (payload.text as string) ?? null,
        requestId: (payload.requestId as string) ?? null,
        state: "queued",
        wake: "queued",
        createdAt: 1,
        updatedAt: 1,
      };
      outbox = [...outbox, entry];
      return Promise.resolve(entry);
    }
    default:
      return Promise.reject(new Error(`unexpected ${cmd}`));
  }
}

let liveTabs: AgentTabInfo[];
let streams: Record<string, AgentEvent[]>;
const connected = (fields: Partial<Extract<WorkspaceConnectionState, { state: "connected" }>> = {}): WorkspaceConnectionState => ({
  state: "connected",
  runtimeGeneration: 7,
  runtimeEpoch: "e1",
  runtimeVersion: "0.2.2",
  capabilities: ["session/1", "keys/1"],
  authority: "manage",
  ...fields,
});

function makeClient() {
  return {
    connection: { state: "connected" } as WorkspaceConnectionState,
    listAgentTabs: vi.fn(async () => liveTabs),
    onNotification: vi.fn(() => () => undefined),
    subscribeSession: vi.fn(async (sessionId: string, tabId: string, onEvent: (e: unknown) => void) => {
      for (const event of streams[`${sessionId}/${tabId}`] ?? []) onEvent(event);
      return () => undefined;
    }),
    nudgeMailbox: vi.fn(async () => undefined),
    markAgentTabRead: vi.fn(async () => undefined),
    configureAgentTab: vi.fn(),
    createAgentTab: vi.fn(),
    closeAgentTab: vi.fn(async () => ({ sessionId: "s-1" })),
  };
}
let client: ReturnType<typeof makeClient>;

function view(state: WorkspaceConnectionState, workspaceState: string | null = "ready", wake = vi.fn()) {
  client.connection = state;
  return (
    <TooltipProvider>
      <CloudAgentsView scope={scope} client={client as unknown as WorkspaceRpcClient} state={state} workspaceState={workspaceState} wakeWorkspace={wake} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  cache = {};
  checkpoints = {};
  outbox = [];
  enqueued = [];
  liveTabs = [];
  streams = {};
  client = makeClient();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => backend(cmd, args));
});

afterEach(() => {
  cleanup();
  resetCloudAgents();
});

describe("cloud agent tabs", () => {
  it("shows a sleeping workspace's chat from cache and checkpoint without attaching, and attaches once the runtime is online", async () => {
    cache["t-1"] = {
      tab: tabInfo({ title: "Refactor" }),
      events: [ev(1, { type: "user_message", text: "cached question", queued: false })],
      cursor: null,
      checkpoint: { epoch: 7, version: 1 },
      unread: false,
      completed: false,
      updatedAt: 1,
    };
    checkpoints["t-1"] = {
      epoch: 7,
      version: 2,
      projection: {
        v: 1,
        sessionId: "s-1",
        tabId: "t-1",
        title: "Refactor",
        harness: "claude",
        model: "",
        effort: null,
        permissionMode: "manual",
        status: "idle",
        process: "exited",
        events: [ev(1, { type: "user_message", text: "cached question", queued: false }), ev(2, { type: "assistant_text", text: "answer from the checkpoint" })],
        truncated: false,
        followUps: [],
        updatedAt: 5,
      },
    };
    const { rerender } = render(view({ state: "suspended" }, "suspended"));
    expect(await screen.findByText("cached question")).toBeTruthy();
    expect(await screen.findByText("answer from the checkpoint")).toBeTruthy();
    const order = mocks.invoke.mock.calls.map(([cmd]) => cmd);
    expect(order.indexOf("cloud_agent_cache_load")).toBeLessThan(order.indexOf("cloud_agent_checkpoint"));
    expect(client.subscribeSession).not.toHaveBeenCalled();
    expect(client.listAgentTabs).not.toHaveBeenCalled();
    expect(screen.getByTestId("cloud-agent-connection").textContent).toContain("Offline");
    expect(screen.getByTestId("cloud-agent-provisioning").textContent).toContain("Asleep");

    liveTabs = [tabInfo({ title: "Refactor", lastSeq: 3 })];
    streams["s-1/t-1"] = [ev(3, { type: "assistant_text", text: "live answer" })];
    rerender(view(connected()));
    expect(await screen.findByText("live answer")).toBeTruthy();
    expect(client.subscribeSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cloud-agent-connection").textContent).toContain("Live");
  });

  it("keeps two agent tabs' conversations and states apart", async () => {
    liveTabs = [
      tabInfo({ status: "in_progress" }),
      tabInfo({ sessionId: "s-2", tabId: "t-2", harness: "codex", created: "2026-09-29T00:00:01Z" }),
    ];
    streams["s-1/t-1"] = [ev(1, { type: "user_message", text: "first agent's task", queued: false })];
    streams["s-2/t-2"] = [ev(1, { type: "user_message", text: "second agent's task", queued: false }, "s-2", "t-2")];
    render(view(connected()));
    const tabs = await screen.findAllByTestId("cloud-agent-tab");
    expect(tabs.map((t) => t.textContent)).toEqual([expect.stringContaining("Claude 1"), expect.stringContaining("Codex 2")]);
    expect(await screen.findByText("first agent's task")).toBeTruthy();
    expect(screen.getByTestId("cloud-agent-turn").textContent).toContain("Working");
    fireEvent.click(within(tabs[1]!).getByRole("tab"));
    expect(await screen.findByText("second agent's task")).toBeTruthy();
    expect(screen.queryByText("first agent's task")).toBeNull();
    expect(screen.getByTestId("cloud-agent-turn").textContent).toContain("Idle");
  });

  it("sends through the mailbox, and a message whose fate is unknown is only sent again when asked", async () => {
    liveTabs = [tabInfo()];
    outbox = [
      { clientCommandId: "old-1", tabId: "t-1", kind: "send", text: "deploy it", state: "outcome-unknown", createdAt: 1, updatedAt: 1 },
      { clientCommandId: "old-2", tabId: "t-1", kind: "send", text: "not delivered", state: "rejected", category: "tab-unknown", createdAt: 1, updatedAt: 1 },
    ];
    render(view(connected()));
    const unknown = await screen.findByText("May not have been sent");
    expect(screen.getByText("Not delivered (tab-unknown)")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enqueued).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(enqueued).toHaveLength(1));
    expect(enqueued[0]).toMatchObject({ organizationId: "org-1", workspaceId: "ws-1", tabId: "t-1", kind: "send", payload: { text: "hello" } });
    expect(client.nudgeMailbox).toHaveBeenCalled();
    expect(await screen.findByText("Queued for the workspace")).toBeTruthy();

    fireEvent.click(within(unknown.closest("li")!).getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(enqueued).toHaveLength(2));
    expect(enqueued[1]).toMatchObject({ kind: "send", payload: { text: "deploy it" } });
  });

  it("answers a permission request once, however often it is clicked", async () => {
    liveTabs = [tabInfo({ status: "waiting" })];
    streams["s-1/t-1"] = [
      ev(1, { type: "user_message", text: "clean up", queued: false }),
      ev(2, {
        type: "permission_requested",
        requestId: "req-9",
        toolUseId: "tool-1",
        toolName: "Bash",
        input: { command: "rm -rf build" },
        options: [
          { id: "allow", label: "Allow", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      }),
    ];
    render(view(connected()));
    const allow = await screen.findByRole("button", { name: /^Allow/ });
    fireEvent.click(allow);
    fireEvent.click(allow);
    await waitFor(() => expect(enqueued).toHaveLength(1));
    expect(enqueued[0]).toMatchObject({ kind: "permission-decision", payload: { requestId: "req-9", optionId: "allow" } });
    await waitFor(() => expect((screen.getByRole("button", { name: /^Allow/ }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enqueued).toHaveLength(1);
  });

  it("shows follow-ups the runtime holds until the turn ends, and steers or stops the running turn", async () => {
    liveTabs = [tabInfo({ status: "in_progress", followUps: [{ clientCommandId: "cmd-f", text: "then run the linter" }] })];
    render(view(connected()));
    const followUp = await screen.findByTestId("cloud-agent-followup");
    expect(followUp.textContent).toContain("then run the linter");
    expect(followUp.textContent).toContain("sends when the agent finishes");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "use pnpm instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer now" }));
    await waitFor(() => expect(enqueued[0]).toMatchObject({ kind: "steer", payload: { text: "use pnpm instead" } }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(enqueued[1]).toMatchObject({ kind: "stop", payload: {} }));
  });

  it("says so honestly when the agent process ended mid-turn", async () => {
    liveTabs = [tabInfo({ status: "in_progress", process: "exited" })];
    streams["s-1/t-1"] = [ev(1, { type: "user_message", text: "long task", queued: false })];
    render(view(connected()));
    const notice = await screen.findByTestId("cloud-agent-exited");
    expect(notice.textContent).toContain("Agent process ended — the saved conversation resumes on your next message");
    expect(screen.getByTestId("cloud-agent-turn").textContent).toContain("Process ended mid-turn");
    // Not shown as still working: no stop button, a plain send.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("wakes a sleeping workspace only after an interactive command, and reports the wake", async () => {
    cache["t-1"] = { tab: tabInfo(), events: [], cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1 };
    const wake = vi.fn();
    render(view({ state: "suspended" }, "suspended", wake));
    await screen.findByLabelText("Prompt");
    expect(wake).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(client.nudgeMailbox).not.toHaveBeenCalled();
    expect(screen.getByTestId("cloud-agent-provisioning").textContent).toContain("Waking");
  });

  it("marks a finished tab read when it is opened and shows other finished tabs as unread", async () => {
    liveTabs = [tabInfo({ status: "completed" }), tabInfo({ sessionId: "s-2", tabId: "t-2", status: "completed", created: "2026-09-29T00:00:01Z" })];
    render(view(connected()));
    await waitFor(() => expect(client.markAgentTabRead).toHaveBeenCalledWith("s-1", "t-1"));
    const tabs = await screen.findAllByTestId("cloud-agent-tab");
    await waitFor(() => expect(within(tabs[0]!).queryByTestId("cloud-agent-unread")).toBeNull());
    expect(within(tabs[1]!).getByTestId("cloud-agent-unread")).toBeTruthy();
  });

  it("asks this device to connect once when it has no key for the workspace", async () => {
    liveTabs = [tabInfo()];
    render(view(connected()));
    await screen.findByLabelText("Prompt");
    mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "cloud_agent_enqueue" ? Promise.reject("cloud_agent_key_missing") : backend(cmd, args),
    );
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Connect to this workspace once/)).toBeTruthy();
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("hi");
    act(() => undefined);
  });
});
