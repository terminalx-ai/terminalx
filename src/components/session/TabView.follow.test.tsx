import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * A tab's view follows what runs in its terminal (#437): its agent run by the
 * app, its agent started by hand in the terminal, or no agent at all.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {} },
  start: vi.fn(),
  forget: vi.fn(),
  leave: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => true, startTabAgent: mocks.start,
  clearTabViewError: vi.fn(), forgetTabView: mocks.forget, leaveTerminalView: mocks.leave,
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="terminal" data-pane={id} /> }));
// The chat's own drawing is not under test: which conversation it is given, and what stands under it, are.
vi.mock("@/components/chat/Chat", () => ({
  Chat: ({ transcript, footer }: { transcript: { turns: { key: string; prompt?: { text: string }; work: { kind: string; text?: string }[] }[] }; footer: React.ReactNode }) => (
    <div>
      <ol aria-label="Conversation">
        {transcript.turns.flatMap((turn) => [turn.prompt?.text, ...turn.work.filter((item) => item.kind === "status").map((item) => item.text)]).filter(Boolean).map((text, at) => <li key={at}>{text}</li>)}
      </ol>
      {footer}
    </div>
  ),
}));
vi.mock("@/components/chat/Dictation", () => ({ DictationStatus: () => null, MicButton: () => null, useDictationInto: () => ({ dictating: false, toggle: vi.fn() }), useDictationShortcuts: vi.fn() }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: () => null }));

import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyEvent } from "@/lib/agentEvents";
import { bootSessions, upsertSession, useSessionStore } from "@/lib/sessions";
import { mouseClick } from "@/test/press";

let seq = 0;
let session: SessionEntry;
const tabId = () => session.tabs[0].id;
const event = (harness: string, payload: Payload): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: session.id, tabId: tabId(), harness, ts: "2026-10-12T10:00:00.000Z", payload });
const said = () => within(screen.getByRole("list", { name: "Conversation" })).queryAllByRole("listitem").map((item) => item.textContent);
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

function Tab() {
  const current = useSessionStore().sessions.find((candidate) => candidate.id === session.id)!;
  return <TooltipProvider><TabView session={current} tab={current.tabs[0]} active /></TooltipProvider>;
}

/** The tab as the backend last said it is. */
function become(patch: Partial<TabEntry>) {
  session = { ...session, tabs: [{ ...session.tabs[0], ...patch }] };
  act(() => upsertSession(session));
}

function open(tab: Partial<TabEntry>, log: AgentEvent[] = []) {
  session = { ...session, tabs: [{ ...session.tabs[0], ...tab }] };
  upsertSession(session);
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "load_tab_events") return log;
    if (command === "list_projects") return { projects: [], lastSelected: null };
    if (command === "list_sessions") return [session];
    if (command === "list_harnesses") return [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }];
    if (command === "list_models" || command === "list_workspaces") return [];
    return null;
  });
  return render(<Tab />);
}

beforeEach(async () => {
  seq += 1;
  session = {
    id: `session${seq}`, projectPath: "/work", cwd: "/work", title: "Follow", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `tab${seq}`, harness: "claude", model: "", permissionMode: "default", status: "idle", created: "", modified: "", providerSessionId: "conversation-1" }],
  };
  mocks.views.views = {};
  for (const mock of [mocks.invoke, mocks.start, mocks.forget, mocks.leave]) mock.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => (command === "list_harnesses" ? [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }] : command === "list_projects" ? { projects: [], lastSelected: null } : []));
  await bootSessions();
});
afterEach(cleanup);

describe("a tab that is a terminal", () => {
  it("shows its terminal, says no agent runs there, and raises nothing to recover from", async () => {
    // The conversation it last held ended with an exit mid-turn and an expired request: neither is this terminal's trouble.
    open({ front: "terminal", terminalTitle: "Terminal 2" }, [
      event("claude", { type: "user_message", text: "a long job", queued: false }),
      event("claude", { type: "recovery", kind: "permission_expired" }),
      event("claude", { type: "turn_completed", status: "aborted", authFailed: false }),
      event("claude", { type: "status", text: "Claude Code exited before the turn finished." }),
    ]);
    await waitFor(() => expect(screen.getByTestId("terminal-view-title").textContent).toBe("Terminal"));
    expect(screen.getByText(/No agent is running in this tab/)).toBeTruthy();
    expect(screen.getByTestId("terminal").getAttribute("data-pane")).toBe(`tab:${tabId()}`);
    expect(screen.queryByLabelText("Session recovery")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume safely" })).toBeNull();
    // Opening it gave it its shell.
    expect(mocks.start).toHaveBeenCalled();
  });

  it("offers the conversation it last held to read and to resume, with nobody to send to", async () => {
    mocks.views.views = { [`tab${seq}`]: "chat" };
    open({ front: "terminal" }, [event("claude", { type: "user_message", text: "fix the build", queued: false }), event("claude", { type: "status", text: "Claude Code exited." })]);
    await waitFor(() => expect(said()).toEqual(["fix the build", "Claude Code exited."]));
    const note = screen.getByTestId("conversation-read-only");
    expect(note.textContent).toContain("Claude Code is not running in this tab");
    expect(screen.queryByRole("textbox")).toBeNull();

    mouseClick(within(note).getByRole("button", { name: "Resume here" }));
    await waitFor(() => expect(calls("tab_resume_conversation")).toEqual([{ sessionId: session.id, tabId: tabId(), harness: "claude", providerSessionId: "conversation-1" }]));
  });

  it("says why when its conversation cannot be resumed, and stays a terminal", async () => {
    open({ front: "terminal" });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "tab_resume_conversation") throw new Error("This tab's terminal is running something. Stop it there first, or use another tab.");
      return [];
    });
    mouseClick(await screen.findByTestId("terminal-resume"));
    expect((await screen.findByRole("alert")).textContent).toContain("terminal is running something");
    expect(screen.getByTestId("terminal-view-title").textContent).toBe("Terminal");
  });

  it("shows the face that goes with what is in its terminal when that changes, and is given a shell when it becomes one", async () => {
    open({ front: "agent", status: "in_progress" });
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox")).toBeTruthy();
    // Its CLI exits.
    become({ front: "terminal", status: "idle" });
    expect(mocks.forget).toHaveBeenCalledWith(tabId());
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("terminal-view-title").textContent).toBe("Terminal");
    // Codex is typed into it.
    become({ front: "by_hand", harness: "codex", status: "in_progress" });
    expect(mocks.forget).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("terminal-view-title").textContent).toBe("Terminal view · Working");
    expect(screen.getByText(/Codex was started in this terminal\. The chat is the same conversation\./)).toBeTruthy();
  });
});

describe("a tab whose agent was started by hand", () => {
  it("opens on its terminal, in the shell's own pane", async () => {
    open({ front: "by_hand", pane: "session1:abc", status: "in_progress" });
    await waitFor(() => expect(screen.getByTestId("terminal-view-title").textContent).toBe("Terminal view · Working"));
    expect(screen.getByTestId("terminal").getAttribute("data-pane")).toBe("session1:abc");
    expect(screen.getByRole("button", { name: "Stop session" })).toBeTruthy();
  });

  it("has a live chat, with the permission mode locked and the reason said", async () => {
    mocks.views.views = { [`tab${seq}`]: "chat" };
    open({ front: "by_hand", permissionMode: "terminal" });
    const mode = await screen.findByTestId("permission-mode");
    expect((mode as HTMLButtonElement).disabled).toBe(true);
    expect(mode.getAttribute("title")).toMatch(/Claude Code was started by hand in this tab's terminal.*permission mode/);
    expect(screen.getByTestId("permission-mode-label").textContent).toBe("Set in the terminal");
    // Claude Code takes a model while it runs, so that picker is left to use.
    expect((screen.getByTestId("model-picker") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("composer-settings-note").textContent).toBe("Claude Code was started by hand in this tab's terminal. Its permission mode is changed there: TerminalX only restarts an agent it launched.");
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("locks the model too for an agent that only takes one when it starts", async () => {
    mocks.views.views = { [`tab${seq}`]: "chat" };
    open({ front: "by_hand", harness: "codex", permissionMode: "terminal" });
    const model = await screen.findByTestId("model-picker");
    expect((model as HTMLButtonElement).disabled).toBe(true);
    expect(model.getAttribute("title")).toMatch(/Codex was started by hand.*model or effort/);
    expect((screen.getByTestId("permission-mode") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("composer-settings-note").textContent).toContain("Its model, effort and permission mode are changed there");
  });

  it("is not called closed once an agent is in its terminal again after Stop", async () => {
    open({ front: "by_hand", pane: "session1:abc", status: "in_progress" });
    mouseClick(await screen.findByRole("button", { name: "Stop session" }));
    await waitFor(() => expect(calls("stop_tab")).toHaveLength(1));
    // Stop ended the CLI and left its shell: the tab is a terminal.
    become({ front: "terminal", status: "idle" });
    await waitFor(() => expect(screen.getByTestId("terminal-view-title").textContent).toBe("Terminal"));
    // The reader starts the agent there again. "Session closed" was said of the one Stop ended.
    become({ front: "by_hand", status: "idle" });
    expect(screen.getByTestId("terminal-view-title").textContent).toBe("Terminal view · Idle");
    expect(screen.queryByText(/Session closed/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume safely" })).toBeNull();
  });

  it("locks nothing for an agent the app runs", async () => {
    open({});
    expect(((await screen.findByTestId("permission-mode")) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("model-picker") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("composer-settings-note")).toBeNull();
  });
});

describe("a tab that held another conversation before", () => {
  const log = () => [
    event("claude", { type: "user_message", text: "first, with Claude", queued: false }),
    event("claude", { type: "turn_completed", status: "ok", authFailed: false }),
    event("claude", { type: "status", text: "Claude Code exited." }),
    event("codex", { type: "conversation", id: "c2", harness: "codex" }),
    event("codex", { type: "user_message", text: "then, with Codex", queued: false }),
  ];
  const held = { front: "by_hand", harness: "codex", conversation: "c2", providerSessionId: "codex-1", history: [{ harness: "claude", providerSessionId: "conversation-1", title: "First with Claude", ended: "2026-10-12T10:05:00.000Z" }] } satisfies Partial<TabEntry>;

  it("shows the one it holds now, and keeps the earlier one to read from its menu", async () => {
    mocks.views.views = { [`tab${seq}`]: "chat" };
    open(held, log());
    await waitFor(() => expect(said()).toEqual(["then, with Codex"]));
    const bar = screen.getByTestId("tab-conversations");
    expect(bar.textContent).toContain("1 earlier conversation in this tab");

    mouseClick(within(bar).getByRole("button", { name: "Conversations" }));
    mouseClick(within(await screen.findByRole("menu")).getByText("First with Claude"));
    await waitFor(() => expect(said()).toEqual(["first, with Claude", "Claude Code exited."]));
    // It is kept as it was: read, not written to, and not resumed over the agent that is running.
    expect(screen.getByTestId("conversation-read-only").textContent).toContain("An earlier conversation in this tab, with Claude Code");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("conversation-resume")).toBeNull();
    expect(bar.textContent).toContain("Reading an earlier conversation with Claude Code");

    mouseClick(screen.getByRole("button", { name: "Back to the current one" }));
    await waitFor(() => expect(said()).toEqual(["then, with Codex"]));
    expect(screen.getByRole("textbox")).toBeTruthy();
    // What is said next is said in the conversation it holds.
    act(() => applyEvent(event("codex", { type: "user_message", text: "and more", queued: false })));
    await waitFor(() => expect(said()).toEqual(["then, with Codex", "and more"]));
  });

  it("switches to the chat to read an earlier one when it was showing its terminal", async () => {
    open({ ...held, front: "terminal" }, log());
    const bar = await screen.findByTestId("tab-conversations");
    mouseClick(within(bar).getByRole("button", { name: "Conversations" }));
    mouseClick(within(await screen.findByRole("menu")).getByText("First with Claude"));
    expect(mocks.leave).toHaveBeenCalled();
  });

  it("does not list a conversation in which nothing was said", async () => {
    mocks.views.views = { [`tab${seq}`]: "chat" };
    open({ ...held, history: [{ harness: "claude", id: "never-used", providerSessionId: "empty" }] }, log());
    await waitFor(() => expect(said()).toEqual(["then, with Codex"]));
    expect(screen.queryByTestId("tab-conversations")).toBeNull();
  });
});
