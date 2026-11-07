import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types/events";
import type { SessionEntry } from "@/types/session";

// #727: the real TabView, Chat and Composer over the local backend; only the
// runtime's replies are held, so what the window does meanwhile is what is seen.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => false, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn(),
}));
vi.mock("@/components/raccoon/Raccoon", () => ({ Raccoon: () => null, RaccoonRunner: () => null, RaccoonScene: () => null }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
vi.mock("@/components/chat/Dictation", () => ({ DictationStatus: () => null, MicButton: () => null, useDictationInto: () => ({ dictating: false, toggle: vi.fn(), prepareSend: vi.fn(() => vi.fn()) }), useDictationShortcuts: vi.fn() }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: () => null }));

import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { upsertSession, useSessionStore } from "@/lib/sessions";
import { syntheticLog } from "@/demo/synthetic";

let session: SessionEntry;
let saved: AgentEvent[];
let nextSeq: number;
let reply: { resolve: () => void; reject: (error: Error) => void } | null;
let shown: unknown[];

function Tab() {
  const current = useSessionStore().sessions.find((s) => s.id === session.id)!;
  return <TooltipProvider><TabView session={current} tab={current.tabs[0]} active /></TooltipProvider>;
}

const field = () => document.querySelector("textarea") as HTMLTextAreaElement;
const sentText = (text: string) => screen.queryAllByTestId("reader-message").some((node) => node.textContent?.includes(text));
const sendingText = () => screen.queryByTestId("sending-message")?.textContent ?? null;

/** The runtime's answer to a send: the user_message it published, once `hold` lets it go. */
function runtime(hold: boolean) {
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "load_tab_events") return saved;
    if (command === "report_send_shown") {
      shown.push(args);
      return null;
    }
    if (command !== "send_message") return command.startsWith("list_") ? [] : null;
    const event: AgentEvent = { id: `sent-${++nextSeq}`, seq: nextSeq, sessionId: session.id, tabId: session.tabs[0].id, harness: "claude", ts: new Date().toISOString(),
      payload: { type: "user_message", text: String(args!.text), queued: false } };
    if (!hold) return { queued: false, events: [event] };
    return new Promise((resolve, reject) => {
      reply = { resolve: () => resolve({ queued: false, events: [event] }), reject };
    });
  });
}

class QuietResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  const id = `send-${Math.random().toString(36).slice(2)}`;
  session = { id, projectPath: "/workspace", cwd: "/workspace", title: "Send test", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `${id}-tab`, harness: "claude", model: "opus", permissionMode: "default", status: "idle", created: "", modified: "" }] };
  saved = [];
  nextSeq = 0;
  reply = null;
  shown = [];
  mocks.invoke.mockReset();
  vi.stubGlobal("ResizeObserver", QuietResizeObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  upsertSession(session);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sending a message (#727)", () => {
  it("draws it in the chat as sending at once, and as sent once the runtime has it", async () => {
    runtime(true);
    render(<Tab />);
    fireEvent.change(field(), { target: { value: "Run the tests" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    // Before the runtime answers: in the chat, said to be sending, and out of the composer.
    expect(sendingText()).toContain("Run the tests");
    expect(sendingText()).toContain("Sending…");
    expect(field().value).toBe("");
    expect(sentText("Run the tests")).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("send_message", expect.objectContaining({ text: "Run the tests", pressedAt: expect.any(Number) }));
    await act(async () => reply!.resolve());
    await waitFor(() => expect(sendingText()).toBeNull());
    expect(screen.getAllByTestId("reader-message").filter((node) => node.textContent?.includes("Run the tests"))).toHaveLength(1);
    // Its timings go to the runtime once it is on screen as sent.
    await waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]).toEqual({ sessionId: session.id, tabId: session.tabs[0].id, seq: 1, timings: {
      pressedAt: expect.any(Number), drawnAt: expect.any(Number), answeredAt: expect.any(Number), shownAt: expect.any(Number),
    } });
  });

  it("puts the message back in the composer, with the error, when the send fails", async () => {
    runtime(true);
    render(<Tab />);
    fireEvent.change(field(), { target: { value: "Run the tests" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(sendingText()).toContain("Run the tests");
    await act(async () => reply!.reject(new Error("network disconnected")));
    expect(sendingText()).toBeNull();
    expect(sentText("Run the tests")).toBe(false);
    expect(field().value).toBe("Run the tests");
    expect(screen.getAllByText("The connection was lost. The process outcome is unknown.").length).toBeGreaterThan(0);
  });

  // The report's tab held about 490 events; this one holds several thousand.
  it("draws a sent message within 100 ms in a tab of several thousand events", async () => {
    const turns = 320;
    saved = syntheticLog(turns, false).map((event) => ({ ...event, sessionId: session.id, tabId: session.tabs[0].id }));
    nextSeq = saved.length;
    expect(saved.length).toBeGreaterThan(4000);
    runtime(true);
    render(<Tab />);
    await waitFor(() => expect(screen.getAllByTestId("reader-message").length).toBeGreaterThan(0));
    // Only the turns in and near the view are drawn, however long the conversation.
    expect(document.querySelectorAll("[data-turn]").length).toBeLessThan(20);

    // The work the window does is timed by its CPU time: on a machine with
    // other work queued (a load of 50 is usual where this was written) a wall
    // clock times the scheduler as much as the chat. The wall clock is held to
    // a looser bound, which still catches a frame or a timer waited for.
    const cpuMs = (since: NodeJS.CpuUsage) => {
      const used = process.cpuUsage(since);
      return (used.user + used.system) / 1000;
    };
    const atOnce = { cpu: [] as number[], wall: [] as number[] };
    const asSent = { cpu: [] as number[], wall: [] as number[] };
    for (let send = 1; send <= 5; send++) {
      const text = `Follow-up ${send}`;
      fireEvent.change(field(), { target: { value: text } });
      let started = performance.now();
      let cpu = process.cpuUsage();
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(sendingText()).toContain(text);
      atOnce.cpu.push(cpuMs(cpu));
      atOnce.wall.push(performance.now() - started);
      started = performance.now();
      cpu = process.cpuUsage();
      await act(async () => reply!.resolve());
      await waitFor(() => {
        expect(sendingText()).toBeNull();
        expect(sentText(text)).toBe(true);
      }, { interval: 1 });
      asSent.cpu.push(cpuMs(cpu));
      asSent.wall.push(performance.now() - started);
    }
    // The median of five: the first send also pays for compiling the code it runs.
    const median = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
    const said = (times: { cpu: number[]; wall: number[] }) => `cpu ${times.cpu.map(Math.round).join(", ")} ms; wall ${times.wall.map(Math.round).join(", ")} ms`;
    expect(median(atOnce.cpu), `drawn as sending: ${said(atOnce)}`).toBeLessThan(100);
    expect(median(asSent.cpu), `drawn as sent: ${said(asSent)}`).toBeLessThan(100);
    expect(median(atOnce.wall), `drawn as sending: ${said(atOnce)}`).toBeLessThan(400);
    expect(median(asSent.wall), `drawn as sent: ${said(asSent)}`).toBeLessThan(400);
    expect(document.querySelectorAll("[data-turn]").length).toBeLessThan(20);
  });
});

// PRO-254: exercise the real composer, route, backend command and queue tray.
describe("held follow-ups", () => {
  afterEach(async () => { const { setPrefs } = await import("@/lib/prefs"); setPrefs({ followUps: "now" }); });
  it.each([
    ["hold", false, false], ["now", true, false], ["hold", true, true],
  ] as const)("routes setting %s, alternate shortcut=%s through the queue (send now=%s)", async (setting, alternate, sendNow) => {
    const { setPrefs } = await import("@/lib/prefs");
    setPrefs({ followUps: setting, shortcuts: {} });
    runtime(false);
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "change_held_queue") return normal(command, args);
      return { queued: true, events: [{ id: "queue", seq: 1, sessionId: session.id, tabId: session.tabs[0].id, harness: "claude", ts: "",
        payload: { type: "held_queue", queue: { items: [{ id: "held", text: "Fix the typo", images: [] }], paused: false, sending: null, next: null, error: null } } }] };
    });
    render(<Tab />);
    fireEvent.change(field(), { target: { value: "Fix the typo" } });
    fireEvent.keyDown(field(), { key: "Enter", ctrlKey: alternate });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("change_held_queue", expect.objectContaining({ change: { type: "enqueue", text: "Fix the typo", images: [], sendNow } })));
    await screen.findByRole("region", { name: "Held follow-ups" });
    await waitFor(() => expect(sendingText()).toBeNull());
    expect(field().value).toBe("");
    expect(sentText("Fix the typo")).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "send_message")).toBe(false);
  });
});
