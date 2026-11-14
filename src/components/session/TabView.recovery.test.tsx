import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => true, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn(),
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => <div>Terminal output</div> }));
vi.mock("@/components/chat/Chat", () => ({ Chat: ({ footer }: { footer: React.ReactNode }) => <div>{footer}</div> }));
vi.mock("@/components/chat/Composer", () => ({ Composer: ({ draft }: { draft: string }) => <textarea aria-label="Unsent prompt" value={draft} readOnly /> }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: () => <div>Continue dialog</div> }));

import { TabView } from "./TabView";
import { ProjectNavigation } from "@/components/layout/SidebarTree";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyEvent, setTabStatus } from "@/lib/agentEvents";
import { upsertSession, useSessionStore, selectSession } from "@/lib/sessions";
import { bucketSessions } from "@/lib/dashboard";
import { getDraft, setDraft } from "@/lib/drafts";
import { CONTINUE_PROMPT, RECOVERY_PROMPT } from "@/lib/recovery";

let seq = 0;
let session: SessionEntry;
const event = (payload: Payload): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: session.id, tabId: session.tabs[0].id, harness: "codex", ts: new Date().toISOString(), payload });
const emit = (payload: Payload) => act(() => applyEvent(event(payload)));
function Harness() {
  const store = useSessionStore();
  const current = store.sessions.find(s => s.id === session.id)!;
  const counts = bucketSessions([current]);
  return <TooltipProvider>
    <aside aria-label="Sidebar"><ProjectNavigation project={{ path: "/workspace", name: "Project" }} expanded /></aside>
    <output aria-label="Working count">{counts.working.length}</output>
    <TabView session={current} tab={current.tabs[0]} active />
  </TooltipProvider>;
}
beforeEach(() => {
  session = { id: `session${++seq}`, projectPath: "/workspace", cwd: "/workspace", title: "Recovery test", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `tab${seq}`, harness: "codex", model: "original", permissionMode: "default", status: "in_progress", created: "", modified: "" }] };
  mocks.views.views = { [session.tabs[0].id]: "terminal" };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
    if (command === "load_tab_events" || command === "list_workspaces") return [];
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
afterEach(cleanup);

describe("TabView recovery lifecycle", () => {
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
