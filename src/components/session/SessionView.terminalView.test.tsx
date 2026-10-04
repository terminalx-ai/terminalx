import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import type { AgentEvent, Payload } from "@/types/events";
import type { SessionEntry } from "@/types/session";
import { guardedApi } from "@/test/guardedApi";

// PRO-86: the chat / terminal switch on local and cloud agent tabs. The cloud
// runtime is a fake behind the real workspace client; nothing here reaches a
// real VM.
const mocks = vi.hoisted(() => ({
  guard: null as unknown as ReturnType<typeof import("@/test/guardedApi").guardedApi>,
  workspaceConnection: vi.fn(),
  catalog: { owner: "me", revision: "r", loaded: true, orgs: {} as Record<string, unknown>, createMemory: {}, notices: [] },
  prefs: { panelOpen: false, panelWidth: 360, sidebarOpen: true, lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", useWorktree: true, shortcuts: {} as Record<string, string[]> },
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
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));
vi.mock("@/components/chat/Composer", () => ({
  Composer: (props: { draft: string; onDraftChange: (v: string) => void; onSend: (t: string, i: unknown[]) => Promise<void>; disabledReason?: string | null }) => (
    <div data-testid="composer">
      {props.disabledReason && <p role="note">{props.disabledReason}</p>}
      <textarea aria-label="Prompt" value={props.draft} onChange={(e) => props.onDraftChange(e.target.value)} />
      <button onClick={() => void Promise.resolve(props.onSend(props.draft, [])).catch(() => undefined)}>Send</button>
    </div>
  ),
}));

import { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { SessionView } from "./SessionView";
import { useCloudSession } from "@/lib/cloudSession";
import { resetCloudAgents } from "@/lib/cloudAgents";
import { agentTerminalId, agentTerminalOf, cloudTerminalFactory, ensureAgentTerminal, resetCloudTerminals, typeIntoCloudTerminal } from "@/lib/cloudTerminals";
import { getInstance } from "@/lib/terminal";
import { resetCloudConnections } from "@/lib/cloudConnections";
import { TERMINAL_APPROVAL_REASON, VIEWER_REASON, resetCollab } from "@/lib/cloudCollab";
import { selectSessionTab } from "@/lib/terminal";
import { TERMINAL_VIEW_OLD_RUNTIME, resetCloudWakes } from "@/lib/sessionBackend";
import { resetTabViews } from "@/lib/tabViews";
import { upsertSession } from "@/lib/sessions";
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
    render(wrap(<SessionView session={local} sidebarOpen onToggleSidebar={() => undefined} />));
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

  it("leaves Escape to the agent in the terminal view, and stops the turn with it from the chat", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await screen.findByTestId("composer");
    expect(fireEvent.keyDown(window, { key: "Escape", code: "Escape" })).toBe(false);
    await waitFor(() => expect(enqueued).toEqual(["stop"]));
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

    it("is typed into again with no banner and no click when the runtime kept running", async () => {
      await open();
      await typeBeforeStop();
      await stopAndWake("kept");
      await waitFor(() => expect(screen.queryByTestId("cloud-agent-terminal-status")).toBeNull());
      expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
      act(() => xterm.type("b"));
      await waitFor(() => expect(runtime.typed).toEqual(["a", "b"]));
      expect(notice()).toBeNull();
      // Nothing was taken again, and the wake itself typed nothing.
      expect(runtime.methods("pty.control")).toHaveLength(1);
      expect(runtime.reports).toEqual([]);
      expect(activate).not.toHaveBeenCalled();
    });

    it("on a runtime that counts per device offers Take control, and it works: what is typed next arrives", async () => {
      shared("manager");
      await open();
      await typeBeforeStop();
      await stopAndWake("per-device");
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
      await stopAndWake("per-device");
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
      await stopAndWake("kept", () => {
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
