import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ loginPanes: [] as { id: string; exited: boolean }[], invoke: vi.fn(), openTerminal: vi.fn(), enterTerminalView: vi.fn(), answerPermission: (_request: string, _option: string): void => {}, views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {}, waiting: {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => true, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn(),
  enterTerminalView: mocks.enterTerminalView,
}));
vi.mock("@/lib/terminal", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/terminal")>();
  return { ...original, openTerminal: mocks.openTerminal,
    getTerminalState: () => ({ ...original.getTerminalState(), panes: mocks.loginPanes }),
  };
});
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => <div>Terminal output</div> }));
vi.mock("@/components/chat/Chat", async importOriginal => {
  const { Chat } = await importOriginal<typeof import("@/components/chat/Chat")>();
  return { Chat: (props: React.ComponentProps<typeof Chat>) => {
    mocks.answerPermission = props.onAnswerPermission;
    return <Chat {...props} />;
  } };
});
vi.mock("@/components/chat/Composer", () => ({ Composer: ({ draft }: { draft: string }) => <textarea aria-label="Unsent prompt" value={draft} readOnly /> }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: ({ onClose, onDelivered }: {
  onClose: () => void; onDelivered: (to: { sessionId: string; tabId: string }) => void;
}) => <div role="dialog" aria-label="Continue dialog">
  <button onClick={onClose}>Dismiss continuation</button>
  <button onClick={() => { onDelivered({ sessionId: "destination", tabId: "destination-tab" }); onClose(); }}>Deliver continuation</button>
</div> }));

import { TabView } from "./TabView";
import { ProjectNavigation } from "@/components/layout/SidebarTree";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyEvent, setTabStatus } from "@/lib/agentEvents";
import { upsertSession, useSessionStore, selectSession } from "@/lib/sessions";
import { bucketSessions } from "@/lib/dashboard";
import { getDraft, setDraft } from "@/lib/drafts";
import { CONTINUE_PROMPT, RECOVERY_PROMPT } from "@/lib/recovery";
import { announceReadiness } from "@/lib/agentReadiness";
import { localSessionBackend, type SessionBackend } from "@/lib/sessionBackend";

let seq = 0;
let session: SessionEntry;
const event = (payload: Payload): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: session.id, tabId: session.tabs[0].id, harness: "codex", ts: new Date().toISOString(), payload });
const emit = (payload: Payload) => act(() => applyEvent(event(payload)));
function Harness({ backend }: { backend?: SessionBackend } = {}) {
  const store = useSessionStore();
  const current = store.sessions.find(s => s.id === session.id)!;
  const counts = bucketSessions([current]);
  return <TooltipProvider>
    <aside aria-label="Sidebar"><ProjectNavigation project={{ path: "/workspace", name: "Project" }} expanded /></aside>
    <output aria-label="Working count">{counts.working.length}</output>
    <TabView session={current} tab={current.tabs[0]} active backend={backend} />
  </TooltipProvider>;
}
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  session = { id: `session${++seq}`, projectPath: "/workspace", cwd: "/workspace", title: "Recovery test", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `tab${seq}`, harness: "codex", model: "original", permissionMode: "default", status: "in_progress", created: "", modified: "" }] };
  mocks.views.views = { [session.tabs[0].id]: "terminal" };
  mocks.invoke.mockReset();
  mocks.loginPanes = [];
  mocks.openTerminal.mockReset().mockImplementation(async () => {
    const pane = { id: `login-${mocks.loginPanes.length}`, exited: false };
    mocks.loginPanes.push(pane);
    return pane;
  });
  mocks.enterTerminalView.mockReset().mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
    if (command === "load_tab_events" || command === "list_workspaces") return [];
    if (command === "check_agent_readiness") return { state: "signed_out", checkedAt: null, version: null };
    if (command === "list_models") return [{ id: "available", harness: "codex", label: "Available model", efforts: [] }];
    if (command === "stop_tab") {
      applyEvent(event({ type: "recovery", kind: null }));
      setTabStatus(session.id, session.tabs[0].id, "idle");
    }
    if (command === "send_message") {
      // As the runtime does for a prompt that starts a turn.
      setTabStatus(session.id, session.tabs[0].id, "in_progress");
      return { queued: false, events: [event({ type: "user_message", text: (args as { text: string }).text, queued: false })] };
    }
  });
  upsertSession(session);
  selectSession(session.id);
  setDraft(session.tabs[0].id, "Keep this unsent prompt");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("TabView recovery lifecycle", () => {
  const signedIn = async (harness = "codex") => {
    // A visible pending banner can precede its passive readiness subscription.
    // Finish mounting that observer before simulating an external login result.
    await act(async () => {});
    await act(async () => announceReadiness(harness, { state: "ready", checkedAt: new Date().toISOString(), version: null }));
  };
  const sends = () => mocks.invoke.mock.calls.filter(([command]) => command === "send_message");

  it("opens one login for repeated sign-in and retry clicks, and retries once only after verified authentication", async () => {
    const mounted = render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/After sign-in is verified/);
    mounted.rerender(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
    expect(sends()).toHaveLength(0);
    await signedIn("claude");
    expect(sends()).toHaveLength(0);
    await signedIn();
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0][1]).toEqual(expect.objectContaining({ text: RECOVERY_PROMPT, images: [] }));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "stop_tab")).toHaveLength(1);
    expect(getDraft(session.tabs[0].id)).toBe("Keep this unsent prompt");
    await signedIn();
    expect(sends()).toHaveLength(1);
  });

  it("uses Retry to check failed sign-in without launching another login", async () => {
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/After sign-in is verified/);
    act(() => announceReadiness("codex", { state: "unknown", checkedAt: null, version: null }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(sends()).toHaveLength(0);
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "check_agent_readiness"
      ? Promise.resolve({ state: "ready", checkedAt: null, version: null }) : original(command, args));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it("allows sign-in after opening and dismissing a continuation dialog before login", async () => {
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Continue in new session" }));
    await screen.findByRole("dialog", { name: "Continue dialog" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss continuation" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it("preserves the pending login when a continuation dialog is dismissed, without replaying while it is open", async () => {
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    fireEvent.click(screen.getByRole("button", { name: "Continue in new session" }));
    await screen.findByRole("dialog", { name: "Continue dialog" });
    await signedIn();
    await act(async () => {});
    expect(sends()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss continuation" }));
    await screen.findByText(/After sign-in is verified/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it("revokes the source's pending retry when the continuation is delivered", async () => {
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    fireEvent.click(screen.getByRole("button", { name: "Continue in new session" }));
    await screen.findByRole("dialog", { name: "Continue dialog" });
    fireEvent.click(screen.getByRole("button", { name: "Deliver continuation" }));
    await signedIn();
    await act(async () => {});
    expect(sends()).toHaveLength(0);
  });

  it("keeps sign-in available if stopping to open the continuation dialog fails", async () => {
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "stop_tab"
      ? Promise.reject(new Error("Stop failed")) : original(command, args));
    fireEvent.click(screen.getByRole("button", { name: "Continue in new session" }));
    const signIn = screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
    await waitFor(() => expect(signIn.disabled).toBe(false));
    fireEvent.click(signIn);
    await screen.findByText(/After sign-in is verified/);
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
    expect(sends()).toHaveLength(0);
  });

  it("waits for local write admission to return before checking and retrying the login", async () => {
    const backend = localSessionBackend(session.id);
    const mounted = render(<Harness backend={backend} />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    mounted.rerender(<Harness backend={{ ...backend, caps: { ...backend.caps, write: false } }} />);
    await signedIn();
    await act(async () => {});
    expect(sends()).toHaveLength(0);
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "check_agent_readiness"
      ? Promise.resolve({ state: "ready", checkedAt: null, version: null }) : original(command, args));
    mounted.rerender(<Harness backend={backend} />);
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it("types Claude's login command once and waits for verified login before retrying", async () => {
    session = { ...session, tabs: [{ ...session.tabs[0], harness: "claude" }] };
    upsertSession(session);
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/After sign-in is verified/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(mocks.enterTerminalView).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "pty_write").map(([, args]) => args.data)).toEqual(["/login", "\r"]));
    expect(mocks.openTerminal).not.toHaveBeenCalled();
    expect(sends()).toHaveLength(0);
    await signedIn("claude");
    await waitFor(() => expect(sends()).toHaveLength(1));
  });

  it("can start Claude sign-in after a continuation dialog interrupts opening its terminal", async () => {
    session = { ...session, tabs: [{ ...session.tabs[0], harness: "claude" }] };
    upsertSession(session);
    let opened!: () => void;
    mocks.enterTerminalView.mockImplementationOnce(() => new Promise<void>(resolve => { opened = resolve; }));
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue in new session" }));
    await screen.findByRole("dialog", { name: "Continue dialog" });
    await act(async () => opened());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss continuation" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/After sign-in is verified/);
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "pty_write").map(([, args]) => args.data)).toEqual(["/login", "\r"]));
    await signedIn("claude");
    await waitFor(() => expect(sends()).toHaveLength(1));
  });

  it.each(["stop", "unmount", "replacement", "new turn"])("cancels an authenticated retry after %s", async cancellation => {
    const mounted = render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    if (cancellation === "stop") fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    if (cancellation === "unmount") mounted.unmount();
    if (cancellation === "replacement") act(() => upsertSession({ ...session, tabs: [{ ...session.tabs[0], conversation: "replacement" }] }));
    if (cancellation === "new turn") emit({ type: "user_message", text: "A new task", queued: false });
    await signedIn();
    await act(async () => {});
    expect(sends()).toHaveLength(0);
  });

  it("does not replay after closing while the authenticated retry awaits confirmed exit", async () => {
    let settle!: () => void;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "stop_tab"
      ? new Promise<void>(resolve => { settle = resolve; }) : original(command, args));
    const mounted = render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect(settle).toBeTypeOf("function"));
    mounted.unmount();
    await act(async () => settle());
    expect(sends()).toHaveLength(0);
  });

  it.each(["replacement", "backend replacement", "new turn", "write admission"])("does not replay after %s changes while awaiting confirmed exit", async change => {
    let settle!: () => void;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "stop_tab"
      ? new Promise<void>(resolve => { settle = resolve; }) : original(command, args));
    const backend = localSessionBackend(session.id);
    const mounted = render(<Harness backend={backend} />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect(settle).toBeTypeOf("function"));
    if (change === "replacement") act(() => upsertSession({ ...session, tabs: [{ ...session.tabs[0], conversation: "replacement" }] }));
    if (change === "new turn") emit({ type: "user_message", text: "A new task", queued: false });
    if (change === "backend replacement") mounted.rerender(<Harness backend={{ ...backend, generation: "replacement" }} />);
    if (change === "write admission") mounted.rerender(<Harness backend={{ ...backend, caps: { ...backend.caps, write: false } }} />);
    await act(async () => settle());
    expect(sends()).toHaveLength(0);
    if (change !== "write admission") expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("allows an explicit retry after authenticated recovery cannot confirm exit", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    let failStop = true;
    mocks.invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "stop_tab" && failStop) {
        failStop = false;
        return Promise.reject(new Error("Could not confirm process exit"));
      }
      return original(command, args);
    });
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false));
    expect(sends()).toHaveLength(0);
    // A failed stop must not loop automatically or require another login.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps sign-in usable after Stop fails (login already open: %s)", async opened => {
    const original = mocks.invoke.getMockImplementation()!;
    let failStop = true;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "stop_tab" && failStop
      ? Promise.reject(new Error("Stop failed")) : original(command, args));
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    if (opened) {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await screen.findByText(/After sign-in is verified/);
    }
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(false));
    failStop = false;
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it("retains the login incident when the delivered recovery turn is also signed out", async () => {
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(1));
    // send_message emitted RECOVERY_PROMPT as a user message. It is still
    // recovery of the same interrupted work, not a fresh login incident.
    emit({ type: "recovery", kind: "signed_out" });
    await signedIn();
    expect(sends()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reuses successful login after the terminal exits (prior delivery failed: %s)", async failed => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "send_message" && failed
      ? Promise.reject(new Error("Agent is signed out")) : original(command, args));
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    if (failed) {
      await signedIn();
      await waitFor(() => expect(sends()).toHaveLength(1));
      await act(async () => {});
    }
    mocks.loginPanes[0].exited = true;
    const sending = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "check_agent_readiness"
      ? Promise.resolve({ state: "ready", checkedAt: null, version: null }) : sending(command, args));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sends()).toHaveLength(failed ? 2 : 1));
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it.each(["closed", "exited"])("reopens a login terminal that %s before sign-in finished", async ended => {
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    if (ended === "closed") mocks.loginPanes = [];
    else mocks.loginPanes[0].exited = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.openTerminal).toHaveBeenCalledTimes(2));
    await screen.findByText(/After sign-in is verified/);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mocks.openTerminal).toHaveBeenCalledTimes(2);
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(1));
  });

  it("allows another explicit attempt when the login terminal failed to open", async () => {
    mocks.openTerminal.mockRejectedValueOnce(new Error("Could not open terminal"));
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => {});
    expect(sends()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    expect(mocks.openTerminal).toHaveBeenCalledTimes(2);
  });

  it("does not loop after failed delivery but allows another explicit retry without another login", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "send_message"
      ? Promise.reject(new Error("Agent is signed out")) : original(command, args));
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(1));
    await act(async () => {});
    await signedIn();
    expect(sends()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/After sign-in is verified/);
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(2));
    await signedIn();
    expect(sends()).toHaveLength(2);
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it.each([["allow", "chat"], ["deny", "chat"], ["allow", "terminal"], ["deny", "terminal"]])("keeps %s in %s pending until delivery, then retires duplicate Codex requests (PRO-160)", async (option, mode) => {
    const original = mocks.invoke.getMockImplementation()!;
    let enqueued!: () => void;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "respond_permission"
      ? new Promise<void>(resolve => { enqueued = resolve; }) : original(command, args));
    mocks.views.views[session.tabs[0].id] = mode;
    render(<Harness />);
    const request: Payload = { type: "permission_requested", requestId: "codex-request", toolUseId: "", toolName: "Bash", input: { command: "pwd" }, options: [
      { id: "allow", kind: "allow_once", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" },
    ] };
    emit(request);
    emit(request);
    act(() => setTabStatus(session.id, session.tabs[0].id, "waiting"));
    expect(screen.getAllByText("Run a command")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: option === "allow" ? /^Allow/ : /^Deny/ }));
    fireEvent.click(screen.getByRole("button", { name: option === "allow" ? /^Allow/ : /^Deny/ }));
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "respond_permission")).toHaveLength(1);
    await act(async () => enqueued());
    // IPC success acknowledges the queue, not provider delivery. A duplicate
    // request must still leave one usable card until the owner settles it.
    expect(screen.getByRole("button", { name: /^Allow/ })).toBeTruthy();
    emit(request);
    expect(screen.getAllByText("Run a command")).toHaveLength(1);
    emit({ type: "permission_decided", requestId: "codex-request", allowed: option === "allow", label: option === "allow" ? "Allowed" : "Denied", automatic: false });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull());
    emit(request);
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "respond_permission")).toHaveLength(1);
  });

  it("draws a lone request inline in the chat's turn, and Escape denies it instead of interrupting (PRO-382)", () => {
    mocks.views.views[session.tabs[0].id] = "chat";
    render(<Harness />);
    emit({ type: "permission_requested", requestId: "esc-request", toolUseId: "", toolName: "Bash", input: { command: "pwd" }, options: [
      { id: "allow", kind: "allow_once", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" },
    ] });
    act(() => setTabStatus(session.id, session.tabs[0].id, "waiting"));
    const card = screen.getByTestId("permission-title");
    // In the transcript at the messages' width, not docked over the composer.
    expect(card.closest("[data-chat-scroller]")).toBeTruthy();
    expect(card.closest('[aria-label="Session recovery"]')).toBeNull();
    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });
    const answers = mocks.invoke.mock.calls.filter(([c]) => c === "respond_permission");
    expect(answers).toHaveLength(1);
    expect(JSON.stringify(answers[0][1])).toContain("deny");
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "interrupt_turn" || c === "interrupt")).toHaveLength(0);
  });

  it("retires a request answered in the terminal immediately (PRO-160)", () => {
    render(<Harness />);
    emit({ type: "permission_requested", requestId: "terminal-request", toolUseId: "", toolName: "Bash", input: { command: "pwd" }, options: [{ id: "allow", kind: "allow_once", label: "Allow" }] });
    act(() => setTabStatus(session.id, session.tabs[0].id, "waiting"));
    expect(screen.getByRole("button", { name: /^Allow/ })).toBeTruthy();
    emit({ type: "permission_decided", requestId: "terminal-request", allowed: true, label: "Allowed", automatic: false });
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "respond_permission")).toHaveLength(0);
  });

  it("does nothing when a stale card's callback runs after a terminal answer, and explains why (PRO-160)", async () => {
    mocks.views.views[session.tabs[0].id] = "chat";
    render(<Harness />);
    emit({ type: "permission_requested", requestId: "stale-request", toolUseId: "", toolName: "Bash", input: { command: "pwd" }, options: [{ id: "allow", kind: "allow_once", label: "Allow" }] });
    act(() => setTabStatus(session.id, session.tabs[0].id, "waiting"));
    const stale = mocks.answerPermission;
    emit({ type: "permission_decided", requestId: "stale-request", allowed: true, label: "Allowed", automatic: false });
    await act(async () => stale("stale-request", "allow"));
    expect(screen.getByText("This request was already answered or is no longer open.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "respond_permission")).toHaveLength(0);
  });

  it("retires a stale card when another window wins the answer before the backend receives this one (PRO-160)", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "respond_permission" ? Promise.reject("that request is no longer open") : original(command, args));
    render(<Harness />);
    emit({ type: "permission_requested", requestId: "stale-request", toolUseId: "", toolName: "Bash", input: { command: "pwd" }, options: [{ id: "allow", kind: "allow_once", label: "Allow" }] });
    act(() => setTabStatus(session.id, session.tabs[0].id, "waiting"));
    fireEvent.click(screen.getByRole("button", { name: /^Allow/ }));
    await screen.findByText("This request was already answered or is no longer open.");
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
    expect(screen.queryByText(/Retry safely/)).toBeNull();
  });

  it("sends a prompt the agent never received again, as it was sent, and leaves the draft alone (#663)", async () => {
    const otherwise = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => command === "resend_unsent"
      ? { queued: false, events: [event({ type: "user_message", text: "Fix the flaky test", queued: false })] }
      : otherwise(command, args));
    render(<Harness />);
    emit({ type: "user_message", text: "Fix the flaky test", queued: false });
    emit({ type: "recovery", kind: "unsent" });
    expect(screen.getByText("Prompt not received")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry safely" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resend last prompt" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("resend_unsent", { sessionId: session.id, tabId: session.tabs[0].id }));
    // The prompt went again: the notice is answered, and nothing the reader was typing is touched.
    await waitFor(() => expect(screen.queryByLabelText("Session recovery")).toBeNull());
    expect(mocks.invoke).not.toHaveBeenCalledWith("send_message", expect.anything());
    expect(getDraft(session.tabs[0].id)).toBe("Keep this unsent prompt");
  });

  it("shows one delivery notice with resend instructions and clears it when activity arrives", async () => {
    render(<Harness />);
    emit({ type: "user_message", text: "Implement my change", queued: false });
    emit({ type: "recovery", kind: "delivery_unconfirmed" });
    expect(screen.getAllByLabelText("Session recovery")).toHaveLength(1);
    expect(screen.getByText(/Prompt delivery could not be confirmed.*press Up in the composer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop session" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry safely" })).toBeNull();
    // Typing into the CLI clears its input first, and the unsent prompt with it.
    expect(screen.queryByRole("button", { name: "Continue here" })).toBeNull();
    expect(screen.queryByText(/No progress was confirmed before the timeout/)).toBeNull();
    emit({ type: "recovery", kind: null });
    act(() => setTabStatus(session.id, session.tabs[0].id, "in_progress"));
    expect(screen.queryByLabelText("Session recovery")).toBeNull();
    expect(screen.getByText("Terminal view · Working")).toBeTruthy();
    expect(getDraft(session.tabs[0].id)).toBe("Keep this unsent prompt");
  });

  it.each(["terminal", "chat"])("keeps usage exhaustion without retry after reopening the local %s view", view => {
    mocks.views.views[session.tabs[0].id] = view;
    const mounted = render(<Harness />);
    emit({ type: "rate_limited", status: "rejected", window: "seven_day", resetsAt: Date.now() + 3_600_000 });
    emit({ type: "recovery", kind: "usage_limit" });
    expect(screen.getByText("Usage limit reached")).toBeTruthy();
    expect(screen.queryByText(/Retry/i)).toBeNull();
    mounted.unmount();
    render(<Harness />);
    expect(screen.getByText("Usage limit reached")).toBeTruthy();
    expect(screen.getByTestId("usage-limit-reset").textContent).toContain("Weekly limit");
    expect(screen.queryByText(/Retry/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop session" })).toBeTruthy();
  });

  it("updates the actual sidebar, terminal header and dashboard count on capacity, then settles Stop", async () => {
    render(<Harness />);
    await screen.findByText("Terminal view · Working");
    emit({ type: "recovery", kind: "capacity" });
    expect(screen.getByText("Terminal view · Needs attention")).toBeTruthy();
    expect(within(screen.getByRole("complementary", { name: "Sidebar" })).getByRole("img", { name: "Needs attention" })).toBeTruthy();
    expect(screen.getByLabelText("Working count").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await screen.findByText("Terminal view · Idle");
    expect(screen.queryByLabelText("Session recovery")).toBeNull();
    expect(getDraft(session.tabs[0].id)).toBe("Keep this unsent prompt");
  });

  it("awaits stop before retrying once, preserves the draft, and never replays tool input", async () => {
    let settle!: () => void;
    const stopped = new Promise<void>(resolve => { settle = resolve; });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "stop_tab" ? stopped : original(command, args));
    render(<Harness />);
    emit({ type: "recovery", kind: "tool" });
    fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "send_message")).toHaveLength(0);
    await act(async () => settle());
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([c]) => c === "send_message")).toHaveLength(1));
    expect(mocks.invoke).toHaveBeenCalledWith("send_message", expect.objectContaining({ text: RECOVERY_PROMPT, images: [] }));
    expect(getDraft(session.tabs[0].id)).toBe("Keep this unsent prompt");
  });

  it.each(["capacity", "usage_limit"] as const)("switches an available model after %s and resumes the existing conversation", async kind => {
    render(<Harness />);
    emit({ type: "recovery", kind });
    if (kind === "usage_limit") expect(screen.queryByText(/Retry/i)).toBeNull();
    await screen.findByRole("option", { name: "Available model" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "available" } });
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([c]) => c === "send_message")).toBe(true));
    const actions = mocks.invoke.mock.calls.filter(([c]) => ["stop_tab", "set_tab_model", "send_message"].includes(c));
    expect(actions.map(([c]) => c)).toEqual(["stop_tab", "set_tab_model", "send_message"]);
    for (const [, args] of actions) expect(args).toEqual(expect.objectContaining({ sessionId: session.id, tabId: session.tabs[0].id }));
    expect(getDraft(session.tabs[0].id)).toBe("Keep this unsent prompt");
  });

  it("shows and expires a permission request in terminal view without counting it as work", async () => {
    render(<Harness />);
    emit({ type: "permission_requested", requestId: "r", toolUseId: "call", toolName: "Bash", input: { command: "private" }, options: [
      { id: "allow", kind: "allow_once", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" },
    ] });
    act(() => setTabStatus(session.id, session.tabs[0].id, "waiting"));
    expect(screen.getByText("Terminal view · Needs attention")).toBeTruthy();
    expect(screen.getByLabelText("Working count").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: /^Allow/ }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("respond_permission", expect.objectContaining({ requestId: "r", optionId: "allow" })));
    emit({ type: "permission_decided", requestId: "r", allowed: false, automatic: true, label: "Lapsed" });
    emit({ type: "recovery", kind: "permission_expired" });
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
    expect(screen.getByText(/permission request expired/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop session" })).toBeTruthy();
  });

  it("does not retry or switch model when local exit cannot be verified", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "stop_tab" ? Promise.reject("connection unknown TOKEN=secret /Users/private") : original(command, args));
    render(<Harness />);
    emit({ type: "recovery", kind: "disconnected" });
    fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Retry safely" }) as HTMLButtonElement).disabled).toBe(false));
    expect(mocks.invoke.mock.calls.some(([c]) => c === "send_message" || c === "set_tab_model")).toBe(false);
    expect(document.body.textContent).not.toMatch(/secret|TOKEN|\/Users/);
  });

  it("sends \"continue\" once in the same conversation without stopping, and keeps the draft", async () => {
    let deliver!: () => void;
    const delivered = new Promise<void>(resolve => { deliver = resolve; });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "send_message") await delivered;
      return original(command, args);
    });
    render(<Harness />);
    emit({ type: "user_message", text: "Implement my change", queued: false });
    emit({ type: "recovery", kind: "failed" });
    fireEvent.click(screen.getByRole("button", { name: "Continue here" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue here" }));
    await act(async () => deliver());
    // The sent message is the new turn, which ends the recovery.
    await waitFor(() => expect(screen.queryByLabelText("Session recovery")).toBeNull());
    const actions = mocks.invoke.mock.calls.filter(([c]) => ["stop_tab", "set_tab_model", "send_message"].includes(c));
    expect(actions).toEqual([["send_message", expect.objectContaining({ sessionId: session.id, tabId: session.tabs[0].id, text: CONTINUE_PROMPT, images: [] })]]);
    expect(getDraft(session.tabs[0].id)).toBe("Keep this unsent prompt");
  });

  it.each([
    ["codex", false], ["codex", true], ["claude", false], ["claude", true],
  ] as const)("allows explicit %s sign-in after Stop (login already pending: %s)", async (harness, pending) => {
    session.tabs[0].harness = harness;
    upsertSession(session);
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "stop_tab") { setTabStatus(session.id, session.tabs[0].id, "idle"); return; }
      return original(command, args);
    });
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    if (pending) {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await screen.findByText(/After sign-in is verified/);
    }
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await screen.findByText(/^Session closed/);
    await signedIn(harness);
    expect(sends()).toHaveLength(0);
    const button = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(/After sign-in is verified/);
    const login = harness === "codex" ? mocks.openTerminal : mocks.enterTerminalView;
    expect(login).toHaveBeenCalledTimes(pending ? 2 : 1);
    await signedIn(harness);
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0][1].text).toBe(RECOVERY_PROMPT);
    await signedIn(harness);
    expect(sends()).toHaveLength(1);
  });

  it("does not revive a cancelled login's delayed completion after explicit sign-in", async () => {
    let finishOld!: (pane: { id: string; exited: boolean }) => void;
    mocks.openTerminal.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "stop_tab") { setTabStatus(session.id, session.tabs[0].id, "idle"); return; }
      return original(command, args);
    });
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await screen.findByText(/^Session closed/);
    const button = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/After sign-in is verified/);
    await act(async () => finishOld({ id: "old-login", exited: false }));
    await signedIn();
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(mocks.openTerminal).toHaveBeenCalledTimes(2);
    await signedIn();
    expect(sends()).toHaveLength(1);
  });

  it("continues explicitly after Stop cancels a pending login, even when signed-out recovery remains", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "stop_tab") { setTabStatus(session.id, session.tabs[0].id, "idle"); return; }
      return original(command, args);
    });
    render(<Harness />);
    emit({ type: "recovery", kind: "signed_out" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/After sign-in is verified/);
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await screen.findByText(/^Session closed/);
    const button = screen.getAllByRole("button", { name: "Continue here" }).at(-1) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0][1].text).toBe(CONTINUE_PROMPT);
    expect(mocks.openTerminal).toHaveBeenCalledOnce();
  });

  it("continues the same conversation from the closed session's bar after Stop", async () => {
    render(<Harness />);
    emit({ type: "recovery", kind: "capacity" });
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await screen.findByText(/^Session closed/);
    const button = screen.getByRole("button", { name: "Continue here" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText(/^Session closed/)).toBeNull());
    // Stop's own exit, then the send that starts the agent again on its conversation; no second stop.
    const actions = mocks.invoke.mock.calls.filter(([c]) => ["stop_tab", "send_message"].includes(c));
    expect(actions.map(([c, args]) => [c, (args as { text?: string }).text])).toEqual([["stop_tab", undefined], ["send_message", CONTINUE_PROMPT]]);
    expect(getDraft(session.tabs[0].id)).toBe("Keep this unsent prompt");
  });

  it("leaves an empty draft empty when \"continue\" cannot be sent", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "send_message"
      ? Promise.reject("Stop has not confirmed local process exit. Retry Stop before resuming.")
      : original(command, args));
    setDraft(session.tabs[0].id, "");
    render(<Harness />);
    emit({ type: "recovery", kind: "disconnected" });
    const button = screen.getByRole("button", { name: "Continue here" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(mocks.invoke).toHaveBeenCalledWith("send_message", expect.objectContaining({ text: CONTINUE_PROMPT }));
    expect(mocks.invoke.mock.calls.some(([c]) => c === "stop_tab")).toBe(false);
    // Unlike a composer send, recovery does not put what it sent into the draft.
    expect(getDraft(session.tabs[0].id)).toBe("");
    expect(screen.getByLabelText("Session recovery")).toBeTruthy();
  });
});
