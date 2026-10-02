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
  /** Lists of the organization asked for by the session (never an attach or a resume). */
  refreshCatalog: vi.fn(async (_orgId?: string | null) => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args?: Record<string, unknown>) => mocks.guard.invoke(command, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// The connection manager (CS-7) holds the connection; the native side still has it while it does.
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), workspaceConnection: mocks.workspaceConnection, hasWorkspaceConnection: () => true }));
vi.mock("@/lib/cloudCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudCatalog")>()),
  useCloudCatalog: () => mocks.catalog,
  refreshCloudCatalog: mocks.refreshCatalog,
}));
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
    settingsNote?: string | null;
    settingsNoteWarning?: boolean;
    canStop?: boolean;
    cwd?: string;
  }) => (
    <div data-testid="composer" data-cwd={props.cwd ?? ""}>
      {props.disabledReason && <p role="note">{props.disabledReason}</p>}
      {props.settingsLockedReason && <p data-testid="settings-locked">{props.settingsLockedReason}</p>}
      {props.settingsNote && <p data-testid="settings-note" data-warning={props.settingsNoteWarning ? "true" : "false"}>{props.settingsNote}</p>}
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
import { cloudConnectionChip, useCloudSession, workspaceStarting } from "@/lib/cloudSession";
import { resetCloudAgents } from "@/lib/cloudAgents";
import { TERMINAL_POLL_MS, cloudTerminalsOf, resetCloudTerminals, sessionTerminals } from "@/lib/cloudTerminals";
import { closeCloudConnection, resetCloudConnections } from "@/lib/cloudConnections";
import { resetCollab } from "@/lib/cloudCollab";
import { resetPeople } from "@/lib/cloudPeople";
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
  /** The runtime generation and process this fake is: a woken workspace is a new one of each. */
  generation = 3;
  epoch = "e1";
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();
  private subscription = 0;
  /** The newest `session.subscribe` this runtime answered. */
  private sessionSubscription: string | null = null;

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
      runtimeGeneration: this.generation,
      runtimeEpoch: this.epoch,
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
      runtimeGeneration: this.generation,
      runtimeEpoch: this.epoch,
      runtimeVersion: "0.3.0",
      capabilities: ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "agents/1", "collab/1"],
      authority,
      you: { ...you, listed: true },
    } as WorkspaceConnectionState);
  }
  methods(name: string) {
    return this.sent.filter((frame) => frame.method === name);
  }
  /** A notification from the runtime (`collab.you`, `notes.posted`, …). */
  notify(event: string, params: Record<string, unknown>) {
    for (const listener of this.messages) listener({ event, params });
  }
  /** A live transcript event on the newest session subscription. */
  stream(event: AgentEvent) {
    this.notify("session.event", { subscriptionId: this.sessionSubscription, cursor: `${this.generation}:${event.seq}`, event });
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
        this.sessionSubscription = `sub-${++this.subscription}`;
        return ok({ subscriptionId: this.sessionSubscription, events: this.events.map((event) => ({ cursor: `${this.generation}:${event.seq}`, event })), cursor: `${this.generation}:${this.events.at(-1)?.seq ?? 0}` });
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
      case "lease.acquire":
      case "lease.takeOver": {
        const lease = { tabId: String(params.tabId), holderId: String(this.collab?.you.userId), acquiredAt: 1, expiresAt: Date.now() + 60_000 };
        if (this.collab) this.collab.leases = [lease];
        return ok({ lease });
      }
      case "notes.list":
        return ok({ notes: [], more: false });
      case "runtime.agents":
        return ok({ agents: [{ id: "claude", name: "Claude Code", caps: {}, models: [], modes: [], defaultMode: "bypassPermissions" }] });
      case "pty.list":
        return ok({ epoch: this.epoch, terminals: this.terminals });
      case "pty.attach":
        return ok({ subscriptionId: `sub-${++this.subscription}`, epoch: this.epoch, offset: 0, data: "", truncated: false, exited: false, control: "you", cols: 80, rows: 24 });
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
  mocks.refreshCatalog.mockClear();
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
    // The connection chip says only that it is live; the role chip says what this attachment may do.
    expect(screen.getByTestId("session-connection").textContent).toBe("Live");
    expect(screen.getAllByTestId("cloud-access-chip").map((chip) => chip.textContent)).toEqual(["View only"]);
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
    expect(seen).toEqual(["Resuming", "Connecting…", "Connecting…", "Connecting…", "Live"]);
  });

  it("says Connecting…, not Starting, while it attaches to a workspace that is already running", async () => {
    // A member opens a session someone else has live: nothing is starting.
    setCatalog(workspaceItem("ready", "participate"));
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    const chip = () => screen.getByTestId("session-connection").textContent;
    await act(async () => runtime.emit({ state: "opening" }));
    expect(chip()).toBe("Connecting…");
    await act(async () => runtime.emit({ state: "waitingForRuntime" }));
    expect(chip()).toBe("Connecting…");
    await act(async () => runtime.emit({ state: "connecting", attempt: 1 }));
    expect(chip()).toBe("Connecting…");
    runtime.tabs = [tabInfo()];
    await act(async () => runtime.connect("participate"));
    expect(chip()).toBe("Live");
    expect(activate).not.toHaveBeenCalled();
  });

  it("says Starting only while the workspace is being provisioned or resumed", async () => {
    setCatalog(workspaceItem("provisioning"));
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.emit({ state: "waitingForRuntime" }));
    expect(screen.getByTestId("session-connection").textContent).toBe("Starting");
    expect(cloudConnectionChip({ state: "waitingForRuntime" }, "ready").label).toBe("Connecting…");
    expect(cloudConnectionChip({ state: "waitingForRuntime" }, null).label).toBe("Connecting…");
    // Stopped by the list and nothing resumes it: the transport is still finding out. Nothing is starting.
    expect(cloudConnectionChip({ state: "waitingForRuntime" }, "suspended").label).toBe("Stopped");
    expect(cloudConnectionChip({ state: "waitingForRuntime" }, "suspended", { starting: true }).label).toBe("Starting");
    expect(cloudConnectionChip({ state: "waitingForRuntime" }, "ready", { starting: true }).label).toBe("Starting");
    const resuming = { ...workspaceItem("suspended"), latestOperation: { state: "running", action: "resume" } } as CloudWorkspaceListItem;
    const stopping = { ...workspaceItem("ready"), latestOperation: { state: "running", action: "suspend" } } as CloudWorkspaceListItem;
    expect(workspaceStarting(resuming)).toBe(true);
    expect(workspaceStarting(stopping)).toBe(false);
    expect(workspaceStarting(workspaceItem("ready"))).toBe(false);
    expect(workspaceStarting(null)).toBe(false);
  });

  it("says Stopping… while a stop runs, whoever asked, then Stopped: never Starting or Live", async () => {
    const stoppingItem = { ...workspaceItem("ready"), latestOperation: { state: "running", action: "suspend" } } as CloudWorkspaceListItem;
    setCatalog(stoppingItem);
    runtime.tabs = [tabInfo()];
    const view = render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    const chip = () => screen.getByTestId("session-connection").textContent;
    // Still connected to the runtime that is going down.
    await act(async () => runtime.connect("manage"));
    expect(chip()).toBe("Stopping…");
    for (const state of [{ state: "reconnecting", attempt: 1, reason: "4100 runtime gone", retryInMs: 250 }, { state: "opening" }, { state: "waitingForRuntime" }, { state: "connecting", attempt: 2 }] as WorkspaceConnectionState[]) {
      await act(async () => runtime.emit(state));
      expect(chip()).toBe("Stopping…");
    }
    // The stop finished before the transport found out.
    await act(async () => {
      setCatalog(workspaceItem("suspended"));
      view.rerender(wrap(<CloudHarness />));
    });
    expect(chip()).toBe("Stopped");
    await act(async () => runtime.emit({ state: "suspended" }));
    expect(chip()).toBe("Stopped");
    expect(activate).not.toHaveBeenCalled();

    // The chip itself: a stop wins over a wake this desktop asked for earlier, and over a live transport.
    const live: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: [], authority: "manage" };
    expect(cloudConnectionChip(live, "ready", { stopping: true })).toEqual({ label: "Stopping…", tone: "pending" });
    expect(cloudConnectionChip({ state: "waitingForRuntime" }, "ready", { stopping: true, woke: true }).label).toBe("Stopping…");
    expect(cloudConnectionChip({ state: "waitingForRuntime" }, "suspended", { stopping: true }).label).toBe("Stopping…");
    expect(cloudConnectionChip(live, "ready").label).toBe("Live");
    // Attaching again after the workspace came back: Reconnecting… until the transport is up, then Live.
    expect(cloudConnectionChip({ state: "idle" }, "ready", { reattaching: true }).label).toBe("Reconnecting…");
    expect(cloudConnectionChip({ state: "opening" }, "ready", { reattaching: true }).label).toBe("Reconnecting…");
    expect(cloudConnectionChip({ state: "suspended" }, "ready", { reattaching: true }).label).toBe("Reconnecting…");
    expect(cloudConnectionChip(live, "ready", { reattaching: true }).label).toBe("Live");
    expect(cloudConnectionChip({ state: "idle" }, "ready").label).toBe("Not connected");
    expect(workspaceStarting(stoppingItem)).toBe(false);
  });
});

// Found in a live two-user test: Alice (the owner) has the session open and
// stops the workspace; Bob sends a message, the mailbox wakes it, and a new
// runtime generation comes up. Alice's pane stayed on the old client: the chip
// read "Live" (from the list), nothing arrived, and "Take the wheel" failed
// with "RPC transport unavailable: lease.acquire" until she restarted the app.
describe("an open session whose workspace stops and is woken by someone else", () => {
  const ALICE = { userId: "u-me", role: "manager", canApprove: true };
  const target = { kind: "cloud", organizationId: ORG, workspaceId: WS };
  const chip = () => screen.getByTestId("session-connection").textContent;
  /** The workspace list as it was asked for at `requestedAt`. */
  const listed = (state: CloudWorkspaceListItem["workspace"]["state"], requestedAt: number, action: "suspend" | "resume" | null = null) => {
    const item = workspaceItem(state, "manage");
    item.workspace.accessMode = "organization";
    item.workspace.you = { role: "manager", canApprove: true };
    item.workspace.sharedWith = 2;
    if (action) item.latestOperation = { state: "running", action } as CloudWorkspaceListItem["latestOperation"];
    mocks.catalog.orgs = { [ORG]: { orgId: ORG, workspaces: [item], repositories: null, repositoriesAt: null, quota: null, fetchedAt: requestedAt, requestedAt, source: "live", error: null } };
  };
  const people = () => {
    guard.handlers.organization_members = () => ({ members: [{ userId: "u-bob", email: "bob@example.com", displayName: "Bob", role: "member" }], pendingInvites: [], viewerRole: "owner", canManageMembers: true, removedOnDelete: [], runtimeFacts: { available: true }, contextRevision: "r" });
  };
  let woken: FakeRuntime;
  let wokenClient: WorkspaceRpcClient;
  let closedFirst: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    people();
    runtime.collab = { you: ALICE, participants: [], leases: [] };
    // What Bob's wake brings up: another runtime generation and process, reached over another attachment.
    woken = new FakeRuntime();
    woken.generation = 4;
    woken.epoch = "e2";
    wokenClient = new WorkspaceRpcClient(woken);
    // The api layer closes a connection's client with it.
    closedFirst = vi.fn(() => client.close());
    mocks.workspaceConnection
      .mockReset()
      .mockImplementationOnce(async () => ({ target, client, activate, close: closedFirst }))
      .mockImplementation(async () => ({ target, client: wokenClient, activate, close: vi.fn() }));
  });
  afterEach(() => {
    wokenClient.close();
    // The roster is read once per session; the next test names its own people.
    resetPeople();
  });

  async function openAsAlice() {
    listed("ready", 1);
    runtime.tabs = [tabInfo()];
    const view = render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1));
    await act(async () => runtime.connectShared(ALICE, "manage"));
    await screen.findByText("Fix login redirect");
    await waitFor(() => expect(runtime.methods("collab.state").length).toBeGreaterThan(0));
    expect(chip()).toBe("Live");
    return () => view.rerender(wrap(<CloudHarness />));
  }

  it("attaches fresh with connect, subscribes again, shows the other person's turn and lease, and reads Live only once the transport is up", async () => {
    const relist = await openAsAlice();

    // Alice stops it. The list has the operation: Stopping…, never Starting, and not Live for the whole stop.
    await act(async () => {
      listed("ready", Date.now(), "suspend");
      relist();
    });
    expect(chip()).toBe("Stopping…");
    await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "4100 runtime gone", retryInMs: 250 }));
    expect(chip()).toBe("Stopping…");
    await act(async () => runtime.emit({ state: "waitingForRuntime" }));
    expect(chip()).toBe("Stopping…");
    await act(async () => {
      listed("suspended", Date.now());
      relist();
    });
    // The transport has not found out yet: Stopped, not Starting.
    expect(chip()).toBe("Stopped");
    await act(async () => runtime.emit({ state: "suspended" }));
    expect(chip()).toBe("Stopped");
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);

    // Bob sends: the mailbox wakes the workspace, his turn runs in a new runtime generation, and he drives the tab.
    woken.tabs = [tabInfo({ status: "idle", lastSeq: seq + 2 })];
    woken.events = [ev({ type: "user_message", text: "bob asks from his desktop", queued: false }), ev({ type: "assistant_text", text: "the answer to bob" })];
    woken.collab = {
      you: ALICE,
      participants: [{ userId: "u-bob", role: "driver", canApprove: false, surfaces: 1, tabId: "t-1", activity: "viewing", since: 1 }],
      leases: [{ tabId: "t-1", holderId: "u-bob", acquiredAt: 1, expiresAt: Date.now() + 60_000 }],
    };
    // A list asked for after the transport stopped says the machine runs again.
    await act(async () => {
      listed("ready", Date.now() + 1_000);
      relist();
    });
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalledTimes(2));
    // A fresh attachment, and the old client is torn down.
    expect(closedFirst).toHaveBeenCalledTimes(1);
    // The list says ready, but the transport is not up: Reconnecting…, never Live.
    expect(chip()).toBe("Reconnecting…");
    await act(async () => woken.emit({ state: "connecting", attempt: 1 }));
    expect(chip()).toBe("Reconnecting…");

    await act(async () => woken.connectShared(ALICE, "manage"));
    expect(chip()).toBe("Live");
    // Everything is read and subscribed again on the new runtime.
    await waitFor(() => {
      for (const method of ["session.tabs", "session.list", "session.subscribe", "collab.state", "pty.list", "git.repositories"]) {
        expect(woken.methods(method).length, method).toBeGreaterThan(0);
      }
    });
    // Bob's turn, which ran while this pane had no connection, is here.
    expect(await screen.findByText("bob asks from his desktop")).toBeTruthy();
    expect(await screen.findByText("the answer to bob")).toBeTruthy();
    // So is his lease: never "No one is driving" while he drives.
    await waitFor(() => expect(screen.getByTestId("cloud-agent-driver").textContent).toBe("Driving: Bob"));
    expect((await screen.findAllByTestId("session-presence-person")).length).toBe(1);

    // Events flow on the new subscription.
    await act(async () => woken.stream(ev({ type: "assistant_text", text: "streamed after the wake" })));
    expect(await screen.findByText("streamed after the wake")).toBeTruthy();

    // Lease RPC works: no "RPC transport unavailable".
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(woken.methods("lease.takeOver")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("cloud-agent-driver").textContent).toBe("You are driving"));
    expect(screen.getByTestId("cloud-agent-lease").textContent).not.toContain("RPC transport unavailable");

    // Looking never wakes compute: both attachments were `connect`, nothing was raised to `wake`, nothing resumed.
    expect(mocks.workspaceConnection.mock.calls.map((call) => call[1])).toEqual(["connect", "connect"]);
    expect(activate).not.toHaveBeenCalled();
    expect(guard.calls.map((call) => call.command)).not.toContain("cloud_workspace_resume");
    expect(guard.violations).toEqual([]);
    // Nothing was sent to the runtime that was stopped.
    expect(runtime.methods("lease.takeOver")).toEqual([]);
  });

  it("never reads Live over a connection that was closed underneath the view", async () => {
    await openAsAlice();
    // Closed for good (the workspace was deleted here): the view's lease is over.
    await act(async () => closeCloudConnection({ orgId: ORG, workspaceId: WS }));
    expect(closedFirst).toHaveBeenCalledTimes(1);
    expect(chip()).not.toBe("Live");
    expect(screen.queryByTestId("cloud-agent-lease")).toBeNull();
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
  });

  it("stays Stopped, and attaches nothing, while only an older list says the workspace runs", async () => {
    const relist = await openAsAlice();
    await act(async () => runtime.emit({ state: "suspended" }));
    // The list in hand was asked for before the transport stopped: it is the stale one, and is read again.
    expect(chip()).toBe("Stopped");
    await waitFor(() => expect(mocks.refreshCatalog).toHaveBeenCalledWith(ORG));
    await act(async () => {
      listed("suspended", Date.now());
      relist();
    });
    expect(chip()).toBe("Stopped");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
  });
});

// Found in the same test: after a reconnect Bob's pane kept "chunk 98 of 150"
// and "Working" for 40 s or more after the turn had finished.
describe("a turn that finished while this desktop was away", () => {
  afterEach(() => resetPeople());

  it("is not left Working after a reconnect: the runtime's tab list and the transcript tail are read again", async () => {
    runtime.tabs = [tabInfo({ status: "in_progress" })];
    runtime.events = [ev({ type: "user_message", text: "count to 150", queued: false }), ev({ type: "assistant_text", text: "chunk 98 of 150" })];
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connect("manage"));
    expect(await screen.findByText("chunk 98 of 150")).toBeTruthy();
    expect(within(composer()).getByRole("button", { name: "Queue" })).toBeTruthy();
    const tabReads = runtime.methods("session.tabs").length;
    const subscriptions = runtime.methods("session.subscribe").length;

    // The link drops; the turn finishes meanwhile, and its status change is never delivered.
    await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "4104 relay restarting", retryInMs: 250 }));
    runtime.tabs = [tabInfo({ status: "completed" })];
    runtime.events = [...runtime.events, ev({ type: "assistant_text", text: "chunk 150 of 150" }), ev({ type: "turn_completed", status: "ok", authFailed: false })];
    await act(async () => runtime.connect("manage"));

    await waitFor(() => expect(runtime.methods("session.tabs").length).toBeGreaterThan(tabReads));
    await waitFor(() => expect(runtime.methods("session.subscribe").length).toBeGreaterThan(subscriptions));
    expect(await screen.findByText("chunk 150 of 150")).toBeTruthy();
    await waitFor(() => expect(within(composer()).getByRole("button", { name: "Send" })).toBeTruthy());
    expect(within(composer()).queryByRole("button", { name: "Queue" })).toBeNull();
    expect(guard.violations).toEqual([]);
  });

  it("is not left Working while the connection is away: the checkpoint says it finished", async () => {
    runtime.tabs = [tabInfo({ status: "in_progress", lastSeq: seq + 2 })];
    runtime.events = [ev({ type: "user_message", text: "count to 150", queued: false }), ev({ type: "assistant_text", text: "chunk 98 of 150" })];
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connect("manage"));
    expect(await screen.findByText("chunk 98 of 150")).toBeTruthy();
    expect(within(composer()).getByRole("button", { name: "Queue" })).toBeTruthy();

    // The turn finishes and is checkpointed while this desktop cannot reach the runtime.
    const tail = [ev({ type: "assistant_text", text: "chunk 150 of 150" }), ev({ type: "turn_completed", status: "ok", authFailed: false })];
    guard.handlers.cloud_agent_checkpoint = () => ({
      epoch: 1,
      version: 2,
      projection: { v: 1, tabId: "t-1", sessionId: "s-1", title: "Fix login", harness: "claude", model: "", effort: null, permissionMode: "bypassPermissions", status: "idle", process: "running", followUps: [], events: tail, truncated: false, updatedAt: 2 },
    });
    const sent = runtime.sent.length;
    await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "4104 relay restarting", retryInMs: 250 }));
    expect(screen.getByTestId("session-connection").textContent).toBe("Reconnecting…");
    expect(await screen.findByText("chunk 150 of 150")).toBeTruthy();
    await waitFor(() => expect(within(composer()).getByRole("button", { name: "Send" })).toBeTruthy());
    // Only a checkpoint was read: nothing went to the runtime, and nothing was woken.
    expect(runtime.sent.length).toBe(sent);
    expect(activate).not.toHaveBeenCalled();
    expect(guard.violations).toEqual([]);
  });

  it("is not left Working when a share comes back on the connection that was kept", async () => {
    const ME = { userId: "u-me", role: "driver", canApprove: false };
    const item = workspaceItem("ready", "participate");
    item.workspace.accessMode = "organization";
    item.workspace.you = { role: "driver", canApprove: false };
    setCatalog(item);
    guard.handlers.organization_members = () => ({ members: [], pendingInvites: [], viewerRole: "member", canManageMembers: false, removedOnDelete: [], runtimeFacts: { available: true }, contextRevision: "r" });
    runtime.collab = { you: ME, participants: [], leases: [] };
    runtime.tabs = [tabInfo({ status: "in_progress" })];
    runtime.events = [ev({ type: "user_message", text: "count to 150", queued: false }), ev({ type: "assistant_text", text: "chunk 98 of 150" })];
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connectShared(ME));
    expect(await screen.findByText("chunk 98 of 150")).toBeTruthy();

    // The share is revoked mid-turn; the turn finishes; then the workspace is shared again. No reconnect happens.
    await act(async () => runtime.notify("collab.you", { you: { ...ME, role: "none", listed: true } }));
    await screen.findByTestId("cloud-access-removed");
    const tabReads = runtime.methods("session.tabs").length;
    runtime.tabs = [tabInfo({ status: "completed" })];
    runtime.events = [...runtime.events, ev({ type: "assistant_text", text: "chunk 150 of 150" }), ev({ type: "turn_completed", status: "ok", authFailed: false })];
    runtime.collab.you = ME;
    await act(async () => runtime.notify("collab.you", { you: { ...ME, listed: true } }));
    await waitFor(() => expect(screen.queryByTestId("cloud-access-removed")).toBeNull());

    await waitFor(() => expect(runtime.methods("session.tabs").length).toBeGreaterThan(tabReads));
    expect(await screen.findByText("chunk 150 of 150")).toBeTruthy();
    await waitFor(() => expect(within(composer()).queryByRole("button", { name: "Queue" })).toBeNull());
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    expect(guard.violations).toEqual([]);
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
    // No "View only": a driver sends through the mailbox like a manager, and the chips say so.
    expect(screen.queryAllByRole("note").some((note) => note.textContent?.startsWith("View only"))).toBe(false);
    expect(screen.getAllByTestId("cloud-access-chip").map((chip) => chip.textContent)).toEqual(["Driver"]);
    expect(screen.getByTestId("session-connection").textContent).toBe("Live");
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

// The live two-user test of PRO-30: what each person was shown, and what they must be shown instead.
describe("sharing states found in the live two-user test", () => {
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
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connectShared(you));
    await screen.findByText("Fix login redirect");
    await waitFor(() => expect(runtime.methods("collab.state").length).toBeGreaterThan(0));
  }
  const chips = () => screen.queryAllByTestId("cloud-access-chip").map((chip) => chip.textContent);
  /** The runtime's member list changed this person's role: `collab.you`, and `collab.state` agrees from then on. */
  const becomes = (role: string, canApprove = false) => {
    const you = { userId: "u-me", role, canApprove };
    if (runtime.collab) runtime.collab.you = you;
    runtime.notify("collab.you", { you: { ...you, listed: true } });
  };

  it("replaces the open session with the lock pane when the share is revoked, and clears every stale control", async () => {
    names();
    setCatalog(shared("driver", true));
    const me = { ...ME, canApprove: true };
    runtime.tabs = [tabInfo({ status: "in_progress" })];
    runtime.collab = {
      you: me,
      participants: [
        { userId: "u-me", role: "driver", canApprove: true, surfaces: 1, tabId: "t-1", activity: "viewing", since: 1 },
        { userId: "u-alice", role: "manager", canApprove: true, surfaces: 1, tabId: "t-1", activity: "viewing", since: 2 },
      ],
      leases: [{ tabId: "t-1", holderId: "u-me", acquiredAt: 1, expiresAt: Date.now() + 60_000 }],
    };
    const closed = vi.fn();
    mocks.workspaceConnection.mockImplementation(async () => ({ target: { kind: "cloud", organizationId: ORG, workspaceId: WS }, client, activate, close: closed }));
    await openShared(me);
    // Driving a running turn: the lease bar, Stop, Notes and the other person are all there.
    await waitFor(() => expect(screen.getByTestId("cloud-agent-driver").textContent).toBe("You are driving"));
    expect(screen.getByRole("button", { name: "Release" })).toBeTruthy();
    expect(within(composer()).getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
    expect(await screen.findAllByTestId("session-presence-person")).toHaveLength(1);

    // Alice revokes the share: the runtime tells this connection its role is none.
    await act(async () => runtime.notify("collab.you", { you: { userId: "u-me", role: "none", canApprove: false, listed: true } }));

    const pane = await screen.findByTestId("cloud-access-removed");
    expect(pane.textContent).toContain("Your access to this workspace was removed.");
    expect(within(pane).getByRole("button", { name: "Back" })).toBeTruthy();
    // Nothing of the session stays: no transcript, composer, lease, Stop, Notes, presence or "live" chip.
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.queryByTestId("cloud-agent-lease")).toBeNull();
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Notes/ })).toBeNull();
    expect(screen.queryByTestId("session-presence")).toBeNull();
    expect(screen.queryByTestId("session-connection")).toBeNull();
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
    expect(screen.queryByText("Fix login redirect")).toBeNull();
    expect(chips()).toEqual(["Not shared"]);
    // The list is read again so the sidebar row follows. The connection stays (it costs nothing and
    // never wakes): nothing is reconnected, and a new share would arrive on it as `collab.you`.
    await waitFor(() => expect(mocks.refreshCatalog).toHaveBeenCalledWith(ORG));
    expect(closed).not.toHaveBeenCalled();
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    expect(guard.violations).toEqual([]);

    // Back leaves the session.
    selectCloudSession(KEY);
    fireEvent.click(within(pane).getByRole("button", { name: "Back" }));
    expect(getSessionStore().selectedSessionId).toBeNull();
  });

  it("stops reconnecting when the workspace can no longer be opened at all (made private again)", async () => {
    names();
    setCatalog(shared("viewer"));
    runtime.collab = { you: { ...ME, role: "viewer" }, participants: [], leases: [] };
    const closed = vi.fn();
    mocks.workspaceConnection.mockImplementation(async () => ({ target: { kind: "cloud", organizationId: ORG, workspaceId: WS }, client, activate, close: closed }));
    await openShared({ ...ME, role: "viewer" });
    // The runtime closes the connection; the next `open` answers that the workspace is not there for this person.
    await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "cloud_workspace_not_found", retryInMs: 250 }));
    expect((await screen.findByTestId("cloud-access-removed")).textContent).toContain("Your access to this workspace was removed.");
    await waitFor(() => expect(closed).toHaveBeenCalled());
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.queryByTestId("session-connection")).toBeNull();
  });

  it("names a workspace gone from this person's list once, and offers no empty menu on its chip", async () => {
    names();
    const item = shared("viewer");
    // A blank project: the workspace, its project and an untitled session all go by one name.
    item.workspace.repositories = [];
    item.workspace.name = "share-demo";
    setCatalog(item);
    const catalogModule = await import("@/lib/cloudCatalog");
    catalogModule.resetCloudCatalog();
    runtime.collab = { you: { ...ME, role: "viewer" }, participants: [], leases: [] };
    await openShared({ ...ME, role: "viewer" });

    // Made private again before this launch ever listed it: there is no name to show.
    mocks.catalog.orgs = { [ORG]: { orgId: ORG, workspaces: [], repositories: null, repositoriesAt: null, quota: null, fetchedAt: 2, source: "live", error: null } };
    await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "cloud_workspace_not_found", retryInMs: 250 }));
    await screen.findByTestId("cloud-access-removed");
    const crumb = screen.getByTestId("session-breadcrumb");
    // One neutral title, not "Cloud workspace / Cloud workspace".
    expect(screen.getByTestId("session-title").textContent).toBe("Cloud workspace");
    expect(screen.queryByTestId("session-project")).toBeNull();
    expect(crumb.textContent?.match(/Cloud workspace/g)).toHaveLength(1);
    // The chip says where it ran; with nothing to act on it is not a menu.
    const chip = screen.getByTestId("session-location");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText("Not in the workspace list")).toBeNull();
  });

  it("keeps the names the sidebar last showed for a workspace that left the list", async () => {
    names();
    const item = shared("viewer");
    const catalogModule = await import("@/lib/cloudCatalog");
    catalogModule.resetCloudCatalog();
    await catalogModule.ingestCloudList({ workspaces: [item] }, ORG);
    setCatalog(item);
    runtime.collab = { you: { ...ME, role: "viewer" }, participants: [], leases: [] };
    await openShared({ ...ME, role: "viewer" });
    mocks.catalog.orgs = { [ORG]: { orgId: ORG, workspaces: [], repositories: null, repositoriesAt: null, quota: null, fetchedAt: 2, source: "live", error: null } };
    await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "cloud_workspace_not_found", retryInMs: 250 }));
    await screen.findByTestId("cloud-access-removed");
    // Project and workspace as this person already saw them; the session's own title is not shown to someone locked out.
    expect(screen.getByTestId("session-project").textContent).toBe("acme/api");
    expect(screen.getByTestId("session-title").textContent).toBe("login-fix");
    expect(screen.getByTestId("session-location").tagName).toBe("SPAN");
    catalogModule.resetCloudCatalog();
  });

  it("keeps a plain network drop as a reconnect, never as lost access", async () => {
    names();
    setCatalog(shared("driver"));
    runtime.collab = { you: ME, participants: [], leases: [{ tabId: "t-1", holderId: "u-me", acquiredAt: 1, expiresAt: Date.now() + 60_000 }] };
    await openShared(ME);
    await waitFor(() => expect(screen.getByTestId("cloud-agent-driver").textContent).toBe("You are driving"));
    await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "4104 relay restarting", retryInMs: 250 }));
    expect(screen.getByTestId("session-connection").textContent).toBe("Reconnecting…");
    expect(screen.queryByTestId("cloud-access-removed")).toBeNull();
    // While reconnecting the lease bar is gone, and this person is never named as "someone else driving".
    expect(screen.queryByTestId("cloud-agent-lease")).toBeNull();
    expect(screen.queryAllByRole("note").some((note) => /is driving this tab/.test(note.textContent ?? ""))).toBe(false);
  });

  it("shows the lock pane, not the cached transcript, when a revoked person opens the session again", async () => {
    setCatalog(shared("none"));
    cache["t-1"] = { tab: tabInfo({ status: "in_progress" }), events: [ev({ type: "user_message", text: "the secret plan", queued: false })], cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1 };
    render(wrap(<CloudHarness />));
    const pane = await screen.findByTestId("cloud-access-removed");
    expect(pane.textContent).toContain("Your access to this workspace was removed.");
    await act(async () => undefined);
    expect(screen.queryByText("the secret plan")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
    // Named after its workspace: no session title, no "Cloud session".
    expect(screen.getByTitle("login-fix").textContent).toBe("login-fix");
    expect(screen.queryByText("Cloud session")).toBeNull();
    expect(chips()).toEqual(["Not shared"]);
    // Looking never wakes anything, locked or not.
    expect(activate).not.toHaveBeenCalled();
    expect(guard.violations).toEqual([]);
  });

  it("shows an unshared member one lock pane and one chip, with no phantom tab or loading text", async () => {
    setCatalog(shared("none"));
    render(wrap(<CloudHarness />));
    const pane = await screen.findByTestId("cloud-not-shared");
    expect(pane.textContent).toContain("This workspace has not been shared with you");
    expect(within(pane).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(chips()).toEqual(["Not shared"]);
    expect(screen.queryByTestId("session-connection")).toBeNull();
    expect(screen.queryByText("Loading the session…")).toBeNull();
    expect(screen.queryByText(/Add an agent tab/)).toBeNull();
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
    expect(activate).not.toHaveBeenCalled();
    // Connected with role none (the runtime agrees with the list, and hands over no tabs): still the same pane and chip, never "removed".
    runtime.tabs = [];
    await act(async () => runtime.connectShared({ ...ME, role: "none" }));
    expect(screen.getByTestId("cloud-not-shared")).toBeTruthy();
    expect(screen.queryByTestId("cloud-access-removed")).toBeNull();
    expect(chips()).toEqual(["Not shared"]);
    expect(screen.queryByTestId("session-connection")).toBeNull();
  });

  it("opens again within the same connection the moment the workspace is shared again", async () => {
    names();
    setCatalog(shared("viewer"));
    runtime.collab = { you: { ...ME, role: "viewer" }, participants: [], leases: [] };
    await openShared({ ...ME, role: "viewer" });
    await act(async () => runtime.notify("collab.you", { you: { userId: "u-me", role: "none", canApprove: false, listed: true } }));
    await screen.findByTestId("cloud-access-removed");
    await act(async () => becomes("driver"));
    await waitFor(() => expect(screen.queryByTestId("cloud-access-removed")).toBeNull());
    expect(await screen.findByText("Fix login redirect")).toBeTruthy();
    expect(chips()).toEqual(["Driver"]);
    // One connection throughout: nothing was closed or reopened.
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
  });

  it("after a refused reconnect, only a list asked for after the refusal opens the workspace again", async () => {
    names();
    setCatalog(shared("viewer"));
    runtime.collab = { you: { ...ME, role: "viewer" }, participants: [], leases: [] };
    const view = render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connectShared({ ...ME, role: "viewer" }));
    await screen.findByText("Fix login redirect");
    await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "cloud_workspace_not_found", retryInMs: 250 }));
    await screen.findByTestId("cloud-access-removed");
    const before = mocks.workspaceConnection.mock.calls.length;
    // A list that was asked for before the refusal and only answered after it (still "viewer") opens nothing (D8).
    const org = mocks.catalog.orgs[ORG] as { fetchedAt: number; requestedAt?: number };
    org.requestedAt = Date.now() - 60_000;
    org.fetchedAt = Date.now() + 60_000;
    view.rerender(wrap(<CloudHarness />));
    await act(async () => undefined);
    expect(mocks.workspaceConnection.mock.calls.length).toBe(before);
    expect(screen.getByTestId("cloud-access-removed")).toBeTruthy();
    // One asked for after it says driver: the session connects and shows again.
    setCatalog(shared("driver"));
    (mocks.catalog.orgs[ORG] as { requestedAt?: number }).requestedAt = Date.now() + 10_000;
    view.rerender(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection.mock.calls.length).toBe(before + 1));
    await waitFor(() => expect(screen.queryByTestId("cloud-access-removed")).toBeNull());
    expect(await screen.findByText("Fix login redirect")).toBeTruthy();
  });

  // Review D1: the list says shared, the runtime's member list has not caught up (or is stale).
  it("checks access instead of saying removed, and never reconnects, while the list and the runtime disagree", async () => {
    names();
    setCatalog(shared("viewer"));
    runtime.collab = { you: { ...ME, role: "none" }, participants: [], leases: [] };
    const view = render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    // The first connect ever: the hello says role none, listed.
    await act(async () => runtime.connectShared({ ...ME, role: "none" }));
    const pane = await screen.findByTestId("cloud-access-checking");
    expect(pane.textContent).toContain("Checking access…");
    expect(screen.queryByTestId("cloud-access-removed")).toBeNull();
    expect(screen.queryByText(/was removed/)).toBeNull();
    // Neither chip claims anything while it is being checked.
    expect(chips()).toEqual([]);
    expect(screen.queryByTestId("session-connection")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();

    // Every later list still says viewer: nothing reconnects, nothing flashes.
    for (let i = 1; i <= 5; i++) {
      setCatalog(shared("viewer"));
      Object.assign(mocks.catalog.orgs[ORG] as object, { requestedAt: Date.now() + i * 1_000, fetchedAt: Date.now() + i * 1_000 });
      view.rerender(wrap(<CloudHarness />));
      await act(async () => undefined);
      expect(screen.getByTestId("cloud-access-checking")).toBeTruthy();
    }
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);

    // Past the grace period it says so plainly, still without "removed".
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    view.rerender(wrap(<CloudHarness />));
    expect(screen.getByTestId("cloud-access-checking").getAttribute("data-kind")).toBe("pending");
    expect(screen.getByTestId("cloud-access-checking").textContent).toContain("This workspace has not been shared with you yet");
    expect(screen.queryByTestId("cloud-access-removed")).toBeNull();
    clock.mockRestore();
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);

    // The runtime catches up: the session opens at once, on the same connection.
    await act(async () => becomes("viewer"));
    await waitFor(() => expect(screen.queryByTestId("cloud-access-checking")).toBeNull());
    expect(await screen.findByText("Fix login redirect")).toBeTruthy();
    expect(chips()).toEqual(["View only"]);
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
  });

  it("keeps reading the list while the lock pane shows, backing off, so a share made meanwhile is seen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setCatalog(shared("none"));
      render(wrap(<CloudHarness />));
      await screen.findByTestId("cloud-not-shared");
      mocks.refreshCatalog.mockClear();
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(mocks.refreshCatalog).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(mocks.refreshCatalog).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(20_000));
      expect(mocks.refreshCatalog).toHaveBeenCalledTimes(3);
      // Capped at 30 s, and only ever a list.
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(mocks.refreshCatalog).toHaveBeenCalledTimes(5);
      expect(mocks.refreshCatalog).toHaveBeenLastCalledWith(ORG);
      expect(activate).not.toHaveBeenCalled();
      // Leaving the pane stops it.
      cleanup();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mocks.refreshCatalog).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a viewer exactly one role chip beside a plain connection chip", async () => {
    names();
    setCatalog(shared("viewer"));
    runtime.collab = { you: { ...ME, role: "viewer" }, participants: [], leases: [] };
    await openShared({ ...ME, role: "viewer" });
    expect(chips()).toEqual(["View only"]);
    expect(screen.getByTestId("session-connection").textContent).toBe("Live");
  });

  it("offers the header chip's Stop, Archive and Delete to an admin only, and a viewer the read-only share list", async () => {
    names();
    const viewer = shared("viewer");
    viewer.workspace.you = { role: "viewer", canApprove: false, canManageShares: false };
    setCatalog(viewer);
    runtime.collab = { you: { ...ME, role: "viewer" }, participants: [], leases: [] };
    await openShared({ ...ME, role: "viewer" });
    mouseClick(screen.getByTestId("session-location"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual([
      "Who has access…2",
      "Only an organization owner or admin can stop, archive or delete a cloud workspace",
    ]);
    expect(within(menu).queryByRole("menuitem", { name: /^(Stop|Archive|Delete)/ })).toBeNull();
    cleanup();

    // An admin (a manager, on a manage attachment) keeps all of them, with Share… first.
    resetCloudConnections();
    const admin = shared("manager", true);
    admin.workspace.you = { role: "manager", canApprove: true, canManageShares: true };
    admin.workspace.authority = "manage";
    setCatalog(admin);
    const boss = { userId: "u-me", role: "manager", canApprove: true };
    runtime.collab = { you: boss, participants: [], leases: [] };
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connectShared(boss, "manage"));
    await screen.findByText("Fix login redirect");
    // A manager needs no role chip.
    expect(chips()).toEqual([]);
    mouseClick(screen.getByTestId("session-location"));
    expect(within(await screen.findByRole("menu")).getAllByRole("menuitem").map((entry) => entry.textContent?.trim())).toEqual([
      "Share…2",
      "Stop",
      "Archive… (stops compute, deleted after 30 days)",
      "Delete…",
    ]);
  });

  it("shows one loading state while a member's session connects, named after its workspace", async () => {
    setCatalog(shared("viewer"));
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.emit({ state: "connecting", attempt: 1 }));
    expect(screen.getByTestId("cloud-session-loading").textContent).toBe("Loading the session…");
    expect(screen.queryByText(/Add an agent tab/)).toBeNull();
    expect(screen.queryByText("Cloud session")).toBeNull();
    expect(screen.getByTitle("login-fix").textContent).toBe("login-fix");
  });

  it("sends an approving driver's setting change with the next message and says so, instead of a refused live configure", async () => {
    names();
    setCatalog(shared("driver", true));
    const me = { ...ME, canApprove: true };
    runtime.collab = { you: me, participants: [], leases: [] };
    await openShared(me);
    expect(screen.queryByTestId("settings-locked")).toBeNull();
    expect(screen.queryByTestId("settings-note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan mode" }));
    // Not the live `session.configure` (it needs manage): the change waits for the next message, and the composer says so.
    expect((await screen.findByTestId("settings-note")).textContent).toBe("Model, effort and mode changes apply with your next message");
    expect(runtime.methods("session.configure")).toEqual([]);
    expect(screen.queryAllByRole("note").some((note) => /forbidden|Could not/.test(note.textContent ?? ""))).toBe(false);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "plan it first" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(enqueued.find((entry) => entry.kind === "send")?.payload).toEqual({ text: "plan it first", mode: "plan" }));
    await waitFor(() => expect(screen.queryByTestId("settings-note")).toBeNull());
    expect(guard.violations).toEqual([]);
  });

  it("does not promise a setting change to someone who lost approval rights, and sends the message without it", async () => {
    names();
    setCatalog(shared("driver", true));
    const me = { ...ME, canApprove: true };
    runtime.collab = { you: me, participants: [], leases: [] };
    await openShared(me);
    fireEvent.click(screen.getByRole("button", { name: "Plan mode" }));
    expect((await screen.findByTestId("settings-note")).textContent).toBe("Model, effort and mode changes apply with your next message");
    // The grant to approve is taken back before the next message.
    await act(async () => runtime.notify("collab.you", { you: { userId: "u-me", role: "driver", canApprove: false, listed: true } }));
    await waitFor(() => expect(screen.queryByTestId("settings-note")).toBeNull());
    expect(await screen.findByTestId("settings-locked")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "carry on" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(enqueued.find((entry) => entry.kind === "send")?.payload).toEqual({ text: "carry on" }));
    const note = await screen.findByTestId("settings-note");
    expect(note.textContent).toBe("Your model, effort or mode change was not applied: you can no longer approve permissions");
    expect(note.getAttribute("data-warning")).toBe("true");
  });

  it("tells someone who may not approve which command is waiting", async () => {
    names();
    setCatalog(shared("driver"));
    runtime.collab = { you: ME, participants: [], leases: [] };
    runtime.events = [
      ev({ type: "permission_requested", requestId: "req-1", toolUseId: "tool-1", toolName: "Bash", input: { command: "touch /tmp/bob-asked" }, options: [{ id: "allow", label: "Allow", kind: "allow_once" }] } as Payload),
    ];
    runtime.tabs = [tabInfo({ status: "waiting" })];
    render(wrap(<CloudHarness />));
    await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
    await act(async () => runtime.connectShared(ME));
    await screen.findByText(/Waiting for permission to run a command/);
    expect((await screen.findByTestId("permission-detail")).textContent).toBe("touch /tmp/bob-asked");
    expect(screen.getByTestId("answer-blocked").textContent).toBe("Waiting for someone who can approve");
  });

  it("marks notes that arrive while the drawer is closed, until it is opened", async () => {
    names();
    setCatalog(shared("driver"));
    runtime.collab = { you: ME, participants: [], leases: [] };
    await openShared(ME);
    expect(screen.queryByTestId("cloud-notes-unread")).toBeNull();
    const note = (id: string, authorId: string) => ({ id, tabId: "t-1", authorId, text: `note ${id}`, createdAt: Number(id.slice(1)) });
    await act(async () => runtime.notify("notes.posted", { note: note("n1", "u-alice") }));
    await act(async () => runtime.notify("notes.posted", { note: note("n2", "u-alice") }));
    // This person's own note is not unread.
    await act(async () => runtime.notify("notes.posted", { note: note("n3", "u-me") }));
    expect(screen.getByTestId("cloud-notes-unread").textContent).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Notes, 2 unread" }));
    await screen.findByTestId("cloud-agent-notes");
    expect(screen.queryByTestId("cloud-notes-unread")).toBeNull();
    // Read as they arrive while it is open.
    await act(async () => runtime.notify("notes.posted", { note: note("n4", "u-alice") }));
    expect(screen.queryByTestId("cloud-notes-unread")).toBeNull();
    expect(screen.getAllByTestId("cloud-note")).toHaveLength(4);
  });
});
