import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { AgentTabInfo, WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CachedTab, Checkpoint, OutboxEntry } from "@/lib/cloudAgentApi";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  EFFORT_LABEL: {},
  DEFAULT_PERMISSION_MODE: "bypassPermissions",
  PERMISSION_MODES: [
    { id: "manual", label: "Ask every time", hint: "" },
    { id: "bypassPermissions", label: "Bypass permissions", hint: "" },
  ],
  useModels: () => [],
}));
import { CloudAgentSessions, agentSessionRows, signInAgain, signInMessage } from "./CloudAgents";
import { resetCloudAgents } from "@/lib/cloudAgents";
import { resetCollab } from "@/lib/cloudCollab";
import { resetPeople } from "@/lib/cloudPeople";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BypassDialog } from "@/components/session/BypassDialog";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { refreshHarnesses } from "@/lib/sessions";
import type { HarnessInfo } from "@/types/session";

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

// Claude Code is not installed on this computer; the workspace runs it.
const HARNESSES = [
  { id: "claude", name: "Claude Code", available: false },
  { id: "codex", name: "Codex", available: true },
] as HarnessInfo[];

function backend(cmd: string, args: Record<string, unknown> = {}) {
  switch (cmd) {
    case "list_harnesses":
      return Promise.resolve(HARNESSES);
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
        // The mailbox stamps a command when it takes it: after anything already in it.
        createdAt: Date.now(),
        updatedAt: Date.now(),
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

type Answer = (params: Record<string, unknown>) => unknown;
let answers: Record<string, Answer>;
const notificationListeners = new Set<(notification: { event: string; params: Record<string, unknown> }) => void>();

function makeClient() {
  return {
    connection: { state: "connected" } as WorkspaceConnectionState,
    hasCapability(capability: string): boolean {
      const state = this.connection;
      return state.state === "connected" && (state.capabilities as readonly string[] | undefined ?? []).includes(capability);
    },
    onState: () => () => {},
    listRuntimeAgents: vi.fn(async (): Promise<import("@terminalx/portable/workspace").RuntimeAgent[]> => []),
    listAgentTabs: vi.fn(async () => liveTabs),
    onNotification: vi.fn((listener: (notification: { event: string; params: Record<string, unknown> }) => void) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    }),
    call: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      const answer = answers[method];
      return answer ? answer(params) : {};
    }),
    mutate: vi.fn(async (method: string, params: Record<string, unknown>, _clientRequestId?: string) => {
      const answer = answers[method];
      return answer ? answer(params) : {};
    }),
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

/** Where a session row sends the reader: the shared session view (#1289). */
let openSession: ReturnType<typeof vi.fn<(sessionId: string, tabId: string | null) => void>>;

function view(state: WorkspaceConnectionState, workspaceState: string | null = "ready") {
  client.connection = state;
  return (
    <TooltipProvider>
      <CloudAgentSessions scope={scope} client={client as unknown as WorkspaceRpcClient} state={state} workspaceState={workspaceState} onOpenSession={openSession} />
    </TooltipProvider>
  );
}

beforeEach(async () => {
  cache = {};
  checkpoints = {};
  outbox = [];
  enqueued = [];
  liveTabs = [];
  streams = {};
  client = makeClient();
  openSession = vi.fn<(sessionId: string, tabId: string | null) => void>();
  answers = {};
  notificationListeners.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => backend(cmd, args));
  await refreshHarnesses();
  setPrefs({ lastAgent: "claude", lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", bypassConfirmed: false });
});

afterEach(() => {
  cleanup();
  resetCloudAgents();
  resetCollab();
  resetPeople();
  vi.useRealTimers();
});

const runtimeModel = { efforts: [] as string[], defaultEffort: null as string | null, acceptsImages: true, upgrade: null, description: null, isDefault: false };
/** What the workspace's own CLIs offer (`agents/1`). */
const RUNTIME_AGENTS = [
  {
    id: "claude", name: "Claude Code", caps: {}, modes: [], defaultMode: "bypassPermissions",
    models: [
      { ...runtimeModel, id: "opus", label: "Opus", alias: true, resolved: "claude-opus-4-6", isDefault: true, efforts: ["low", "high", "max"], defaultEffort: "high" },
      { ...runtimeModel, id: "sonnet", label: "Sonnet", alias: true, efforts: ["low", "high"], defaultEffort: "high" },
      { ...runtimeModel, id: "haiku", label: "Haiku", alias: true },
      { ...runtimeModel, id: "claude-opus-4-6", label: "Opus 4.6" },
    ],
  },
  {
    id: "codex", name: "Codex", caps: {}, modes: [], defaultMode: "bypassPermissions",
    models: [
      { ...runtimeModel, id: "gpt-6-astra", label: "GPT-6 Astra", isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { ...runtimeModel, id: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["medium", "high"], defaultEffort: "high" },
    ],
  },
];

/** Open one of the shared launch pickers by its title and choose an item. */
async function choose(picker: string, name: string | RegExp, role: "menuitem" | "menuitemradio" = "menuitemradio") {
  fireEvent.click(screen.getByTitle(picker));
  fireEvent.click(await screen.findByRole(role, { name }));
}

const pill = (title: string) => screen.getByTitle(title).textContent;

describe("a workspace's agent sessions (#1289)", () => {
  it("lists a sleeping workspace's sessions from its cache without attaching, and opens one in the shared session view", async () => {
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
    render(view({ state: "suspended" }, "suspended"));
    const row = await screen.findByTestId("cloud-agent-session");
    expect(row.textContent).toContain("Refactor");
    expect(row.getAttribute("data-session")).toBe("s-1");
    // Nothing is read live or attached while it sleeps; no chat of its own is drawn here.
    expect(client.subscribeSession).not.toHaveBeenCalled();
    expect(client.listAgentTabs).not.toHaveBeenCalled();
    expect(screen.queryByText("cached question")).toBeNull();
    fireEvent.click(row);
    expect(openSession).toHaveBeenCalledWith("s-1", "t-1");
  });

  it("follows the runtime's tabs once connected, one row per session", async () => {
    liveTabs = [
      tabInfo({ sessionId: "s-1", tabId: "t-1", title: "Refactor", modified: "2026-09-29T00:00:01Z" }),
      tabInfo({ sessionId: "s-1", tabId: "t-2", harness: "codex", status: "in_progress", modified: "2026-09-29T00:00:02Z" }),
      tabInfo({ sessionId: "s-2", tabId: "t-3", harness: "codex", modified: "2026-09-29T00:00:03Z" }),
    ];
    render(view(connected()));
    await waitFor(() => expect(screen.getAllByTestId("cloud-agent-session")).toHaveLength(2));
    const [first, second] = screen.getAllByTestId("cloud-agent-session");
    // The most recently changed session first.
    expect(first!.getAttribute("data-session")).toBe("s-2");
    expect(second!.textContent).toContain("Refactor");
    expect(second!.textContent).toContain("2 tabs");
    expect(second!.textContent).toContain("Working");
    // The working tab is the one it opens on.
    fireEvent.click(second!);
    expect(openSession).toHaveBeenCalledWith("s-1", "t-2");
  });

  it("says an agent needs sign-in instead of showing it working (PRO-78)", async () => {
    liveTabs = [tabInfo({ status: "in_progress", signIn: { provider: "claude", state: "not-connected", reason: null } })];
    render(view(connected()));
    const row = await screen.findByTestId("cloud-agent-session");
    expect(row.textContent).toContain("Needs sign-in");
    expect(row.textContent).not.toContain("Working");
    expect(within(row).queryByLabelText("working")).toBeNull();
  });

  it("leaves out a tab with no session yet, and names an untitled session by its agent", () => {
    const tab = (info: Partial<AgentTabInfo>) => ({ tabId: info.tabId ?? "t", info: tabInfo(info), unread: false }) as never;
    const rows = agentSessionRows([tab({ sessionId: "", tabId: "t-0" }), tab({ sessionId: "s-1", tabId: "t-1", harness: "codex" })]);
    expect(rows.map((row) => [row.sessionId, row.title])).toEqual([["s-1", "Codex"]]);
  });

  it("opens a session it just started in the shared session view", async () => {
    client.createAgentTab.mockImplementation(async () => {
      liveTabs = [tabInfo({ sessionId: "s-9", tabId: "t-9" })];
      return { sessionId: "s-9", tabId: "t-9" };
    });
    render(view(connected()));
    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    fireEvent.submit(await screen.findByTestId("cloud-agent-new"));
    await waitFor(() => expect(openSession).toHaveBeenCalledWith("s-9", "t-9"));
  });

  it("starts a new agent tab in bypass unless another mode is picked", async () => {
    client.createAgentTab.mockResolvedValue({ sessionId: "s-9", tabId: "t-9" });
    render(view(connected()));
    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    const form = await screen.findByTestId("cloud-agent-new");
    expect(within(form).getByTitle("Permissions").textContent).toBe("Bypass permissions");
    fireEvent.submit(form);
    await waitFor(() => expect(client.createAgentTab).toHaveBeenCalledTimes(1));
    expect(client.createAgentTab.mock.calls[0][0]).toMatchObject({ agent: "claude", mode: "bypassPermissions" });

    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    await choose("Permissions", /^Ask every time/);
    fireEvent.submit(await screen.findByTestId("cloud-agent-new"));
    await waitFor(() => expect(client.createAgentTab).toHaveBeenCalledTimes(2));
    expect(client.createAgentTab.mock.calls[1][0]).toMatchObject({ agent: "claude", mode: "manual" });
  });

  it("offers pinned models from the workspace when creating a cloud tab", async () => {
    client.listRuntimeAgents.mockResolvedValue(RUNTIME_AGENTS);
    client.createAgentTab.mockResolvedValue({ sessionId: "s-9", tabId: "t-9" });
    render(view(connected({ capabilities: ["session/1", "keys/1", "agents/1"] })));
    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    const form = await screen.findByTestId("cloud-agent-new");
    // The workspace's own CLI says what its alias runs.
    await waitFor(() => expect(within(form).getByTitle("Model").textContent).toBe("Opus 4.6"));
    await choose("Model", "Opus 4.6");
    fireEvent.submit(form);
    await waitFor(() => expect(client.createAgentTab).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", model: "claude-opus-4-6" })));
  });

  it("words the sign-in notice for who is reading and why the login is missing", () => {
    const info = (signIn: AgentTabInfo["signIn"]) => ({ harness: "codex", signIn });
    expect(signInMessage(info(null), true)).toBeNull();
    expect(signInMessage(info({ provider: "codex", state: "not-connected" }), true)).toBe(
      "Needs sign-in: Codex isn't connected for this organization, so it can't take prompts here. Connect it in Settings → Organizations → Agent logins, then send again.",
    );
    // A member cannot connect it, and is not sent somewhere they have no access to.
    expect(signInMessage(info({ provider: "codex", state: "not-connected" }), false)).toBe(
      "Needs sign-in: Codex isn't connected for this organization, so it can't take prompts here. Ask an owner or admin to connect it, then send again.",
    );
    expect(signInMessage(info({ provider: "codex", state: "not-connected" }), null)).toContain("Ask an owner or admin");
    expect(signInMessage(info({ provider: "codex", state: "unavailable", reason: "token-expired" }), true)).toContain("login has expired");
    expect(signInMessage(info({ provider: "codex", state: "unavailable", reason: "shared-use-policy" }), false)).toContain("An owner or admin can allow it for the whole organization.");
    expect(signInMessage(info({ provider: "codex", state: "revoked" }), true)).toContain("Codex login was revoked");
    expect(signInMessage(info({ provider: "codex", state: "disconnected" }), true)).toContain("Codex login was disconnected");
    // #667: a login the provider refused, by the server's word or the runtime's, is signed in again, by name.
    const refused = { provider: "codex", state: "sign-in-required", reason: "provider-refused" };
    expect(signInMessage(info(refused), true, "TerminalX")).toBe(
      "Codex sign-in for TerminalX was revoked or expired, so it can't take prompts here. Sign in again, then start the agent or send again.",
    );
    expect(signInMessage(info(refused), false, "TerminalX")).toContain("Ask an owner or admin to sign it in again");
    expect(signInMessage(info(refused), true)).toContain("Codex sign-in for this organization was revoked or expired");
    expect(signInAgain(info(refused), true)).toBe("codex");
    expect(signInAgain(info(refused), false)).toBeNull();
    expect(signInAgain(info(refused), null)).toBeNull();
    expect(signInAgain(info({ provider: "codex", state: "revoked" }), true)).toBeNull();
    // Cursor has no sign-in to open: its key is connected again where the logins are.
    const cursor = { harness: "cursor-agent", signIn: { provider: "cursor", state: "sign-in-required", reason: null } };
    expect(signInAgain(cursor, true)).toBeNull();
    expect(signInMessage(cursor, true)).toContain("Connect it again in Settings → Organizations → Agent logins");
    // A state word this app does not know is not printed.
    const unknown = signInMessage(info({ provider: "codex", state: "quarantined_v2" }), true)!;
    expect(unknown).toContain("Codex login is not available");
    expect(unknown).not.toContain("quarantined");
  });

  it("says why a creator's own route gives the agent nothing, without sending anyone to the organization's logins (PRO-18)", () => {
    const info = (reason: string) => ({ harness: "claude", signIn: { provider: "claude", state: "unavailable", reason } });
    const shared = signInMessage(info("route-shared-workspace"), true)!;
    expect(shared).toBe(
      "Needs sign-in: Claude Code uses its own route in this workspace, and its route's stored credential is personal and is never sent to a workspace others can drive. The workspace's creator can switch it to a credential helper or back to the organization login (Settings → Organizations → Your model access).",
    );
    expect(shared).not.toContain("Agent logins");
    expect(signInMessage(info("route-runtime-unsupported"), false)).toContain("too old for its route");
    expect(signInMessage(info("route-template-unsupported"), false)).toContain("does not apply its route's endpoint type");
    expect(signInMessage(info("route-unavailable"), false)).toContain("could not be read");
  });
});

describe("a new agent tab's launch settings (#554)", () => {
  /** Open the new-tab form on a workspace whose runtime lists its agents and models. */
  async function openForm() {
    client.listRuntimeAgents.mockResolvedValue(RUNTIME_AGENTS);
    client.createAgentTab.mockResolvedValue({ sessionId: "s-9", tabId: "t-9" });
    render(
      <>
        {view(connected({ capabilities: ["session/1", "keys/1", "agents/1"] }))}
        <BypassDialog />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    const form = await screen.findByTestId("cloud-agent-new");
    await waitFor(() => expect(client.listRuntimeAgents).toHaveBeenCalled());
    return form;
  }

  async function started() {
    fireEvent.submit(screen.getByTestId("cloud-agent-new"));
    await waitFor(() => expect(client.createAgentTab).toHaveBeenCalledTimes(1));
    return client.createAgentTab.mock.calls[0][0];
  }

  it("starts from what New Session would launch with, in the shared pickers, and saves nothing it picks", async () => {
    setPrefs({ lastAgent: "codex", lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "medium" }, lastMode: "manual" });
    const form = await openForm();
    await waitFor(() => expect(within(form).getByTitle("Model").textContent).toBe("GPT-5.6 Sol"));
    expect(["Agent", "Effort", "Permissions"].map((title) => within(form).getByTitle(title).textContent)).toEqual(["Codex", "medium", "Ask every time"]);
    // No copy of the pickers is left on the form.
    expect(within(form).queryAllByRole("combobox")).toEqual([]);
    await choose("Effort", "high");
    expect(await started()).toMatchObject({ agent: "codex", model: "gpt-5.6-sol", effort: "high", mode: "manual" });
    expect(getPrefs()).toMatchObject({ lastAgent: "codex", lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "medium" }, lastMode: "manual" });
  });

  it("offers the agents New Session offers for a cloud project, installed on this computer or not", async () => {
    await openForm();
    fireEvent.click(screen.getByTitle("Agent"));
    const agents = await screen.findAllByRole("menuitem");
    expect(agents.map((item) => item.textContent)).toEqual(HARNESSES.map((h) => h.name));
    expect(agents.map((item) => item.getAttribute("aria-disabled"))).toEqual([null, null]);
  });

  it("switches agent to that agent's saved model and effort, from the workspace's own list", async () => {
    setPrefs({ lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "high" } });
    await openForm();
    await waitFor(() => expect(pill("Model")).toBe("Opus 4.6"));
    await choose("Agent", "Codex", "menuitem");
    expect([pill("Model"), pill("Effort")]).toEqual(["GPT-5.6 Sol", "high"]);
    fireEvent.click(screen.getByTitle("Model"));
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual(["GPT-6 Astra", "GPT-5.6 Sol"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6 Astra" }));
    // GPT-6 Astra takes high too, so it stays.
    expect(pill("Effort")).toBe("high");
    expect(await started()).toMatchObject({ agent: "codex", model: "gpt-6-astra", effort: "high" });
  });

  it("never sends an effort the chosen model does not take", async () => {
    await openForm();
    await waitFor(() => expect(pill("Model")).toBe("Opus 4.6"));
    await choose("Effort", "max");
    // Sonnet has no max: its own default goes, not the one picked for Opus.
    await choose("Model", /^Sonnet/);
    expect(pill("Effort")).toBe("high");
    fireEvent.click(screen.getByTitle("Effort"));
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual(["low", "high"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(await started()).toMatchObject({ agent: "claude", model: "sonnet", effort: "high" });
  });

  it("drops the effort for a model without one", async () => {
    await openForm();
    await waitFor(() => expect(pill("Model")).toBe("Opus 4.6"));
    await choose("Effort", "max");
    await choose("Model", /^Haiku/);
    expect(screen.queryByTitle("Effort")).toBeNull();
    expect(await started()).toMatchObject({ agent: "claude", model: "haiku", effort: null });
  });

  it("asks before bypass as New Session does, and keeps the answer to this tab", async () => {
    setPrefs({ lastMode: "manual" });
    await openForm();
    expect(pill("Permissions")).toBe("Ask every time");

    await choose("Permissions", /^Bypass permissions/);
    const dialog = await screen.findByRole("dialog", { name: "Let Claude Code run without asking?" });
    expect(pill("Permissions")).toBe("Ask every time");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pill("Permissions")).toBe("Ask every time");

    await choose("Permissions", /^Bypass permissions/);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Bypass permissions" }));
    await waitFor(() => expect(pill("Permissions")).toBe("Bypass permissions"));
    expect((await started()).mode).toBe("bypassPermissions");
    expect(getPrefs().lastMode).toBe("manual");
  });
});

describe("a machine's new agent tab is created in one of its projects (PRO-346)", () => {
  const PROJECTS = [
    { projectId: "p-terminalx", name: "terminalx" },
    { projectId: "p-server", name: "terminalx-server" },
  ];
  const machineView = (projects: Partial<import("./CloudAgents").AgentProjects>) => (
    <TooltipProvider>
      <CloudAgentSessions
        scope={{ organizationId: "", workspaceId: "machine:m1" }}
        client={client as unknown as WorkspaceRpcClient}
        state={connected()}
        workspaceState={null}
        projects={{ projects: PROJECTS, preferred: null, request: null, onRequestTaken: vi.fn(), onCreated: vi.fn(), ...projects }}
        onOpenSession={openSession}
      />
    </TooltipProvider>
  );

  it("opens the form on the project the sidebar's + chose, sends it with the create, and hands back the new session", async () => {
    client.connection = connected();
    client.createAgentTab.mockResolvedValue({ sessionId: "s-9", tabId: "t-9" });
    const onRequestTaken = vi.fn();
    const onCreated = vi.fn();
    render(machineView({ request: { projectId: "p-server", nonce: 1 }, onRequestTaken, onCreated }));
    const form = await screen.findByTestId("cloud-agent-new");
    expect(onRequestTaken).toHaveBeenCalledTimes(1);
    expect(form.getAttribute("data-project")).toBe("p-server");
    expect(within(form).getByTestId("agent-project").textContent).toBe("terminalx-server");
    fireEvent.submit(form);
    await waitFor(() => expect(client.createAgentTab).toHaveBeenCalledTimes(1));
    expect(client.createAgentTab.mock.calls[0][0]).toMatchObject({ agent: "claude", projectId: "p-server" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("s-9", "p-server"));
  });

  it("+ Agent starts on the preferred project, and with none chosen it cannot start", async () => {
    client.connection = connected();
    client.createAgentTab.mockResolvedValue({ sessionId: "s-9", tabId: "t-9" });
    const { unmount } = render(machineView({ preferred: "p-terminalx" }));
    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    expect((await screen.findByTestId("cloud-agent-new")).getAttribute("data-project")).toBe("p-terminalx");
    unmount();

    render(machineView({ preferred: null }));
    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    const form = await screen.findByTestId("cloud-agent-new");
    expect(within(form).getByTestId("agent-project").textContent).toBe("Choose a project");
    expect((within(form).getByRole("button", { name: "Start agent" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(client.createAgentTab).not.toHaveBeenCalled();
    await choose("Project", "terminalx");
    fireEvent.submit(form);
    await waitFor(() => expect(client.createAgentTab).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p-terminalx" })));
  });

  it("names an agent not signed in on the machine, and opens the machine's page (PRO-350)", async () => {
    client.connection = connected({ capabilities: ["session/1", "keys/1", "agents/1"] });
    client.listRuntimeAgents.mockResolvedValue([
      { ...RUNTIME_AGENTS[0]!, signIn: "signedIn" },
      { ...RUNTIME_AGENTS[1]!, signIn: "signedOut" },
    ] as never);
    const openPage = vi.fn();
    render(machineView({ preferred: "p-terminalx", machine: { name: "dev-server", openPage } }));
    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    const form = await screen.findByTestId("cloud-agent-new");
    await waitFor(() => expect(client.listRuntimeAgents).toHaveBeenCalled());
    await waitFor(() => expect(pill("Model")).toBe("Opus 4.6"));
    // Claude Code is signed in there: nothing to say.
    expect(within(form).queryByTestId("agent-sign-in-reason")).toBeNull();
    await choose("Agent", "Codex", "menuitem");
    const reason = await within(form).findByTestId("agent-sign-in-reason");
    expect(reason.textContent).toContain("Codex is not signed in on dev-server. Sign in from its machine page.");
    fireEvent.click(within(reason).getByRole("button", { name: "Open machine page" }));
    expect(openPage).toHaveBeenCalledTimes(1);
  });

  it("says nothing about sign-in when the machine's runtime does not report it", async () => {
    client.connection = connected({ capabilities: ["session/1", "keys/1", "agents/1"] });
    client.listRuntimeAgents.mockResolvedValue(RUNTIME_AGENTS as never);
    render(machineView({ preferred: "p-terminalx", machine: { name: "dev-server", openPage: vi.fn() } }));
    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    const form = await screen.findByTestId("cloud-agent-new");
    await waitFor(() => expect(pill("Model")).toBe("Opus 4.6"));
    await choose("Agent", "Codex", "menuitem");
    expect(within(form).queryByTestId("agent-sign-in-reason")).toBeNull();
  });

  it("a cloud workspace's form has no project picker and sends no project", async () => {
    client.createAgentTab.mockResolvedValue({ sessionId: "s-9", tabId: "t-9" });
    render(view(connected()));
    fireEvent.click(await screen.findByRole("button", { name: "New agent session" }));
    const form = await screen.findByTestId("cloud-agent-new");
    expect(within(form).queryByTestId("agent-project")).toBeNull();
    fireEvent.submit(form);
    await waitFor(() => expect(client.createAgentTab).toHaveBeenCalledTimes(1));
    expect(client.createAgentTab.mock.calls[0][0]).not.toHaveProperty("projectId");
  });
});
