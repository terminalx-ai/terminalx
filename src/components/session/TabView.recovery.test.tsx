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
  clearTabViewError: vi.fn(), leaveTerminalView: vi.fn(),
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
import { RECOVERY_PROMPT } from "@/lib/recovery";

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
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "load_tab_events" || command === "list_workspaces") return [];
    if (command === "list_models") return [{ id: "available", harness: "codex", label: "Available model", efforts: [] }];
    if (command === "stop_tab") {
      applyEvent(event({ type: "recovery", kind: null }));
      setTabStatus(session.id, session.tabs[0].id, "idle");
    }
    if (command === "send_message") return { queued: false, events: [event({ type: "user_message", text: RECOVERY_PROMPT, queued: false })] };
  });
  upsertSession(session);
  selectSession(session.id);
  setDraft(session.tabs[0].id, "Keep this unsent prompt");
});
afterEach(cleanup);

describe("TabView recovery lifecycle", () => {
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

  it("switches an available model after stop and resumes the existing conversation", async () => {
    render(<Harness />);
    emit({ type: "recovery", kind: "capacity" });
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
});
