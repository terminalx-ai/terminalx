import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { AgentTabInfo, RuntimeSession, WorkspaceConnectionState, WorkspaceTransport } from "@terminalx/portable/workspace";
import type { RpcWireRequest } from "@terminalx/portable/rpc";
import type { CachedTab, OutboxEntry } from "@/lib/cloudAgentApi";
import type { CloudWorkspaceListItem } from "@/lib/api";
import type { SessionEntry } from "@/types/session";
import { guardedApi } from "@/test/guardedApi";

const mocks = vi.hoisted(() => ({
  guard: null as unknown as ReturnType<typeof import("@/test/guardedApi").guardedApi>,
  workspaceConnection: vi.fn(),
  catalog: { owner: "me", revision: "r", loaded: true, orgs: {} as Record<string, unknown>, createMemory: {}, notices: [] },
  prefs: { panelOpen: true, panelWidth: 360, sidebarOpen: true, lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", useWorktree: true },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args?: Record<string, unknown>) => mocks.guard.invoke(command, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// The connection manager (CS-7) holds the connection; the native side still has it while it does.
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), workspaceConnection: mocks.workspaceConnection, hasWorkspaceConnection: () => true }));
vi.mock("@/lib/cloudCatalog", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/cloudCatalog")>()), useCloudCatalog: () => mocks.catalog }));
vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-in", identity: { name: null, email: "a@b.c", organization: "Acme", organizationId: "org-1" }, expiresAt: null, lastError: null, organizations: [{ id: "org-1", name: "Acme", role: "member" }] } };
  return { useAccount: () => account, getAccount: () => account, subscribeAccount: () => () => undefined, refreshAccount: vi.fn() };
});
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => mocks.prefs, getPrefs: () => mocks.prefs, setPrefs: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/models", () => ({
  EFFORT_LABEL: {},
  DEFAULT_PERMISSION_MODE: "bypassPermissions",
  PERMISSION_MODES: [{ id: "bypassPermissions", label: "Bypass permissions", hint: "" }],
  useModels: () => [],
  loadModels: vi.fn(),
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="xterm">{id}</div>, createTerminal: vi.fn() }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));
// The composer's own behaviour is covered by Composer.test; here it only needs its callbacks.
vi.mock("@/components/chat/Composer", () => ({
  Composer: (props: {
    draft: string;
    busy: boolean;
    onDraftChange: (v: string) => void;
    onSend: (t: string, i: unknown[]) => Promise<void>;
    onStop: () => void;
    onSetModel: (m: string) => void;
    onSetEffort: (e: string | null) => void;
    onSetMode: (m: string) => void;
    disabledReason?: string | null;
    cwd?: string;
  }) => (
    <div data-testid="composer" data-cwd={props.cwd ?? ""}>
      {props.disabledReason && <p role="note">{props.disabledReason}</p>}
      <textarea aria-label="Prompt" value={props.draft} onChange={(e) => props.onDraftChange(e.target.value)} />
      <button onClick={() => void Promise.resolve(props.onSend(props.draft, [])).then(() => props.onDraftChange(""), () => undefined)}>{props.busy ? "Queue" : "Send"}</button>
      {props.busy && <button onClick={props.onStop}>Stop</button>}
      <button onClick={() => props.onSetModel("opus")}>Use opus</button>
      <button onClick={() => props.onSetEffort("high")}>Effort high</button>
      <button onClick={() => props.onSetMode("plan")}>Plan mode</button>
    </div>
  ),
}));

import { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { SessionView } from "./SessionView";
import { CloudSessionHost } from "./CloudSessionHost";
import { useCloudSession } from "@/lib/cloudSession";
import { resetCloudAgents } from "@/lib/cloudAgents";
import { resetCloudTerminals } from "@/lib/cloudTerminals";
import { resetCloudConnections } from "@/lib/cloudConnections";
import { selectSessionTab } from "@/lib/terminal";
import { resetCloudWakes } from "@/lib/sessionBackend";
import { getSessionStore, selectCloudSession, upsertSession } from "@/lib/sessions";
import { api } from "@/lib/api";
import { LocalPathLeakError, cloudSessionKey } from "@/types/target";
import { TooltipProvider } from "@/components/ui/tooltip";

mocks.guard = guardedApi();
// jsdom lays nothing out; the file tree scrolls its focused row into view.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
const guard = mocks.guard;

const ORG = "org-1";
const WS = "ws-1";
const KEY = cloudSessionKey(ORG, WS, "s-1");

const tabInfo = (fields: Partial<AgentTabInfo> = {}): AgentTabInfo => ({
  sessionId: "s-1",
  tabId: "t-1",
  title: "Fix login",
  harness: "claude",
  model: "",
  effort: null,
  permissionMode: "bypassPermissions",
  status: "idle",
  process: "running",
  pendingPermissions: [],
  followUps: [],
  lastSeq: 0,
  created: "2026-09-29T00:00:00Z",
  modified: "2026-09-29T00:00:00Z",
  ...fields,
});

let seq = 0;
const ev = (payload: Payload, tabId = "t-1"): AgentEvent => ({ id: `${tabId}-e${++seq}`, seq, sessionId: "s-1", tabId, harness: "claude", ts: "2026-09-29T00:00:00Z", payload });

function workspaceItem(state: CloudWorkspaceListItem["workspace"]["state"], authority: "manage" | "participate" = "manage"): CloudWorkspaceListItem {
  return {
    workspace: {
      id: WS,
      orgId: ORG,
      name: "login-fix",
      provider: "box",
      state,
      accessMode: "private",
      createdAt: 1,
      updatedAt: 1,
      releaseDisposition: null,
      authority,
      repositories: [{ identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true }],
    },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

const runtimeSession = (): RuntimeSession => ({
  id: "s-1",
  projectPath: "/workspace/api",
  cwd: "/workspace/api",
  branch: "tx/login-fix",
  title: "Fix login redirect",
  created: "2026-09-29T00:00:00Z",
  modified: "2026-09-29T00:00:00Z",
  archived: false,
  pinned: false,
  tabs: [{ id: "t-1", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "", modified: "" }],
});

/** A connected runtime behind the real workspace client. */
class FakeRuntime implements WorkspaceTransport {
  up = false;
  sent: RpcWireRequest[] = [];
  tabs: AgentTabInfo[] = [tabInfo()];
  events: AgentEvent[] = [];
  repositories = [
    { repo: "api", branch: "tx/login-fix", head: "abc", remote: "origin", defaultBranch: "main" },
    { repo: "web", branch: "tx/login-fix", head: "def", remote: "origin", defaultBranch: "main" },
  ];
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();
  private subscription = 0;

  send(frame: RpcWireRequest): boolean {
    if (!this.up) return false;
    this.sent.push(frame);
    const answer = this.answer(frame);
    queueMicrotask(() => {
      for (const listener of this.messages) listener(answer);
    });
    return true;
  }
  onMessage(listener: (message: unknown) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onState(listener: (state: WorkspaceConnectionState) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
  close() {}
  emit(state: WorkspaceConnectionState) {
    this.up = state.state === "connected";
    for (const listener of this.states) listener(state);
  }
  connect(authority: "manage" | "participate" = "manage") {
    this.emit({
      state: "connected",
      runtimeGeneration: 3,
      runtimeEpoch: "e1",
      runtimeVersion: "0.3.0",
      capabilities: ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "agents/1"],
      authority,
    });
  }
  methods(name: string) {
    return this.sent.filter((frame) => frame.method === name);
  }
  private answer(frame: RpcWireRequest) {
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const ok = (result: unknown) => ({ id: frame.id, ok: true, result });
    switch (frame.method) {
      case "session.tabs":
        return ok({ tabs: this.tabs });
      case "session.list":
        return ok({ sessions: [runtimeSession()] });
      case "session.subscribe":
        return ok({ subscriptionId: `sub-${++this.subscription}`, events: this.events.map((event) => ({ cursor: `3:${event.seq}`, event })), cursor: `3:${this.events.at(-1)?.seq ?? 0}` });
      case "session.nudge":
      case "session.markRead":
      case "session.unsubscribe":
        return ok({});
      case "session.configure":
        return ok({ tab: { ...this.tabs[0], ...(params.model ? { model: params.model } : {}), ...(params.effort ? { effort: params.effort } : {}), ...(params.mode ? { permissionMode: params.mode } : {}) } });
      case "runtime.agents":
        return ok({ agents: [{ id: "claude", name: "Claude Code", caps: {}, models: [], modes: [], defaultMode: "bypassPermissions" }] });
      case "pty.list":
        return ok({ epoch: "e1", terminals: [{ ptyId: "p1", number: 1, epoch: "e1", pid: 1, cwd: "/workspace/api", cols: 80, rows: 24, createdAt: 1, offset: 0, exited: false, exitCode: null, control: "you", sessionId: "s-1" }, { ptyId: "p2", number: 2, epoch: "e1", pid: 2, cwd: "/workspace", cols: 80, rows: 24, createdAt: 1, offset: 0, exited: false, exitCode: null, control: "you" }] });
      case "pty.attach":
        return ok({ subscriptionId: `sub-${++this.subscription}`, epoch: "e1", offset: 0, data: "", truncated: false, exited: false, control: "you", cols: 80, rows: 24 });
      case "git.repositories":
        return ok({ repositories: this.repositories });
      case "git.status":
        return ok({ repository: true, repo: params.repo, branch: "tx/login-fix", head: "abc", upstream: null, ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 1, dirty: true, operation: null, conflicted: [], files: [] });
      case "git.workingChanges":
        return ok({ head: "abc", files: [{ path: `${String(params.repo)}/src/login.ts`, status: "modified", additions: 3, deletions: 1 }], truncated: false });
      case "git.log":
        return ok({ commits: [] });
      case "git.branches":
        return ok({ branches: [], current: "tx/login-fix", defaultBranch: "main" });
      case "git.prs":
        return ok({ branch: "tx/login-fix", prs: [] });
      case "fs.list":
        return ok({ path: "", entries: [{ name: "README.md", path: "README.md", kind: "file" }] });
      case "fs.watch":
        return ok({ subscriptionId: `sub-${++this.subscription}` });
      default:
        return { id: frame.id, ok: false, error: { code: "method_not_found", message: frame.method } };
    }
  }
}

let runtime: FakeRuntime;
let client: WorkspaceRpcClient;
let activate: ReturnType<typeof vi.fn>;
let cache: Record<string, CachedTab>;
let outbox: OutboxEntry[];
let enqueued: { kind: string; tabId: string; payload: Record<string, unknown> }[];

function cloudHandlers() {
  guard.handlers = {
    cloud_agent_cache_load: () => ({ tabs: cache }),
    cloud_agent_cache_save: () => undefined,
    cloud_agent_outbox: () => outbox,
    cloud_agent_outbox_sync: () => outbox,
    cloud_agent_checkpoints: () => [],
    cloud_agent_checkpoint: () => null,
    cloud_agent_enqueue: (args) => {
      const payload = args.payload as Record<string, unknown>;
      enqueued.push({ kind: String(args.kind), tabId: String(args.tabId), payload });
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
      return entry;
    },
    // Reading a Git identity is local but pathless: commits carry it.
    git_identity: () => ({ name: "Ada", email: "ada@example.com" }),
  };
}

function setCatalog(item: CloudWorkspaceListItem) {
  mocks.catalog.orgs = { [ORG]: { orgId: ORG, workspaces: [item], repositories: null, repositoriesAt: null, quota: null, fetchedAt: 1, source: "live", error: null } };
}

/** SessionView itself, fed the cloud model, exactly as AppShell's host does. */
function CloudHarness() {
  const cloud = useCloudSession(KEY);
  if (!cloud) return null;
  return <SessionView session={cloud.session} cloud={cloud} sidebarOpen onToggleSidebar={() => undefined} />;
}

const wrap = (node: React.ReactNode) => <TooltipProvider>{node}</TooltipProvider>;

beforeEach(() => {
  guard.reset();
  cache = {};
  outbox = [];
  enqueued = [];
  cloudHandlers();
  runtime = new FakeRuntime();
  client = new WorkspaceRpcClient(runtime);
  activate = vi.fn(async () => undefined);
  mocks.workspaceConnection.mockReset();
  mocks.workspaceConnection.mockImplementation(async () => ({ target: { kind: "cloud", organizationId: ORG, workspaceId: WS }, client, activate, close: vi.fn() }));
  mocks.prefs.panelOpen = true;
  setCatalog(workspaceItem("ready"));
  // Tab selection is per session key and outlives a render.
  selectSessionTab(KEY, { kind: "agent", id: "t-1" });
});

afterEach(() => {
  cleanup();
  resetCloudAgents();
  resetCloudTerminals();
  resetCloudWakes();
  resetCloudConnections();
  client.close();
});

const composer = () => screen.getByTestId("composer");

async function openConnected(authority: "manage" | "participate" = "manage") {
  runtime.tabs = [tabInfo()];
  render(wrap(<CloudHarness />));
  await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
  await act(async () => runtime.connect(authority));
  await screen.findByText("Fix login redirect");
}

describe("the same SessionView for local and cloud sessions", () => {
  it("renders a local session and a cloud session with one component", async () => {
    guard.strict = false;
    guard.local = () => [];
    guard.handlers.work_status = () => ({ isRepo: true, dirty: false, branch: "main", ahead: 0, behind: 0 });
    const local: SessionEntry = {
      id: "local-1",
      projectPath: "/Users/me/api",
      cwd: "/Users/me/api",
      branch: "main",
      title: "Local work",
      created: "",
      modified: "",
      archived: false,
      pinned: false,
      worktreeRemoved: false,
      tabs: [{ id: "lt-1", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "", modified: "" }],
    };
    upsertSession(local);
    const { unmount } = render(wrap(<SessionView session={local} sidebarOpen onToggleSidebar={() => undefined} />));
    expect(await screen.findByText("Local work")).toBeTruthy();
    expect(screen.queryByTestId("session-location")).toBeNull();
    // A local tab keeps its cwd for slash commands and @-mentions.
    expect(composer().dataset.cwd).toBe("/Users/me/api");
    unmount();

    guard.reset();
    cloudHandlers();
    runtime.events = [ev({ type: "user_message", text: "why does login loop?", queued: false })];
    await openConnected();
    expect(screen.getByTestId("session-location").textContent).toContain("Cloud · Boat · Acme");
    expect(screen.getByTestId("session-connection").textContent).toContain("Live");
    expect(await screen.findByText("why does login loop?")).toBeTruthy();
    expect(screen.getByText("acme/api")).toBeTruthy();
    // A VM path never becomes a local cwd.
    expect(composer().dataset.cwd).toBe("");
    expect(guard.violations).toEqual([]);
  });

  it("shows the session's cloud terminals as tabs, and not the workspace's other terminals", async () => {
    await openConnected();
    await waitFor(() => expect(runtime.methods("pty.list").length).toBeGreaterThan(0));
    act(() => selectSessionTab(KEY, { kind: "terminal", id: `cloud:cloud:${ORG}:${WS}:p1` }));
    expect((await screen.findByTestId("xterm")).textContent).toBe(`cloud:cloud:${ORG}:${WS}:p1`);
    expect(document.getElementById(`session-terminal-panel-${encodeURIComponent(`cloud:cloud:${ORG}:${WS}:p2`)}`)).toBeNull();
    expect(guard.violations).toEqual([]);
  });
});

describe("cloud session actions", () => {
  it("sends, steers, stops, answers a permission and changes model, effort and mode", async () => {
    runtime.events = [
      ev({ type: "user_message", text: "clean up", queued: false }),
      ev({ type: "permission_requested", requestId: "req-9", toolUseId: "tool-1", toolName: "Bash", input: { command: "rm -rf build" }, options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "deny" }] } as Payload),
    ];
    runtime.tabs = [tabInfo({ status: "waiting" })];
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connect());
    await screen.findByText("Fix login redirect");

    await waitFor(() => expect(runtime.methods("session.subscribe").length).toBeGreaterThan(0));
    await screen.findByText(/Waiting for permission/);
    // Answer the permission.
    fireEvent.click(await screen.findByRole("button", { name: /^Allow/ }));
    await waitFor(() => expect(enqueued.find((entry) => entry.kind === "permission-decision")?.payload).toEqual({ requestId: "req-9", optionId: "allow" }));

    // Steer while the turn runs, then stop it.
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "use the staging config" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer now" }));
    await waitFor(() => expect(enqueued.find((entry) => entry.kind === "steer")?.payload).toEqual({ text: "use the staging config" }));
    fireEvent.click(within(composer()).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(enqueued.some((entry) => entry.kind === "stop")).toBe(true));

    // Model, effort and mode go to the live runtime.
    fireEvent.click(screen.getByRole("button", { name: "Use opus" }));
    fireEvent.click(screen.getByRole("button", { name: "Effort high" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan mode" }));
    await waitFor(() => expect(runtime.methods("session.configure").map((frame) => frame.params)).toEqual([
      expect.objectContaining({ sessionId: "s-1", tabId: "t-1", model: "opus" }),
      expect.objectContaining({ sessionId: "s-1", tabId: "t-1", effort: "high" }),
      expect.objectContaining({ sessionId: "s-1", tabId: "t-1", mode: "plan" }),
    ]));

    // Send goes through the mailbox and nudges the live runtime.
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "now run the tests" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(enqueued.find((entry) => entry.kind === "send")?.payload).toEqual({ text: "now run the tests" }));
    await waitFor(() => expect(runtime.methods("session.nudge").length).toBeGreaterThan(0));
    // Connected: nothing needed waking.
    expect(activate).not.toHaveBeenCalled();
    expect(guard.violations).toEqual([]);
  });

  it("selecting a stopped session makes no resume; sending there wakes it exactly once and keeps the selection", async () => {
    setCatalog(workspaceItem("suspended"));
    cache["t-1"] = {
      tab: tabInfo({ status: "in_progress" }),
      events: [ev({ type: "user_message", text: "cached question", queued: false })],
      cursor: null,
      checkpoint: null,
      unread: false,
      completed: false,
      updatedAt: 1,
    };
    selectCloudSession(KEY);
    render(wrap(<CloudSessionHost sessionKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.emit({ state: "suspended" }));
    expect(await screen.findByText("cached question")).toBeTruthy();

    // Looking: connect only, never wake or resume.
    expect(mocks.workspaceConnection.mock.calls.map((call) => call[1])).toEqual(["connect"]);
    expect(activate).not.toHaveBeenCalled();
    expect(guard.calls.map((call) => call.command)).not.toContain("cloud_workspace_resume");
    expect(screen.getByTestId("session-connection").textContent).toContain("Stopped");
    // A stopped workspace is never shown as working: the composer is idle.
    expect(within(composer()).getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.getByTestId("cloud-panel-offline")).toBeTruthy();

    // Sending, twice, while it wakes: two commands, one wake.
    for (const text of ["first", "second"]) {
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: text } });
      fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
      await waitFor(() => expect(enqueued.filter((entry) => entry.kind === "send").map((entry) => entry.payload.text)).toContain(text));
    }
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(activate).toHaveBeenCalledWith("wake");
    expect(guard.calls.map((call) => call.command)).not.toContain("cloud_workspace_resume");
    expect(getSessionStore().selectedSessionId).toBe(KEY);
    expect(guard.violations).toEqual([]);
  });

  it("gates a view-only attachment and says why", async () => {
    setCatalog(workspaceItem("ready", "participate"));
    await openConnected("participate");
    expect(screen.getAllByRole("note").some((note) => note.textContent?.startsWith("View only"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "try anyway" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Use opus" }));
    await act(async () => undefined);
    expect(enqueued).toEqual([]);
    expect(runtime.methods("session.configure")).toEqual([]);
    expect((await screen.findByTestId("panel-read-only")).textContent).toMatch(/View only/);
    expect(screen.getByTestId("session-connection").textContent).toContain("view only");
    expect(guard.violations).toEqual([]);
  });
});

describe("the right panel of a cloud session", () => {
  it("reads Changes from the runtime's Git, switches repositories, and never calls a local path API", async () => {
    await openConnected();
    const picker = (await screen.findByRole("combobox", { name: "Repository" })) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual(["api", "web"]);
    await waitFor(() => expect(runtime.methods("git.status").some((frame) => (frame.params as { repo: string }).repo === "api")).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "View all uncommitted changes" }));
    expect(await screen.findByRole("button", { name: /login\.ts/ })).toBeTruthy();
    expect(runtime.methods("git.workingChanges").map((frame) => (frame.params as { repo: string }).repo)).toContain("api");

    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "web" } });
    await waitFor(() => expect(runtime.methods("git.status").some((frame) => (frame.params as { repo: string }).repo === "web")).toBe(true));
    expect(guard.violations).toEqual([]);
  });
});

describe("local path guard", () => {
  it("refuses a cloud path before it reaches a local command", async () => {
    await expect(api.workStatus("cloud://cloud:org-1:ws-1")).rejects.toBeInstanceOf(LocalPathLeakError);
    await expect(api.listSessions()).rejects.toThrow(/not a cloud API/);
    expect(guard.calls.map((call) => call.command)).toEqual(["list_sessions"]);
  });
});

// PRO-61 follow-ups: the header's chips.
describe("the session header's location and connection chips", () => {
  const click = (element: HTMLElement) => {
    fireEvent.pointerDown(element, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
    fireEvent.click(element, { button: 0 });
  };

  it("the location chip holds the workspace's Stop, Archive and Delete", async () => {
    await openConnected();
    click(screen.getByTestId("session-location"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual(["Stop", "Archive… (stops compute, deleted after 30 days)", "Delete…"]);
  });

  it("the location chip offers Resume on a stopped workspace", async () => {
    setCatalog(workspaceItem("suspended"));
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.emit({ state: "suspended" }));
    click(screen.getByTestId("session-location"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")[0].textContent?.trim()).toBe("Resume");
  });

  it("never reads Live for a stopped workspace, even over a connection that still reads connected", async () => {
    setCatalog(workspaceItem("suspended"));
    runtime.tabs = [tabInfo()];
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connect("manage"));
    expect(screen.getByTestId("session-connection").textContent).toBe("Stopped");
    expect(activate).not.toHaveBeenCalled();
  });

  it("goes Resuming, then Connecting, then Live while it wakes, never back", async () => {
    setCatalog(workspaceItem("suspended"));
    cache["t-1"] = { tab: tabInfo(), events: [], cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1 };
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.emit({ state: "suspended" }));
    expect(screen.getByTestId("session-connection").textContent).toBe("Stopped");
    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "wake up" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith("wake"));
    const seen: string[] = [];
    const step = async (state: WorkspaceConnectionState) => {
      await act(async () => runtime.emit(state));
      seen.push(screen.getByTestId("session-connection").textContent ?? "");
    };
    await step({ state: "waitingForRuntime" });
    await step({ state: "connecting", attempt: 1 });
    await step({ state: "waitingForRuntime" });
    await step({ state: "connecting", attempt: 2 });
    runtime.tabs = [tabInfo()];
    await act(async () => runtime.connect("manage"));
    seen.push(screen.getByTestId("session-connection").textContent ?? "");
    expect(seen).toEqual(["Resuming", "Connecting", "Connecting", "Connecting", "Live"]);
  });
});
