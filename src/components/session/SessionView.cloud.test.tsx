import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessibilityPress, mouseClick } from "@/test/press";
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
  /** This account's role in the session's organization. */
  role: "member",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args?: Record<string, unknown>) => mocks.guard.invoke(command, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// The connection manager (CS-7) holds the connection; the native side still has it while it does.
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), workspaceConnection: mocks.workspaceConnection, hasWorkspaceConnection: () => true }));
vi.mock("@/lib/cloudCatalog", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/cloudCatalog")>()), useCloudCatalog: () => mocks.catalog }));
vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-in", identity: { name: null, email: "a@b.c", organization: "Acme", organizationId: "org-1" }, expiresAt: null, lastError: null, organizations: [{ id: "org-1", name: "Acme", get role() { return mocks.role; } }] } };
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
    settingsLockedReason?: string | null;
    canStop?: boolean;
    cwd?: string;
  }) => (
    <div data-testid="composer" data-cwd={props.cwd ?? ""}>
      {props.disabledReason && <p role="note">{props.disabledReason}</p>}
      {props.settingsLockedReason && <p data-testid="settings-locked">{props.settingsLockedReason}</p>}
      <textarea aria-label="Prompt" value={props.draft} onChange={(e) => props.onDraftChange(e.target.value)} />
      <button onClick={() => void Promise.resolve(props.onSend(props.draft, [])).then(() => props.onDraftChange(""), () => undefined)}>{props.busy ? "Queue" : "Send"}</button>
      {props.busy && props.canStop !== false && <button onClick={props.onStop}>Stop</button>}
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
import { TERMINAL_POLL_MS, cloudTerminalsOf, resetCloudTerminals, sessionTerminals } from "@/lib/cloudTerminals";
import { resetCloudConnections } from "@/lib/cloudConnections";
import { resetCollab } from "@/lib/cloudCollab";
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
  /** What `pty.list` answers: one terminal of the session, one that belongs to no session. */
  terminals: Record<string, unknown>[] = [
    { ptyId: "p1", number: 1, epoch: "e1", pid: 1, cwd: "/workspace/api", cols: 80, rows: 24, createdAt: 1, offset: 0, exited: false, exitCode: null, control: "you", sessionId: "s-1" },
    { ptyId: "p2", number: 2, epoch: "e1", pid: 2, cwd: "/workspace", cols: 80, rows: 24, createdAt: 1, offset: 0, exited: false, exitCode: null, control: "you" },
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
  /** PRO-30: what `collab.state` answers on a runtime that granted `collab/1`. */
  collab: { you: Record<string, unknown>; participants: unknown[]; leases: unknown[] } | null = null;
  connectShared(you: { userId: string; role: string; canApprove: boolean }, authority: "manage" | "participate" = "participate") {
    this.collab ??= { you, participants: [], leases: [] };
    this.collab.you = you;
    this.emit({
      state: "connected",
      runtimeGeneration: 3,
      runtimeEpoch: "e1",
      runtimeVersion: "0.3.0",
      capabilities: ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "agents/1", "collab/1"],
      authority,
      you: { ...you, listed: true },
    } as WorkspaceConnectionState);
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
      case "collab.state":
        return this.collab ? ok(this.collab) : { id: frame.id, ok: false, error: { code: "method_not_found", message: frame.method } };
      case "presence.update":
        return ok({});
      case "runtime.agents":
        return ok({ agents: [{ id: "claude", name: "Claude Code", caps: {}, models: [], modes: [], defaultMode: "bypassPermissions" }] });
      case "pty.list":
        return ok({ epoch: "e1", terminals: this.terminals });
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
  mocks.role = "member";
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
  resetCollab();
  client.close();
});

const composer = () => screen.getByTestId("composer");
/** The session's terminals as the store has them (the tab strip's and the sidebar's source). */
const getCloudSessionTerminals = () => sessionTerminals(cloudTerminalsOf(`cloud:${ORG}:${WS}`).terminals, "s-1").map((terminal) => terminal.title);

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
  it("shows a terminal someone else opens in the session without reopening it", async () => {
    // Only the poll's interval is faked: everything else runs as it does.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await openConnected();
      await waitFor(() => expect(getCloudSessionTerminals()).toEqual(["Terminal 1"]));
      const lists = runtime.methods("pty.list").length;
      // Another person opens a terminal for this session on the runtime.
      runtime.terminals = [...runtime.terminals, { ptyId: "p3", number: 3, epoch: "e1", pid: 3, cwd: "/workspace/api", cols: 80, rows: 24, createdAt: 2, offset: 0, exited: false, exitCode: null, control: "other", controllerId: "u-bob", sessionId: "s-1" }];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS);
      });
      await waitFor(() => expect(getCloudSessionTerminals()).toEqual(["Terminal 1", "Terminal 3"]));
      expect(runtime.methods("pty.list").length).toBe(lists + 1);
      // It is a tab of the session view like the first one.
      act(() => selectSessionTab(KEY, { kind: "terminal", id: `cloud:cloud:${ORG}:${WS}:p3` }));
      expect((await screen.findByTestId("xterm")).textContent).toBe(`cloud:cloud:${ORG}:${WS}:p3`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the chat inside the window: the tab's body is a flex column the transcript scrolls in", async () => {
    runtime.events = [ev({ type: "user_message", text: "a long transcript", queued: false })];
    await openConnected();
    const scroller = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-chat-scroller]");
      expect(found).toBeTruthy();
      return found!;
    });
    // jsdom lays nothing out (pnpm test:webkit-layout measures it); this is
    // the structure the layout depends on. The chat is `flex-1 min-h-0`, which
    // only bounds its height when every box up to the tab panel is a flex
    // column that may shrink. A plain block there let the transcript grow
    // past the window and take the composer with it.
    const panel = scroller.closest('[role="tabpanel"]')!;
    for (let node = scroller.parentElement!; node !== panel; node = node.parentElement!) {
      const classes = node.className.split(/\s+/);
      expect(classes, node.className).toContain("flex");
      expect(classes, node.className).toContain("min-h-0");
    }
    expect(panel.parentElement!.className).toContain("min-h-0");
  });

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

  // PRO-38: the organization's diagnostics, from where the session runs.
  // A member (the role every other test here has) is not offered it: the
  // menu above is exactly Stop, Archive and Delete.
  it("the location chip opens cloud diagnostics for an administrator of the session's organization", async () => {
    mocks.role = "admin";
    guard.handlers.cloud_diagnostics = () => ({
      v: 1,
      organizationId: "org-1",
      generatedAt: 2,
      window: { from: 1, to: 2, maxOperations: 200, truncated: false },
      retention: null,
      stageTimings: { create: null, resume: null },
      operations: [],
      workspaces: [],
      closeReasons: [],
    });
    guard.handlers.cloud_connection_diagnostics = () => [];
    await openConnected();
    click(screen.getByTestId("session-location"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual(["Stop", "Archive… (stops compute, deleted after 30 days)", "Delete…", "Cloud diagnostics…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Cloud diagnostics/ }));
    const dialog = await screen.findByTestId("cloud-diagnostics-dialog");
    expect(within(dialog).getByText("Cloud diagnostics · Acme")).toBeTruthy();
    await waitFor(() => expect(guard.calls.some((call) => call.command === "cloud_diagnostics" && call.args.windowDays === 7)).toBe(true));
    expect(await within(dialog).findByText("No cloud operations in this window.")).toBeTruthy();
    expect(guard.violations).toEqual([]);
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

// The header's "+" opened its menu with Return but not with a mouse click.
describe("the session header's New tab menu", () => {
  // hidden: an open modal menu hides the rest of the page from the accessibility tree.
  const plus = () => screen.getByRole("button", { name: "New tab", hidden: true });

  it("opens on a real mouse click, and a second click closes it", async () => {
    await openConnected();
    mouseClick(plus());
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("New agent tab with")).toBeTruthy();
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual(["Claude Code", "Terminalon the VM"]);
    expect(plus().getAttribute("aria-expanded")).toBe("true");
    // The tooltip around it must not mark the open menu's trigger closed.
    expect(plus().getAttribute("data-state")).toBe("open");
    mouseClick(plus());
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(plus().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on an accessibility press (a click with no pointerdown) and with Return", async () => {
    await openConnected();
    accessibilityPress(plus());
    expect(await screen.findByRole("menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(plus(), { key: "Enter" });
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

});

describe("a shared cloud workspace in SessionView (PRO-30)", () => {
  const ME = { userId: "u-me", role: "driver", canApprove: false };
  const shared = (role: "manager" | "driver" | "viewer" | "none", canApprove = false, state: CloudWorkspaceListItem["workspace"]["state"] = "ready") => {
    const item = workspaceItem(state, "participate");
    item.workspace.accessMode = "organization";
    item.workspace.you = { role, canApprove };
    item.workspace.sharedWith = 2;
    return item;
  };
  const names = () => {
    guard.handlers.organization_members = () => ({ members: [{ userId: "u-alice", email: "alice@example.com", displayName: "Alice", role: "member" }], pendingInvites: [], viewerRole: "member", canManageMembers: false, removedOnDelete: [], runtimeFacts: { available: true }, contextRevision: "r" });
  };
  async function openShared(you: typeof ME) {
    runtime.tabs = [tabInfo()];
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connectShared(you));
    await screen.findByText("Fix login redirect");
    await waitFor(() => expect(runtime.methods("collab.state").length).toBeGreaterThan(0));
  }

  it("lets a driver on a participate attachment send, and shows who else is here", async () => {
    names();
    setCatalog(shared("driver"));
    runtime.collab = {
      you: ME,
      participants: [
        { userId: "u-me", role: "driver", canApprove: false, surfaces: 1, tabId: "t-1", activity: "viewing", since: 1 },
        { userId: "u-alice", role: "manager", canApprove: true, surfaces: 1, tabId: "t-1", activity: "typing", since: 2 },
      ],
      leases: [],
    };
    await openShared(ME);
    // No "View only": a driver sends through the mailbox like a manager.
    expect(screen.queryAllByRole("note").some((note) => note.textContent?.startsWith("View only"))).toBe(false);
    expect(screen.queryByTestId("cloud-access-chip")).toBeNull();
    const faces = await screen.findAllByTestId("session-presence-person");
    expect(faces).toHaveLength(1);
    await waitFor(() => expect(faces[0]!.getAttribute("title")).toBe("Alice · Admin · typing · on Fix login"));
    // What this person looks at is their presence.
    await waitFor(() => expect(runtime.methods("presence.update").map((frame) => frame.params)).toContainEqual({ tabId: "t-1", activity: "viewing" }));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "add a test" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(enqueued.find((entry) => entry.kind === "send")?.payload).toEqual({ text: "add a test" }));
    // The lease bar says nobody drives yet and offers the wheel.
    expect((await screen.findByTestId("cloud-agent-lease")).textContent).toContain("No one is driving");
    expect(guard.violations).toEqual([]);
  });

  it("keeps the composer closed while someone else holds the tab's lease", async () => {
    names();
    setCatalog(shared("driver"));
    runtime.collab = { you: ME, participants: [], leases: [{ tabId: "t-1", holderId: "u-alice", acquiredAt: 1, expiresAt: Date.now() + 60_000 }] };
    await openShared(ME);
    await waitFor(() => expect(screen.getAllByRole("note").some((note) => note.textContent === "Alice is driving this tab. You can send once they release it.")).toBe(true));
    expect(screen.getByTestId("cloud-agent-driver").textContent).toBe("Driving: Alice");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "me too" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await act(async () => undefined);
    expect(enqueued.filter((entry) => entry.kind === "send")).toEqual([]);
    expect(guard.violations).toEqual([]);
  });

  it("does not let a driver without approval rights answer a permission request", async () => {
    names();
    setCatalog(shared("driver"));
    runtime.collab = { you: ME, participants: [], leases: [] };
    runtime.events = [
      ev({ type: "permission_requested", requestId: "req-1", toolUseId: "tool-1", toolName: "Bash", input: { command: "ls" }, options: [{ id: "allow", label: "Allow", kind: "allow_once" }] } as Payload),
    ];
    runtime.tabs = [tabInfo({ status: "waiting" })];
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connectShared(ME));
    await screen.findByText(/Waiting for permission/);
    const allow = await screen.findByRole("button", { name: /^Allow/ });
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("answer-blocked").textContent).toBe("Waiting for someone who can approve");
    fireEvent.click(allow);
    await act(async () => undefined);
    expect(enqueued.filter((entry) => entry.kind === "permission-decision")).toEqual([]);
  });

  it("shows a viewer the lock chip and a closed composer, awake or asleep", async () => {
    names();
    setCatalog(shared("viewer"));
    runtime.collab = { you: { ...ME, role: "viewer" }, participants: [], leases: [] };
    await openShared({ ...ME, role: "viewer" });
    expect(screen.getByTestId("cloud-access-chip").textContent).toBe("View only");
    expect(screen.getAllByRole("note").some((note) => note.textContent === "You can view this workspace; ask an admin for driver access")).toBe(true);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "hello" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await act(async () => undefined);
    expect(enqueued).toEqual([]);
    cleanup();

    // A stopped workspace: nothing connects, and the list's role still gates.
    resetCloudConnections();
    setCatalog(shared("viewer", false, "suspended"));
    cache["t-1"] = { tab: tabInfo(), events: [], cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1 };
    render(wrap(<CloudHarness />));
    await act(async () => runtime.emit({ state: "suspended" }));
    expect((await screen.findByTestId("cloud-access-chip")).textContent).toBe("View only");
    expect(screen.getAllByRole("note").some((note) => note.textContent === "You can view this workspace; ask an admin for driver access")).toBe(true);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "wake up" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await act(async () => undefined);
    expect(enqueued).toEqual([]);
    expect(activate).not.toHaveBeenCalled();
  });

  it("locks the model, effort and mode for a driver who may not approve (review M1)", async () => {
    names();
    setCatalog(shared("driver"));
    runtime.collab = { you: ME, participants: [], leases: [] };
    await openShared(ME);
    expect((await screen.findByTestId("settings-locked")).textContent).toMatch(/^Only a workspace admin or someone who can approve/);
    fireEvent.click(screen.getByRole("button", { name: "Use opus" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan mode" }));
    await act(async () => undefined);
    expect(runtime.methods("session.configure")).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("hides Stop from a driver while someone else drives the running turn", async () => {
    names();
    setCatalog(shared("driver", true));
    runtime.tabs = [tabInfo({ status: "in_progress" })];
    runtime.collab = { you: { ...ME, canApprove: true }, participants: [], leases: [{ tabId: "t-1", holderId: "u-alice", acquiredAt: 1, expiresAt: Date.now() + 60_000 }] };
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connectShared({ ...ME, canApprove: true }));
    await screen.findByText("Fix login redirect");
    await waitFor(() => expect(screen.getByTestId("cloud-agent-driver").textContent).toBe("Driving: Alice"));
    expect(within(composer()).queryByRole("button", { name: "Stop" })).toBeNull();
    // An approving driver may still change the settings.
    expect(screen.queryByTestId("settings-locked")).toBeNull();
  });

  it("gives a demoted admin's manage attachment no writes, terminals or new tabs", async () => {
    names();
    setCatalog(shared("viewer"));
    runtime.collab = { you: { ...ME, role: "viewer" }, participants: [], leases: [] };
    runtime.tabs = [tabInfo()];
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connectShared({ ...ME, role: "viewer" }, "manage"));
    await screen.findByText("Fix login redirect");
    expect(screen.getByTestId("cloud-access-chip").textContent).toBe("View only");
    // Git and files: read-only with the reason.
    expect((await screen.findByTestId("panel-read-only")).textContent).toMatch(/View only|driver access/);
    await waitFor(() => expect(runtime.methods("pty.list").length).toBeGreaterThan(0));
    act(() => selectSessionTab(KEY, { kind: "terminal", id: `cloud:cloud:${ORG}:${WS}:p1` }));
    await screen.findByTestId("xterm");
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    // The New tab menu stays, with every item disabled and the reason.
    mouseClick(screen.getByRole("button", { name: "New tab" }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled"))).toBe(true);
  });

  it("offers the waking Terminal on a stopped workspace only to someone who would manage it", async () => {
    const asleep = async (role: "manager" | "driver" | "viewer") => {
      resetCloudConnections();
      const item = shared(role, role !== "viewer", "suspended");
      if (role === "manager") item.workspace.authority = "manage";
      setCatalog(item);
      render(wrap(<CloudHarness />));
      await act(async () => runtime.emit({ state: "suspended" }));
      await screen.findByTestId("session-connection");
      mouseClick(screen.getByRole("button", { name: "New tab" }));
      return screen.findByRole("menu");
    };
    for (const role of ["driver", "viewer"] as const) {
      const menu = await asleep(role);
      // Terminals are a manager's: no wake is offered that would end in a refusal.
      expect(within(menu).queryByRole("menuitem", { name: /wakes the workspace/ })).toBeNull();
      expect(within(menu).getByRole("menuitem", { name: /Terminal/ }).getAttribute("aria-disabled")).toBe("true");
      cleanup();
    }
    const menu = await asleep("manager");
    expect(within(menu).getByRole("menuitem", { name: "Terminal on the VM: wakes the workspace" })).toBeTruthy();
    expect(activate).not.toHaveBeenCalled();
  });
});
