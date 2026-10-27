import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import type { AgentEvent, Payload } from "@/types/events";
import type { SessionEntry } from "@/types/session";
import { page as browserPage } from "@/test/tabsBackend";
import { refreshBrowserPages } from "@/lib/browser";
import { guardedApi } from "@/test/guardedApi";

// PRO-86: the chat / terminal switch on local and cloud agent tabs. The cloud
// runtime is a fake behind the real workspace client; nothing here reaches a
// real VM.
const mocks = vi.hoisted(() => ({
  guard: null as unknown as ReturnType<typeof import("@/test/guardedApi").guardedApi>,
  workspaceConnection: vi.fn(),
  catalog: { owner: "me", revision: "r", loaded: true, orgs: {} as Record<string, unknown>, createMemory: {}, notices: [] },
  prefs: { panelOpen: false, panelWidth: 360, sidebarOpen: true, tabStrip: false, lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", useWorktree: true, shortcuts: {} as Record<string, string[]> },
  createTerminal: (): unknown => undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args?: Record<string, unknown>) => mocks.guard.invoke(command, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), workspaceConnection: mocks.workspaceConnection, hasWorkspaceConnection: () => true }));
vi.mock("@/lib/cloudCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudCatalog")>()),
  useCloudCatalog: () => mocks.catalog,
  refreshCloudCatalog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-in", identity: { name: null, email: "a@b.c", organization: "Acme", organizationId: "org-1" }, expiresAt: null, lastError: null, organizations: [{ id: "org-1", name: "Acme", role: "member" }] } };
  return { useAccount: () => account, getAccount: () => account, subscribeAccount: () => () => undefined, refreshAccount: vi.fn() };
});
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => mocks.prefs, getPrefs: () => mocks.prefs, setPrefs: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  EFFORT_LABEL: {},
  DEFAULT_PERMISSION_MODE: "bypassPermissions",
  PERMISSION_MODES: [{ id: "bypassPermissions", label: "Bypass permissions", hint: "" }],
  useModels: () => [],
  loadModels: vi.fn(),
}));
// The view is a box that says which terminal it shows and whether it fits itself; the xterm is the test's.
vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: ({ id, visible, fit }: { id: string; visible: boolean; fit?: boolean }) => (
    <div data-testid="xterm" data-visible={String(visible)} data-fit={String(fit !== false)}>
      {id}
    </div>
  ),
  createTerminal: () => mocks.createTerminal(),
}));
vi.mock("@/components/browser/BrowserView", () => ({ BrowserView: () => <div data-testid="browser-view" /> }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));
vi.mock("@/components/chat/Composer", async () => {
  const { useEffect } = await import("react");
  type Props = { draft: string; onDraftChange: (v: string) => void; onSend: (t: string, i: unknown[]) => Promise<void>; disabledReason?: string | null; commands?: { key: string; load(): Promise<unknown> } | null };
  return {
    Composer: (props: Props) => {
      // As the real composer does: it asks where its `/` list comes from as soon as it has a source.
      useEffect(() => void props.commands?.load().catch(() => undefined), [props.commands?.key]);
      return (
        <div data-testid="composer">
          {props.disabledReason && <p role="note">{props.disabledReason}</p>}
          <textarea aria-label="Prompt" value={props.draft} onChange={(e) => props.onDraftChange(e.target.value)} />
          <button onClick={() => void Promise.resolve(props.onSend(props.draft, [])).catch(() => undefined)}>Send</button>
        </div>
      );
    },
  };
});

import { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { SessionView } from "./SessionView";
import { useCloudSession } from "@/lib/cloudSession";
import { resetCloudAgents } from "@/lib/cloudAgents";
import { agentTerminalId, agentTerminalOf, cloudTerminalFactory, ensureAgentTerminal, resetCloudTerminals, typeIntoCloudTerminal } from "@/lib/cloudTerminals";
import { getInstance } from "@/lib/terminal";
import { resetCloudConnections } from "@/lib/cloudConnections";
import { TERMINAL_APPROVAL_REASON, VIEWER_REASON, resetCollab } from "@/lib/cloudCollab";
import { dropSessionTerminals, selectSessionTab } from "@/lib/terminal";
import { TERMINAL_VIEW_OLD_RUNTIME, resetCloudWakes } from "@/lib/sessionBackend";
import { resetTabViews } from "@/lib/tabViews";
import { addProject, getSessionStore, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { cloudSessionKey } from "@/types/target";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FakeAgentRuntime, agentTab, fakeXterm, type FakeXterm } from "@/test/fakeAgentRuntime";

mocks.guard = guardedApi();
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
const guard = mocks.guard;

const ORG = "org-1";
const WS = "ws-1";
const KEY = cloudSessionKey(ORG, WS, "s-1");
const WORKSPACE = `cloud:${ORG}:${WS}`;
const TERMINAL = agentTerminalId(WORKSPACE, "t-1");

let seq = 0;
const ev = (payload: Payload): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: "s-1", tabId: "t-1", harness: "claude", ts: "2026-09-29T00:00:00Z", payload });

function workspaceItem(state: CloudWorkspaceListItem["workspace"]["state"], you?: { role: "manager" | "driver" | "viewer"; canApprove: boolean }): CloudWorkspaceListItem {
  return {
    workspace: {
      id: WS,
      orgId: ORG,
      name: "login-fix",
      provider: "box",
      state,
      accessMode: you ? "organization" : "private",
      createdAt: 1,
      updatedAt: 1,
      releaseDisposition: null,
      authority: you ? "participate" : "manage",
      repositories: [{ identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true }],
      ...(you ? { you, sharedWith: 2 } : {}),
    },
    latestOperation: null,
  } as CloudWorkspaceListItem;
}

function setCatalog(item: CloudWorkspaceListItem) {
  mocks.catalog.orgs = { [ORG]: { orgId: ORG, workspaces: [item], repositories: null, repositoriesAt: null, quota: null, fetchedAt: 1, source: "live", error: null } };
}

let runtime: FakeAgentRuntime;
let client: WorkspaceRpcClient;
let xterm: FakeXterm;
let activate: ReturnType<typeof vi.fn>;
let enqueued: string[];
/** What this desktop kept of the workspace's tabs: all a stopped workspace has to show. */
let cache: Record<string, unknown>;
const cached = () => {
  cache["t-1"] = { tab: agentTab(), events: [ev({ type: "user_message", text: "cached question", queued: false })], cursor: null, checkpoint: null, unread: false, completed: false, updatedAt: 1 };
};

function CloudHarness() {
  const cloud = useCloudSession(KEY);
  if (!cloud) return null;
  return <SessionView session={cloud.session} cloud={cloud} sidebarOpen onToggleSidebar={() => undefined} />;
}
const wrap = (node: React.ReactNode) => <TooltipProvider>{node}</TooltipProvider>;

beforeEach(() => {
  guard.reset();
  enqueued = [];
  cache = {};
  guard.handlers = {
    cloud_agent_cache_load: () => ({ tabs: cache }),
    cloud_agent_cache_save: () => undefined,
    cloud_agent_outbox: () => [],
    cloud_agent_outbox_sync: () => [],
    cloud_agent_checkpoints: () => [],
    cloud_agent_checkpoint: () => null,
    cloud_agent_enqueue: (args) => {
      enqueued.push(String(args.kind));
      return { clientCommandId: "cmd-1", tabId: String(args.tabId), kind: args.kind, text: null, requestId: null, state: "queued", wake: "queued", createdAt: 1, updatedAt: 1 };
    },
    organization_members: () => ({ members: [{ userId: "u-alice", email: "alice@example.com", displayName: "Alice", role: "member" }], pendingInvites: [], viewerRole: "member", canManageMembers: false, removedOnDelete: [], runtimeFacts: { available: true }, contextRevision: "r" }),
  };
  runtime = new FakeAgentRuntime();
  runtime.events = [ev({ type: "user_message", text: "why does login loop?", queued: false })];
  client = new WorkspaceRpcClient(runtime);
  xterm = fakeXterm();
  mocks.createTerminal = () => xterm;
  activate = vi.fn(async () => undefined);
  mocks.workspaceConnection.mockReset();
  mocks.workspaceConnection.mockImplementation(async () => ({ target: { kind: "cloud", organizationId: ORG, workspaceId: WS }, client, activate, close: vi.fn() }));
  setCatalog(workspaceItem("ready"));
  selectSessionTab(KEY, { kind: "agent", id: "t-1" });
  mocks.prefs.shortcuts = {};
});

afterEach(() => {
  cleanup();
  resetCloudAgents();
  resetCloudTerminals();
  resetCloudWakes();
  resetCloudConnections();
  resetCollab();
  resetTabViews();
  client.close();
});

async function open(connect: (() => void) | null = () => runtime.connect()) {
  render(wrap(<CloudHarness />));
  await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalled());
  if (connect) {
    await act(async () => connect());
    await screen.findByText("Fix login redirect");
  }
}
const shared = (role: "manager" | "driver" | "viewer", leases: { holderId: string }[] = [], canApprove = role !== "viewer") => {
  setCatalog(workspaceItem("ready", { role, canApprove }));
  runtime.collab = { you: { userId: "u-me", role, canApprove }, participants: [], leases: leases.map((lease) => ({ tabId: "t-1", holderId: lease.holderId, acquiredAt: 1, expiresAt: Date.now() + 60_000 })) };
};
/** What the terminal view says about itself (beside any button it offers). */
const status = () => screen.getByTestId("cloud-agent-terminal-status").querySelector("span")?.textContent ?? "";
const showTerminal = () => fireEvent.click(screen.getByRole("button", { name: "Show terminal view" }));
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

describe("the chat / terminal switch on a local agent tab", () => {
  it("is there as before, and shows the tab's own CLI on this computer", async () => {
    guard.strict = false;
    guard.local = () => null;
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
    selectSessionTab("local-1", { kind: "agent", id: "lt-1" });
    local.worktreeBase = { commit: "123456789abcdef", fetched: false, warning: "Fetch timed out. This worktree may be out of date." };
    const view = render(wrap(<SessionView session={local} sidebarOpen onToggleSidebar={() => undefined} />));
    expect(screen.getByText("Base may be out of date").getAttribute("title")).toBe(local.worktreeBase.warning);
    view.rerender(wrap(<SessionView session={{ ...local, worktreeBase: { ...local.worktreeBase, fetched: true, warning: null } }} sidebarOpen onToggleSidebar={() => undefined} />));
    // Fetched as it should be: a detail, in the branch's tooltip rather than on the bar.
    expect(screen.queryByText("Base 1234567 · fetched at creation")).toBeNull();
    expect(screen.getByTestId("session-branch").getAttribute("title")).toContain("Base 1234567 · fetched at creation");
    const toggle = await screen.findByRole("button", { name: "Show terminal view" });
    expect(screen.queryByTestId("terminal-view-unavailable")).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByRole("button", { name: "Back to chat" })).toBeTruthy();
    // The local pane, started by the local command: no cloud terminal is involved.
    expect(screen.getByTestId("xterm").textContent).toBe("tab:lt-1");
    expect(screen.getByTestId("xterm").dataset.visible).toBe("true");
    expect(guard.calls.map((call) => call.command)).toContain("ensure_tab_started");
    expect(screen.queryByTestId("cloud-agent-terminal")).toBeNull();
    expect(runtime.sent).toEqual([]);
  });
});

describe("a local session's row of tabs under the title bar", () => {
  const tab = (id: string, harness: string, title: string | null) => ({ id, harness, title, model: "", permissionMode: "bypassPermissions", status: "idle" as const, created: `2026-10-01T00:00:0${id.at(-1)}.000Z`, modified: "" });
  const local = (patch: Partial<SessionEntry> = {}): SessionEntry => ({
    id: "strip-1",
    projectPath: "/Users/me/api",
    cwd: "/Users/me/api/.raccoon/worktrees/fix",
    worktreeName: "fix",
    branch: "raccoon/fix",
    title: "Fix the login loop",
    created: "",
    modified: "",
    archived: false,
    pinned: false,
    worktreeRemoved: false,
    issue: { provider: "github", id: "12", identifier: "#12", title: "Login loops", url: "https://example.test/12" },
    automation: { id: "auto", name: "Nightly", runId: "run", runNumber: 3 },
    worktreeBase: { commit: "123456789abcdef", fetched: true, warning: null },
    tabs: [tab("st-1", "claude", "Investigate"), tab("st-2", "codex", "Write the fix")],
    activeTab: "st-1",
    ...patch,
  });
  /** The session as the store has it, so closing a tab is seen. */
  function Local() {
    const session = useSessionStore().sessions.find((candidate) => candidate.id === "strip-1");
    return session ? <SessionView session={session} sidebarOpen onToggleSidebar={() => undefined} /> : null;
  }
  const show = (patch: Partial<SessionEntry> = {}) => {
    upsertSession(local(patch));
    selectSessionTab("strip-1", { kind: "agent", id: "st-1" });
    const view = render(wrap(<Local />));
    return view.container.querySelector("header")!;
  };
  const spawned = () => guard.calls.filter((call) => call.command === "pty_spawn");

  beforeEach(() => {
    guard.strict = false;
    guard.local = () => null;
    guard.handlers.work_status = () => ({ isRepo: true, dirty: false, branch: "raccoon/fix", ahead: 0, behind: 0 });
    guard.handlers.list_harnesses = () => [];
    mocks.prefs.tabStrip = true;
  });
  afterEach(() => {
    mocks.prefs.tabStrip = false;
    // A shell one test opened is not there for the next.
    dropSessionTerminals(["strip-1"]);
  });

  it("names the place in the title bar, with the actions at the right, and puts the tabs in a row under it with the + after them", () => {
    const header = show();
    // The title bar: the project and the branch, with the session's chips.
    expect(screen.getByTestId("session-project").textContent).toBe("project");
    expect(within(screen.getByTestId("session-branch")).getByText("fix")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "#12" })).toBeTruthy();
    expect(screen.getByTestId("session-automation").textContent).toBe("Nightly #3");
    expect(screen.getByTestId("session-branch").getAttribute("title")).toContain("Base 1234567 · fetched at creation");
    expect(within(header).getByRole("button", { name: "Workspace details" })).toBeTruthy();
    expect(within(header).queryByRole("tablist")).toBeNull();
    // The row of tabs is right under the title bar, and the + ends it.
    const row = header.nextElementSibling as HTMLElement;
    expect(row.getAttribute("data-testid")).toBe("workspace-tab-strip");
    const strip = within(row).getByRole("tablist", { name: "Workspace tabs" });
    expect(within(strip).getAllByRole("tab").map((item) => item.getAttribute("aria-label"))).toEqual(["Investigate", "Write the fix"]);
    const plus = within(row).getByRole("button", { name: "New tab" });
    expect(strip.compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The + is not among the session's actions at the right of the title bar.
    const actions = header.lastElementChild!;
    expect(actions.contains(plus)).toBe(false);
    expect(actions.className).toContain("ml-auto");
    expect(within(actions as HTMLElement).getByRole("button", { name: "Toggle panel" })).toBeTruthy();
    const share = within(header).getByRole("button", { name: "Share session…" });
    const continuation = within(header).getByRole("button", { name: "Continue in New Session…" });
    expect(share.nextElementSibling).toBe(continuation);
    // The open tab is the underlined one.
    const [open, other] = within(strip).getAllByRole("tab");
    expect(open.getAttribute("aria-selected")).toBe("true");
    expect(open.parentElement!.className).toContain("after:bg-foreground");
    expect(other.parentElement!.className).not.toContain("after:bg-foreground");
    // The title bar is where the window is dragged from; the row is not part of it.
    expect(header.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(row.closest("[data-tauri-drag-region]")).toBeNull();
  });

  it.each(["title-bar button", "workspace menu"])("opens the shared continuation dialog for the visible tab from the %s", async (entry) => {
    const header = show();
    // The tab on screen can differ from the session's persisted activeTab.
    fireEvent.click(screen.getByRole("tab", { name: "Write the fix" }));
    if (entry === "workspace menu") {
      const menu = within(header).getByRole("button", { name: "Workspace details" });
      fireEvent.pointerDown(menu, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(menu, { button: 0, pointerType: "mouse" });
      fireEvent.click(menu);
      fireEvent.click(await screen.findByRole("menuitem", { name: "Continue in New Session…" }));
    } else {
      fireEvent.click(within(header).getByRole("button", { name: "Continue in New Session…" }));
    }
    const dialog = await screen.findByRole("dialog", { name: "Continue in New Session" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByText("Write the fix")).toBeTruthy();
    expect(guard.calls.filter((call) => call.command === "prepare_continuation").map((call) => call.args)).toEqual([
      { sessionId: "strip-1", tabId: "st-2" },
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each(["quick chat", "non-Git folder"])("offers continuation for a branchless %s without a workspace menu", async (kind) => {
    if (kind === "non-Git folder") {
      guard.handlers.add_project = () => ({ path: "/Users/me/notes", name: "Notes", kind: "folder" });
      await addProject("/Users/me/notes");
    }
    const header = show({
      ...(kind === "quick chat" ? { kind: "quick" } : {}),
      projectPath: "/Users/me/notes",
      cwd: "/Users/me/notes",
      branch: null,
      worktreeName: null,
    });
    expect(within(header).queryByRole("button", { name: "Workspace details" })).toBeNull();
    expect(within(header).getByRole("button", { name: "Continue in New Session…" })).toBeTruthy();
  });

  it("has no continuation action without an active agent tab", async () => {
    const header = show({ tabs: [], activeTab: null });
    expect(within(header).queryByRole("button", { name: "Continue in New Session…" })).toBeNull();
    // Let the empty session finish opening its shell before the next test.
    await screen.findByRole("tab", { name: "Terminal 1" });
  });

  it("names each tab's panel by its tab in the strip", () => {
    show();
    const panels = [...document.querySelectorAll('[role="tabpanel"]')];
    expect(panels).toHaveLength(2);
    for (const panel of panels) {
      const named = document.getElementById(panel.getAttribute("aria-labelledby")!)!;
      expect(named.getAttribute("role")).toBe("tab");
      expect(named.getAttribute("aria-controls")).toBe(panel.id);
    }
  });

  it("still says so beside the tabs when the base may be out of date", () => {
    show({ worktreeBase: { commit: "123456789abcdef", fetched: false, warning: "Fetch timed out. This worktree may be out of date." } });
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toContain("Base may be out of date");
  });

  it("leaves the tabs to the sidebar alone, with the + among the title bar's actions, when the row is turned off", () => {
    mocks.prefs.tabStrip = false;
    const header = show();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByTestId("session-project").textContent).toBe("project");
    expect(header.lastElementChild!.contains(within(header).getByRole("button", { name: "New tab" }))).toBe(true);
    expect(document.querySelector('[role="tabpanel"]')!.getAttribute("aria-labelledby")).toBe("session-agent-tab-st-1");
  });

  it("is not drawn for a cloud session", async () => {
    await open();
    expect(screen.queryByRole("tablist", { name: "Workspace tabs" })).toBeNull();
    expect(screen.getByTestId("session-project")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue in New Session…" })).toBeNull();
  });

  it("leaves the reader on the terminal they are in when the last agent tab is closed from the strip", async () => {
    // The title bar and the row of tabs under it.
    const header = show({ tabs: [tab("st-1", "claude", "Investigate")] }).parentElement!;
    fireEvent.click(within(header).getByRole("button", { name: "New tab" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Terminal on this computer" }));
    await waitFor(() => expect(spawned()).toHaveLength(1));
    const tabs = () => within(header).getAllByRole("tab");
    await waitFor(() => expect(tabs().map((item) => item.getAttribute("aria-selected"))).toEqual(["false", "true"]));

    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(tabs()[0].getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(tabs()[1]);
    await waitFor(() => expect(tabs()[1].getAttribute("aria-selected")).toBe("true"));
    // Closing the agent tab, which is not the one on screen.
    fireEvent.click(header.querySelector('[aria-label="Close Investigate"]') as HTMLElement);
    await waitFor(() => expect(guard.calls.some((call) => call.command === "remove_tab")).toBe(true));
    await settle();
    // The terminal is still the tab on screen, and no shell was opened behind it.
    expect(tabs().map((item) => [item.getAttribute("aria-label"), item.getAttribute("aria-selected")])).toEqual([["Terminal 1", "true"]]);
    expect(screen.queryByRole("button", { name: "Continue in New Session…" })).toBeNull();
    expect(spawned()).toHaveLength(1);
  });

  it("does not open a shell when returning to a reopened browser-only workspace", async () => {
    const session = local({ tabs: [], activeTab: null });
    guard.handlers.browser_pages = () => [browserPage("reopened-page", session.cwd, 1)];
    await refreshBrowserPages();
    upsertSession(session);
    selectSessionTab(session.id, { kind: "browser", id: "reopened-page" });
    const view = render(wrap(<Local />));
    try {
      await settle();
      expect(screen.getByTestId("browser-view")).toBeTruthy();
      expect(spawned()).toHaveLength(0);
    } finally {
      view.unmount();
      guard.handlers.browser_pages = () => [];
      await refreshBrowserPages();
    }
  });

  it("returns to welcome without spawning a shell when the last tab closes", async () => {
    const header = show({ tabs: [tab("st-1", "claude", "Investigate")] }).parentElement!;
    act(() => selectSession("strip-1"));
    fireEvent.click(header.querySelector('[aria-label="Close Investigate"]') as HTMLElement);
    await waitFor(() => expect(getSessionStore()).toMatchObject({ selectedSessionId: null, view: "welcome" }));
    await settle();
    expect(spawned()).toHaveLength(0);
  });
});

describe("a quick chat in the floating window's compact chrome", () => {
  const scratch = "/Users/me/.raccoon/quick/quick-1";
  const quick = (): SessionEntry => ({
    id: "quick-1",
    kind: "quick",
    projectPath: scratch,
    cwd: scratch,
    title: "What is a monad?",
    created: "",
    modified: "",
    archived: false,
    pinned: false,
    worktreeRemoved: false,
    tabs: [{ id: "qt-1", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "2026-10-01T00:00:00.000Z", modified: "" }],
    activeTab: "qt-1",
  });
  const compact = { compact: true, tabStrip: true, leading: <span data-testid="switcher">What is a monad?</span>, trailing: <button type="button">Open in main window</button> };
  const spawned = () => guard.calls.filter((call) => call.command === "pty_spawn").map((call) => call.args as { id: string; cwd: string; title: string | null });

  beforeEach(() => {
    guard.strict = false;
    guard.local = () => null;
  });

  it("is the same session view with less around it: no sidebar toggle, no panel, the window's own controls in the header", async () => {
    const session = quick();
    upsertSession(session);
    render(wrap(<SessionView session={session} sidebarOpen={false} onToggleSidebar={() => undefined} chrome={compact} />));
    // What a compact window has no room for.
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Toggle panel" })).toBeNull();
    expect(screen.queryByTestId("session-breadcrumb")).toBeNull();
    // What the window puts there instead.
    expect(screen.getByTestId("switcher")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in main window" })).toBeTruthy();
    // And everything a session can do in the main window.
    expect(screen.getByRole("button", { name: "Continue in New Session…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New tab" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Show terminal view" })).toBeTruthy();
    // No git was asked about a scratch folder.
    expect(guard.calls.map((call) => call.command)).not.toContain("work_status");
  });

  it("opens the shared continuation dialog from the first action in the floating window", async () => {
    guard.handlers.list_harnesses = () => [];
    const session = quick();
    upsertSession(session);
    const view = render(wrap(<SessionView session={session} sidebarOpen={false} onToggleSidebar={() => undefined} chrome={compact} />));
    const button = screen.getByRole("button", { name: "Continue in New Session…" });
    expect(view.container.querySelector("header")!.lastElementChild!.firstElementChild).toBe(button);
    expect(screen.queryByRole("button", { name: "Share session…" })).toBeNull();
    fireEvent.click(button);
    await screen.findByRole("dialog", { name: "Continue in New Session" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(guard.calls.filter((call) => call.command === "prepare_continuation").map((call) => call.args)).toEqual([
      { sessionId: session.id, tabId: session.activeTab },
    ]);
  });

  it("switches the agent tab between chat and terminal view", async () => {
    const session = quick();
    upsertSession(session);
    render(wrap(<SessionView session={session} sidebarOpen={false} onToggleSidebar={() => undefined} chrome={compact} />));
    fireEvent.click(await screen.findByRole("button", { name: "Show terminal view" }));
    expect(await screen.findByRole("button", { name: "Back to chat" })).toBeTruthy();
    expect(screen.getByTestId("xterm").textContent).toBe("tab:qt-1");
    expect(guard.calls.map((call) => call.command)).toContain("ensure_tab_started");
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(await screen.findByRole("button", { name: "Show terminal view" })).toBeTruthy();
  });

  it("opens plain terminals beside the agent tab, in the chat's own folder, and lists every tab in a strip", async () => {
    const session = quick();
    upsertSession(session);
    render(wrap(<SessionView session={session} sidebarOpen={false} onToggleSidebar={() => undefined} chrome={compact} />));
    // One tab: nothing to switch between, so no strip.
    expect(screen.queryByTestId("workspace-tab-strip")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Terminal on this computer" }));
    const strip = await screen.findByTestId("workspace-tab-strip");
    await waitFor(() => expect(spawned()).toHaveLength(1));
    // In the session's working directory: the scratch folder, not the home directory or a repository.
    expect(spawned()[0]).toMatchObject({ cwd: scratch, title: "Terminal 1" });
    expect(spawned()[0].id.startsWith("quick-1:")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Terminal on this computer" }));
    await waitFor(() => expect(spawned()).toHaveLength(2));
    const tabs = () => [...strip.querySelectorAll('[role="tab"]')];
    await waitFor(() => expect(tabs().map((tab) => tab.textContent)).toEqual(["claude", "Terminal 1", "Terminal 2"]));
    // The newest terminal is on screen; the agent tab is one click away and still there.
    expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(tabs()[0].getAttribute("aria-selected")).toBe("true"));
    expect(guard.calls.find((call) => call.command === "set_active_tab")?.args).toEqual({ sessionId: "quick-1", tabId: "qt-1" });

    // Closing one terminal leaves the other and the agent.
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await waitFor(() => expect(tabs().map((tab) => tab.textContent)).toEqual(["claude", "Terminal 2"]));
    expect(guard.calls.filter((call) => call.command === "pty_kill")).toHaveLength(1);
  });

  it("reads GitHub mark, project, branch: the account on the mark's hover, the chat's title nowhere in it", async () => {
    guard.strict = false;
    guard.local = () => null;
    guard.handlers.work_status = () => ({ isRepo: true, dirty: false, branch: "main", ahead: 0, behind: 0 });
    guard.handlers.github_identity = () => ({ login: "trade100x", source: "ssh", email: "me@example.com", repo: "me/api" });
    const local: SessionEntry = {
      id: "local-gh",
      projectPath: "/Users/me/shop",
      cwd: "/Users/me/shop",
      branch: "main",
      title: "Local work",
      created: "",
      modified: "",
      archived: false,
      pinned: false,
      worktreeRemoved: false,
      tabs: [{ id: "lt-gh", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "", modified: "" }],
    };
    upsertSession(local);
    render(wrap(<SessionView session={local} sidebarOpen onToggleSidebar={() => undefined} />));
    const chip = await screen.findByTestId("session-github-account");
    // The mark alone; the account is what it says on hover.
    expect(chip.textContent).toBe("");
    expect(chip.getAttribute("aria-label")).toBe("Connected to GitHub as trade100x");
    const crumb = screen.getByTestId("session-breadcrumb");
    expect(crumb.firstElementChild).toBe(chip);
    expect(screen.getByTestId("session-project").textContent).toBe("project");
    expect(screen.getByTestId("session-branch").textContent).toBe("main");
    expect(screen.queryByTestId("session-title")).toBeNull();
    // Asked about the folder the session works in, once.
    expect(guard.calls.filter((call) => call.command === "github_identity").map((call) => call.args)).toEqual([{ projectPath: "/Users/me/shop", refresh: false }]);
  });

  it("in the main window, is named a quick chat and says where it runs instead of showing a project or a branch", async () => {
    const session = { ...quick(), cwd: "/Users/me/notes" };
    guard.handlers.work_status = () => ({ isRepo: false, dirty: false, branch: null, ahead: 0, behind: 0 });
    upsertSession(session);
    render(wrap(<SessionView session={session} sidebarOpen onToggleSidebar={() => undefined} />));
    expect(screen.getByTestId("session-project").textContent).toBe("Quick chat");
    expect(screen.getByTestId("session-quick-place").textContent).toBe("notes");
    expect(screen.queryByTestId("session-branch")).toBeNull();
    // The main window's own chrome is untouched.
    expect(screen.getByRole("button", { name: "Toggle panel" })).toBeTruthy();
    expect(screen.queryByTestId("workspace-tab-strip")).toBeNull();
  });
});

describe("the chat / terminal switch on a cloud agent tab (PRO-86)", () => {
  it("shows the agent's live terminal, types into it over the workspace connection, and comes back to the same turn", async () => {
    await open();
    expect(await screen.findByText("why does login loop?")).toBeTruthy();
    const subscriptions = runtime.methods("session.subscribe").length;
    expect(runtime.methods("pty.attach")).toEqual([]);

    showTerminal();
    expect(await screen.findByTestId("cloud-agent-terminal")).toBeTruthy();
    expect(screen.getByTestId("xterm").textContent).toBe(TERMINAL);
    expect(screen.getByTestId("cloud-terminal-view-title").textContent).toBe("Terminal view · Idle");
    // What the CLI drew before anyone looked is replayed.
    await waitFor(() => expect(xterm.screen()).toBe("agent screen\r\n"));
    // Nobody controlled it, so this view takes it at its own size (not starting anything) and fits itself.
    await waitFor(() => expect(runtime.params("pty.control")).toEqual([{ ptyId: "tab:t-1", cols: 100, rows: 40, epoch: "e1" }]));
    await waitFor(() => expect(screen.getByTestId("xterm").dataset.fit).toBe("true"));
    expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull();

    // Typing reaches the agent's own process, through pty.write and nothing else.
    act(() => xterm.type("/login\r"));
    await waitFor(() => expect(runtime.typed.join("")).toBe("/login\r"));
    act(() => runtime.output("Opening browser\r\n"));
    expect(xterm.screen()).toContain("Opening browser");
    expect(enqueued).toEqual([]);
    expect(guard.calls.some((call) => JSON.stringify(call.args).includes("/login"))).toBe(false);

    // Back to chat: the same conversation, still subscribed, nothing restarted.
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(await screen.findByText("why does login loop?")).toBeTruthy();
    expect(screen.queryByTestId("cloud-agent-terminal")).toBeNull();
    await waitFor(() => expect(runtime.methods("pty.detach")).toHaveLength(1));
    expect(runtime.methods("session.subscribe")).toHaveLength(subscriptions);
    for (const method of ["session.create", "session.close", "session.configure", "session.addTab", "pty.create", "pty.kill"]) expect(runtime.methods(method)).toEqual([]);

    // The shortcut is the same as on a local tab, and the view resumes where it left off.
    fireEvent.keyDown(window, { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId("cloud-agent-terminal")).toBeTruthy();
    await waitFor(() => expect(runtime.params("pty.attach")).toHaveLength(2));
    expect(runtime.params("pty.attach")[1]).toMatchObject({ sinceOffset: runtime.agent.screen.length });
    expect(guard.violations).toEqual([]);
  });

  it("follows a remapped shortcut, like a local tab (the one action in the shortcut registry)", async () => {
    mocks.prefs.shortcuts = { "session.toggleTerminalView": ["mod+shift+y"] };
    await open();
    // The old keys no longer switch anything; the new ones do, both ways.
    fireEvent.keyDown(window, { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    await settle();
    expect(screen.queryByTestId("cloud-agent-terminal")).toBeNull();
    fireEvent.keyDown(window, { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId("cloud-agent-terminal")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByTestId("cloud-agent-terminal")).toBeNull());
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  it("leaves Escape to the agent in the terminal view, and interrupts the turn with it from the chat", async () => {
    runtime.tabs = [agentTab({ status: "in_progress" })];
    await open();
    showTerminal();
    await screen.findByTestId("cloud-agent-terminal");
    // The app does not take the key: it is not prevented, and no stop is queued.
    expect(fireEvent.keyDown(window, { key: "Escape", code: "Escape" })).toBe(true);
    await settle();
    expect(enqueued).toEqual([]);
    // Typed in the terminal it is a byte for the agent's own screen.
    await waitFor(() => expect(agentTerminalOf(WORKSPACE, "t-1")?.control).toBe("you"));
    act(() => xterm.type("\x1b"));
    await waitFor(() => expect(runtime.typed).toEqual(["\x1b"]));
    expect(enqueued).toEqual([]);

    // In the chat the app takes the key and sends the agent its Escape over the live connection (#427).
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await screen.findByTestId("composer");
    expect(fireEvent.keyDown(window, { key: "Escape", code: "Escape" })).toBe(false);
    await waitFor(() => expect(runtime.params("session.interrupt")).toEqual([{ sessionId: "s-1", tabId: "t-1" }]));
    await settle();
    // Never a mailbox stop: that ends the agent's process and drops its queued follow-ups.
    expect(enqueued).toEqual([]);
    for (const method of ["session.close", "pty.kill"]) expect(runtime.methods(method)).toEqual([]);
  });

  it("leaves the chat's Escape alone on a runtime from before session/3: nothing is interrupted, and nothing is stopped", async () => {
    runtime.capabilities = runtime.capabilities.filter((capability) => capability !== "session/3");
    runtime.tabs = [agentTab({ status: "in_progress" })];
    await open();
    await screen.findByTestId("composer");
    expect(fireEvent.keyDown(window, { key: "Escape", code: "Escape" })).toBe(true);
    await settle();
    expect(runtime.methods("session.interrupt")).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("does not send Escape to a tab with nothing running", async () => {
    await open();
    await screen.findByTestId("composer");
    expect(fireEvent.keyDown(window, { key: "Escape", code: "Escape" })).toBe(true);
    await settle();
    expect(runtime.methods("session.interrupt")).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("remembers the view per tab", async () => {
    runtime.tabs = [agentTab(), agentTab({ tabId: "t-2", title: "Second" })];
    runtime.sessions[0]!.tabs.push({ id: "t-2", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "", modified: "" });
    await open();
    showTerminal();
    await screen.findByTestId("cloud-agent-terminal");
    act(() => selectSessionTab(KEY, { kind: "agent", id: "t-2" }));
    // The other tab is still in chat, and its switch says so.
    expect(await screen.findByRole("button", { name: "Show terminal view" })).toBeTruthy();
    act(() => selectSessionTab(KEY, { kind: "agent", id: "t-1" }));
    expect(await screen.findByRole("button", { name: "Back to chat" })).toBeTruthy();
    expect(screen.getByTestId("cloud-agent-terminal")).toBeTruthy();
  });

  it("is off, with the reason, on a runtime that does not serve agent terminals", async () => {
    runtime.capabilities = runtime.capabilities.filter((capability) => capability !== "agent-pty/1");
    await open();
    expect(screen.queryByRole("button", { name: "Show terminal view" })).toBeNull();
    const off = screen.getByTestId("terminal-view-unavailable");
    expect(off.getAttribute("title")).toBe(TERMINAL_VIEW_OLD_RUNTIME);
    expect(off.getAttribute("aria-disabled")).toBe("true");
    // Neither the button nor the shortcut switches anything.
    fireEvent.click(off);
    fireEvent.keyDown(window, { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    await settle();
    expect(screen.queryByTestId("cloud-agent-terminal")).toBeNull();
    expect(screen.getByTestId("composer")).toBeTruthy();
    expect(runtime.methods("pty.attach")).toEqual([]);
  });

  it("on a stopped workspace says Stopped without waking it, and typing wakes it exactly once", async () => {
    setCatalog(workspaceItem("suspended"));
    cached();
    await open(null);
    await act(async () => runtime.emit({ state: "suspended" }));
    await screen.findByText("cached question");
    showTerminal();
    expect(await screen.findByTestId("cloud-agent-terminal")).toBeTruthy();
    expect(screen.getByTestId("cloud-terminal-view-title").textContent).toBe("Terminal view · Stopped");
    expect(status()).toBe("Stopped: the workspace is asleep. Typing here wakes it, as sending a message does.");
    await settle();
    // Looking: a connect that never wakes, no resume, nothing asked of the runtime.
    expect(mocks.workspaceConnection.mock.calls.map((call) => call[1])).toEqual(["connect"]);
    expect(activate).not.toHaveBeenCalled();
    expect(guard.calls.map((call) => call.command)).not.toContain("cloud_workspace_resume");
    expect(runtime.sent).toEqual([]);

    // Typing: one wake for any number of keys, and nothing is queued or typed blind.
    for (const key of ["l", "s", "\r"]) await act(async () => void (await typeIntoCloudTerminal(WORKSPACE, TERMINAL, key)));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(activate).toHaveBeenCalledWith("wake");
    expect(status()).toBe("Stopped: waking the workspace. The agent's terminal appears once it runs.");
    await settle();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(enqueued).toEqual([]);
    expect(guard.calls.map((call) => call.command)).not.toContain("cloud_workspace_resume");

    // It runs again: the same view attaches, and what was typed while it slept never arrives.
    await act(async () => runtime.connect());
    await waitFor(() => expect(xterm.screen()).toBe("agent screen\r\n"));
    expect(runtime.typed).toEqual([]);
    expect(guard.violations).toEqual([]);
  });

  it("clicking in and out of a stopped workspace's terminal view wakes nothing; a key does (review M1)", async () => {
    setCatalog(workspaceItem("suspended"));
    cached();
    await open(null);
    await act(async () => runtime.emit({ state: "suspended" }));
    await screen.findByText("cached question");
    showTerminal();
    await screen.findByTestId("cloud-agent-terminal");
    // The view's xterm, as TerminalView makes it; the program had asked for focus and mouse reports.
    act(() => void getInstance(TERMINAL, cloudTerminalFactory(WORKSPACE, ensureAgentTerminal(WORKSPACE, "t-1"), () => xterm)));
    for (const report of ["\x1b[I", "\x1b[O", "\x1b[I", "\x1b[<0;10;5M", "\x1b[?1;2c"]) act(() => xterm.report(report));
    await settle();
    expect(activate).not.toHaveBeenCalled();
    expect(status()).toBe("Stopped: the workspace is asleep. Typing here wakes it, as sending a message does.");
    expect(mocks.workspaceConnection.mock.calls.map((call) => call[1])).toEqual(["connect"]);
    act(() => xterm.type("x"));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(activate).toHaveBeenCalledWith("wake");
  });

  it("a focus report or a query in the replay never starts the agent, takes control or types; a key does (review M1)", async () => {
    runtime.tabs = [agentTab({ process: "exited" })];
    runtime.agent.running = false;
    // What the last CLI left on screen asks the terminal who it is.
    runtime.agent.screen = "bye \x1b[c\x1b[6n\r\n";
    await open();
    showTerminal();
    await waitFor(() => expect(xterm.screen()).toContain("bye "));
    act(() => xterm.report("\x1b[I"));
    act(() => xterm.report("\x1b[O"));
    await settle();
    for (const method of ["pty.control", "pty.write"]) expect(runtime.methods(method)).toEqual([]);
    // A key starts it and takes control; the next one is typed.
    act(() => xterm.type("x"));
    await waitFor(() => expect(runtime.params("pty.control")).toEqual([{ ptyId: "tab:t-1", cols: 100, rows: 40, start: true, epoch: "e1" }]));
    await waitFor(() => expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull());
    act(() => xterm.type("y"));
    await waitFor(() => expect(runtime.typed).toEqual(["y"]));
    // Controlling now: its focus report reaches the program, as a report.
    act(() => xterm.report("\x1b[I"));
    await waitFor(() => expect(runtime.reports).toEqual(["\x1b[I"]));
    expect(runtime.typed).toEqual(["y"]);
  });

  it("never wakes a stopped workspace for a viewer's keystrokes", async () => {
    setCatalog(workspaceItem("suspended", { role: "viewer", canApprove: false }));
    cached();
    await open(null);
    await act(async () => runtime.emit({ state: "suspended" }));
    await screen.findByText("cached question");
    showTerminal();
    await screen.findByTestId("cloud-agent-terminal");
    expect(status()).toBe("Stopped: nothing runs while the workspace is stopped.");
    await act(async () => void (await typeIntoCloudTerminal(WORKSPACE, TERMINAL, "x")));
    await settle();
    expect(activate).not.toHaveBeenCalled();
  });

  it("lets a viewer watch read-only: no control, no input, no size", async () => {
    shared("viewer");
    await open(() => runtime.connect("participate"));
    showTerminal();
    await waitFor(() => expect(xterm.screen()).toBe("agent screen\r\n"));
    expect(status()).toBe(`Read-only. ${VIEWER_REASON}`);
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(screen.getByTestId("xterm").dataset.fit).toBe("false");
    act(() => xterm.type("rm -rf /\r"));
    act(() => xterm.fitTo(60, 20));
    await settle();
    for (const method of ["pty.control", "pty.write", "pty.resize"]) expect(runtime.methods(method)).toEqual([]);
    // They still see what the agent draws, and who controls it.
    act(() => runtime.controlledBy("other", "u-alice"));
    act(() => runtime.output("working\r\n"));
    expect(xterm.screen()).toContain("working");
    await waitFor(() => expect(status()).toBe(`Read-only. Alice controls this terminal; you are watching. ${VIEWER_REASON}`));
  });

  it("keeps a driver without the lease from typing, under the same lease bar as the chat", async () => {
    shared("driver", [{ holderId: "u-alice" }]);
    runtime.agent.control = "other";
    runtime.agent.controllerId = "u-alice";
    await open(() => runtime.connect("participate"));
    await waitFor(() => expect(runtime.methods("collab.state").length).toBeGreaterThan(0));
    showTerminal();
    await waitFor(() => expect(xterm.screen()).toBe("agent screen\r\n"));
    await waitFor(() => expect(status()).toBe("Read-only. Alice controls this terminal; you are watching. Alice is driving this tab. You can send once they release it."));
    expect(screen.getByTestId("cloud-agent-driver").textContent).toBe("Driving: Alice");
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    act(() => xterm.type("x"));
    await settle();
    for (const method of ["pty.control", "pty.write", "pty.resize"]) expect(runtime.methods(method)).toEqual([]);
  });

  it("keeps a driver who may not approve permissions read-only, and says why", async () => {
    shared("driver", [], false);
    await open(() => runtime.connect("participate"));
    await waitFor(() => expect(runtime.methods("collab.state").length).toBeGreaterThan(0));
    showTerminal();
    await waitFor(() => expect(xterm.screen()).toBe("agent screen\r\n"));
    await waitFor(() => expect(status()).toBe(`Read-only. ${TERMINAL_APPROVAL_REASON}`));
    act(() => xterm.type("y\r"));
    await settle();
    for (const method of ["pty.control", "pty.write", "pty.resize"]) expect(runtime.methods(method)).toEqual([]);
    // The chat still takes their messages.
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "add a test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(enqueued).toEqual(["send"]));
  });

  it("names who controls the terminal, and typing starts only after taking control", async () => {
    shared("driver");
    runtime.agent.control = "other";
    runtime.agent.controllerId = "u-alice";
    runtime.agent.cols = 132;
    runtime.agent.rows = 43;
    await open(() => runtime.connect("participate"));
    showTerminal();
    await waitFor(() => expect(status()).toBe("Alice controls this terminal; you are watching."));
    // A watcher shows the controller's size and never sends its own.
    expect(xterm.term.resize).toHaveBeenLastCalledWith(132, 43);
    expect(screen.getByTestId("xterm").dataset.fit).toBe("false");
    act(() => xterm.type("x"));
    act(() => xterm.fitTo(60, 20));
    await settle();
    for (const method of ["pty.control", "pty.write", "pty.resize"]) expect(runtime.methods(method)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(runtime.agent.controllerId).toBe("u-me"));
    await waitFor(() => expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull());
    expect(screen.getByTestId("xterm").dataset.fit).toBe("true");
    act(() => xterm.type("y"));
    await waitFor(() => expect(runtime.typed).toEqual(["y"]));
  });

  describe("after a stop and a wake under the open app (B1)", () => {
    const typeBeforeStop = async () => {
      showTerminal();
      await waitFor(() => expect(runtime.agent.control).toBe("you"));
      act(() => xterm.type("a"));
      await waitFor(() => expect(runtime.typed).toEqual(["a"]));
    };
    const stopAndWake = async (kind: Parameters<FakeAgentRuntime["wokeAsNewDevice"]>[0], meanwhile: () => void = () => undefined) => {
      await act(async () => runtime.emit({ state: "suspended" }));
      runtime.wokeAsNewDevice(kind);
      meanwhile();
      await act(async () => runtime.connect());
      await settle();
    };
    const notice = () => screen.queryByTestId("cloud-agent-terminal-notice");

    it.each([
      ["a key on a keyboard", (text: string) => xterm.type(text)],
      ["text inserted by an accessibility tool, which leaves it in xterm's hidden field", (text: string) => xterm.insert(text)],
    ])("the key that wakes a stopped workspace is never typed into the agent: %s (F1)", async (_how, press) => {
      await open();
      await typeBeforeStop();
      const writesBefore = runtime.methods("pty.write").length;
      setCatalog(workspaceItem("suspended"));
      await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "1006", retryInMs: 250 }));
      await act(async () => runtime.emit({ state: "suspended" }));
      await waitFor(() => expect(status()).toBe("Stopped: the workspace is asleep. Typing here wakes it, as sending a message does."));
      // Return, or `y`, would answer a waiting permission prompt: it wakes, once, and goes nowhere.
      act(() => press("y"));
      await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
      act(() => press("k"));
      await settle();
      expect(activate).toHaveBeenCalledTimes(1);
      expect(status()).toBe("Stopped: waking the workspace. The agent's terminal appears once it runs.");
      expect(notice()).toBeNull();
      expect(runtime.methods("pty.write")).toHaveLength(writesBefore);
      expect(xterm.term.textarea!.value).toBe("");

      // Live again, with the terminal still this person's (the runtime kept running).
      await act(async () => runtime.emit({ state: "waitingForRuntime" }));
      setCatalog(workspaceItem("ready"));
      await act(async () => runtime.connect());
      await settle();
      expect(runtime.typed).toEqual(["a"]);
      // What is typed now arrives once, without the keys that woke it.
      act(() => press("echo:after wake"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "echo:after wake"]));
      act(() => xterm.pressReturn());
      await waitFor(() => expect(runtime.typed).toEqual(["a", "echo:after wake", "\r"]));
      expect(notice()).toBeNull();
    });

    /** Stopped, then running again with the terminal still this person's (the runtime kept running). */
    const stopThenWake = async () => {
      setCatalog(workspaceItem("suspended"));
      await act(async () => runtime.emit({ state: "reconnecting", attempt: 1, reason: "1006", retryInMs: 250 }));
      await act(async () => runtime.emit({ state: "suspended" }));
      await waitFor(() => expect(status()).toBe("Stopped: the workspace is asleep. Typing here wakes it, as sending a message does."));
      act(() => xterm.type("k"));
      await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
      await act(async () => runtime.emit({ state: "waitingForRuntime" }));
      setCatalog(workspaceItem("ready"));
      await act(async () => runtime.connect());
      await settle();
    };

    it("a line typed right after a wake arrives while another tab of the session shows its chat (#449)", async () => {
      // The other tab's composer lists its slash commands from the runtime, which asks the tab's CLI:
      // seconds on a machine that just woke. A runtime that answers in order answers nothing else meanwhile.
      runtime.capabilities.push("composer/1");
      runtime.tabs = [agentTab(), agentTab({ tabId: "t-2", title: "Second" })];
      runtime.sessions[0]!.tabs.push({ id: "t-2", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "", modified: "" });
      await open();
      await typeBeforeStop();
      const asked = runtime.methods("session.commands").length;
      runtime.slow = ["session.commands"];
      await stopThenWake();
      // The tab that is not on screen asked for nothing, so the terminal is attached at once.
      expect(runtime.methods("session.commands")).toHaveLength(asked);
      expect(screen.getByTestId("cloud-terminal-view-title").textContent).toBe("Terminal view · Idle");
      expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull();
      act(() => xterm.type("echo:after wake"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "echo:after wake"]));
      act(() => xterm.pressReturn());
      await waitFor(() => expect(runtime.typed).toEqual(["a", "echo:after wake", "\r"]));
      expect(notice()).toBeNull();
      // Its list is asked for when its chat is shown.
      runtime.slow = [];
      act(() => selectSessionTab(KEY, { kind: "agent", id: "t-2" }));
      await waitFor(() => expect(runtime.params("session.commands").at(-1)).toMatchObject({ tabId: "t-2" }));
    });

    it("says it is still connecting while the runtime has not answered the attach, and that a key typed then was not sent (#449)", async () => {
      await open();
      await typeBeforeStop();
      // A runtime from before #449, busy with something asked ahead of the attach.
      runtime.slow = ["pty.attach"];
      await stopThenWake();
      // The header already reads Idle and the screen is the one from before the stop: for a moment nothing more is said.
      expect(screen.getByTestId("cloud-terminal-view-title").textContent).toBe("Terminal view · Idle");
      expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull();
      expect(agentTerminalOf(WORKSPACE, "t-1")?.live).toBe(false);
      // A key now goes nowhere, and the view says so at once.
      act(() => xterm.insert("echo:lost"));
      await waitFor(() => expect(status()).toBe("Connecting to the agent's terminal: what you typed was not sent. Type it again once this line is gone."));
      act(() => xterm.pressReturn());
      await settle();
      expect(runtime.typed).toEqual(["a"]);
      expect(xterm.term.textarea!.value).toBe("");
      // Attached: the line goes, and what is typed from here on arrives, without what was dropped.
      runtime.slow = [];
      await act(async () => runtime.release());
      await waitFor(() => expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull());
      act(() => xterm.insert("echo:again"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "echo:again"]));
      expect(notice()).toBeNull();
    });

    it("says it is still connecting after a moment of waiting, before anything is typed (#449)", async () => {
      await open();
      await typeBeforeStop();
      runtime.slow = ["pty.attach"];
      await stopThenWake();
      expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull();
      await waitFor(() => expect(status()).toBe("Connecting to the agent's terminal: keys pressed now are not sent."), { timeout: 3000 });
      runtime.slow = [];
      await act(async () => runtime.release());
      await waitFor(() => expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull());
      act(() => xterm.type("b"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "b"]));
    });

    it("says the terminal is theirs from another device and offers Take control, and it works: what is typed next arrives", async () => {
      shared("manager");
      await open();
      await typeBeforeStop();
      await stopAndWake("frozen");
      await waitFor(() => expect(status()).toBe("You control this terminal from another window or device; you are watching here."));
      // Offered, never taken by itself; a key before the click is not typed anywhere.
      act(() => xterm.type("x"));
      await settle();
      expect(runtime.methods("pty.control")).toHaveLength(1);
      expect(runtime.typed).toEqual(["a"]);
      fireEvent.click(screen.getByRole("button", { name: "Take control" }));
      await waitFor(() => expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull());
      act(() => xterm.type("b"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "b"]));
      act(() => xterm.type("c"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "b", "c"]));
      expect(notice()).toBeNull();
      // And again after another stop and wake: it does not stay broken.
      await stopAndWake("frozen");
      fireEvent.click(await screen.findByRole("button", { name: "Take control" }));
      await waitFor(() => expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull());
      act(() => xterm.type("d"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "b", "c", "d"]));
      expect(notice()).toBeNull();
    });

    it("takes the terminal of a machine that booted cold as it does on opening: nobody controls it", async () => {
      await open();
      await typeBeforeStop();
      await stopAndWake("restarted");
      await waitFor(() => expect(xterm.screen()).toBe("fresh screen\r\n"));
      await waitFor(() => expect(runtime.agent.control).toBe("you"));
      act(() => xterm.type("b"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "b"]));
      expect(notice()).toBeNull();
    });

    it("never takes it from someone else who took it meanwhile: that stays a click", async () => {
      shared("manager");
      await open();
      await typeBeforeStop();
      await stopAndWake("frozen", () => {
        runtime.agent.control = "other";
        runtime.agent.controllerId = "u-alice";
      });
      await waitFor(() => expect(status()).toBe("Alice controls this terminal; you are watching."));
      act(() => xterm.type("x"));
      await settle();
      expect(runtime.methods("pty.control")).toHaveLength(1);
      expect(runtime.methods("pty.write")).toHaveLength(1);
      expect(runtime.typed).toEqual(["a"]);
      fireEvent.click(screen.getByRole("button", { name: "Take control" }));
      await waitFor(() => expect(runtime.agent.controllerId).toBe("u-me"));
      act(() => xterm.type("b"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "b"]));
    });
  });

  it("starts an agent that is not running only when asked, and does not type the key that started it", async () => {
    runtime.tabs = [agentTab({ process: "exited" })];
    runtime.agent.running = false;
    await open();
    showTerminal();
    await waitFor(() => expect(status()).toBe("The agent is not running; its conversation is saved. Press a key here, or Start, to run it."));
    await settle();
    // Opening the view started nothing and took nothing.
    expect(runtime.methods("pty.control")).toEqual([]);

    act(() => xterm.type("x"));
    await waitFor(() => expect(runtime.params("pty.control")).toEqual([{ ptyId: "tab:t-1", cols: 100, rows: 40, start: true, epoch: "e1" }]));
    await waitFor(() => expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull());
    expect(runtime.typed).toEqual([]);
    act(() => xterm.type("hello"));
    await waitFor(() => expect(runtime.typed).toEqual(["hello"]));
    expect(runtime.methods("pty.control")).toHaveLength(1);
  });
});
