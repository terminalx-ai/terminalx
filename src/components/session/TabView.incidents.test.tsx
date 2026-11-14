import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { SessionEntry, TabStatus } from "@/types/session";

// #815: the real TabView, Chat and Composer over the local backend, for a
// native Codex tab. Only the runtime's replies are made up here.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {}, waiting: {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => false, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn(),
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
vi.mock("@/components/chat/Dictation", () => ({ DictationStatus: () => null, MicButton: () => null, useDictationInto: () => ({ dictating: false, toggle: vi.fn(), prepareSend: vi.fn(() => vi.fn()) }), useDictationShortcuts: vi.fn() }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: () => null }));
// jsdom has no 2D canvas: the idle raccoon's animation frame would throw after a test ends.
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));

import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getSessionStore, upsertSession, useSessionStore } from "@/lib/sessions";
import { applyEvent, setTabStatus } from "@/lib/agentEvents";
import { BUSY_NOTICE } from "@/lib/recovery";
import type { UiReport } from "@/lib/recoveryReports";

/** What native Codex says when a message arrives while its turn runs (`session_codex_stdio.rs`). */
const BUSY = "Codex is still working on this turn, so this message was not sent. Send it when the turn ends, or interrupt the turn first.";

let session: SessionEntry;
let seq: number;
let refuse: string | null;
let queueSends: boolean;
let stopping: { resolve: () => void } | null;
let reports: UiReport[];

function Tab({ active = true }: { active?: boolean }) {
  const current = useSessionStore().sessions.find((s) => s.id === session.id)!;
  return <TooltipProvider><TabView session={current} tab={current.tabs[0]} active={active} /></TooltipProvider>;
}

const field = () => document.querySelector("textarea") as HTMLTextAreaElement;
const tab = () => session.tabs[0].id;
const status = () => getSessionStore().sessions.find((s) => s.id === session.id)!.tabs[0].status;
const event = (payload: Payload): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: session.id, tabId: tab(), harness: "codex", ts: new Date().toISOString(), payload });
const emit = (payload: Payload) => act(() => applyEvent(event(payload)));
const showStatus = (next: TabStatus) => act(() => setTabStatus(session.id, tab(), next));
const banner = () => screen.queryByRole("status", { name: "Session recovery" });
/** What was shown on `surface`: its exposures, not the actions pressed there. */
const of = (surface: UiReport["surface"]) => reports.filter((report) => report.kind === "exposure" && report.surface === surface);
const send = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.keyDown(field(), { key: "Enter" });
};

beforeEach(() => {
  const id = `incidents-${Math.random().toString(36).slice(2)}`;
  session = { id, projectPath: "/workspace", cwd: "/workspace", title: "Incident test", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `${id}-tab`, harness: "codex", transport: "experimentalCodexStdio", model: "gpt-6-astra", permissionMode: "default", status: "in_progress", created: "", modified: "" }] };
  seq = 0;
  refuse = null;
  queueSends = false;
  stopping = null;
  reports = [];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "load_tab_events") return [];
    if (command === "report_recovery_ui") {
      reports.push((args as { report: UiReport }).report);
      return null;
    }
    if (command === "stop_tab") {
      return new Promise<void>((resolve) => {
        stopping = { resolve: () => {
          applyEvent(event({ type: "recovery", kind: null }));
          setTabStatus(session.id, tab(), "idle");
          resolve();
        } };
      });
    }
    if (command === "send_message") {
      if (refuse) throw refuse;
      // As the runtime does for a prompt that starts a turn.
      setTabStatus(session.id, tab(), "in_progress");
      return { queued: queueSends, events: [event({ type: "user_message", text: String(args!.text), queued: queueSends })] };
    }
    return command.startsWith("list_") ? [] : null;
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  upsertSession(session);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("native Codex follow-ups (#866)", () => {
  it("shows a follow-up as queued until acknowledgement moves it into its own turn", async () => {
    render(<Tab />);
    queueSends = true;
    send("Please also check the remaining tasks");
    await waitFor(() => expect(screen.getByTestId("queued-message").textContent).toContain("Queued"));
    expect(field().value).toBe("");
    expect(banner()).toBeNull();
    const promptSeq = seq;
    emit({ type: "turn_completed", status: "ok", authFailed: false });
    expect(screen.getByTestId("queued-message")).toBeTruthy();
    emit({ type: "prompt_absorbed", promptSeq });
    emit({ type: "turn_started", promptSeq });
    await waitFor(() => expect(screen.queryByTestId("queued-message")).toBeNull());
    expect(screen.getAllByText("Please also check the remaining tasks")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "send_message")).toHaveLength(1);
  });

  it("preserves an unacknowledged follow-up without offering a blind resend", async () => {
    render(<Tab />);
    queueSends = true;
    send("Keep this follow-up");
    await waitFor(() => expect(screen.getByTestId("queued-message")).toBeTruthy());
    emit({ type: "prompt_withdrawn", promptSeq: seq, unconfirmed: true });
    await waitFor(() => expect(screen.getByTestId("prompt-withdrawn").textContent).toContain("Delivery was not confirmed"));
    expect(screen.getByText("Keep this follow-up")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    expect(screen.queryByText("Queued")).toBeNull();
  });
});

describe("a send native Codex refuses while it works (#815)", () => {
  it("keeps an overflowed message in the composer without changing the running turn", async () => {
    render(<Tab />);
    refuse = "Codex's follow-up queue is full. Wait for a message to be delivered before sending again.";
    send("The thirty-third follow-up");
    await waitFor(() => expect(field().value).toBe("The thirty-third follow-up"));
    expect(banner()).toBeNull();
    expect(status()).toBe("in_progress");
    expect(screen.getByText(/follow-up queue is full/)).toBeTruthy();
    expect(of("banner")).toEqual([]);
  });

  it("keeps the message and leaves the running turn as it was", async () => {
    render(<Tab />);
    refuse = BUSY;
    send("Also check the docs");
    await waitFor(() => expect(field().value).toBe("Also check the docs"));
    expect(screen.getByText(BUSY_NOTICE)).toBeTruthy();
    // No warning, no Needs attention, no error row: the turn is still working.
    expect(banner()).toBeNull();
    expect(screen.queryByText("The agent encountered an error. Review the conversation before continuing.")).toBeNull();
    expect(status()).toBe("in_progress");
    await waitFor(() => expect(of("composer_notice").map((r) => [r.phase, r.reason])).toEqual([["shown", null]]));
    expect(of("banner")).toEqual([]);

    // Once the turn it met has ended, the message is just unsent: the notice goes.
    showStatus("completed");
    await waitFor(() => expect(screen.queryByText(BUSY_NOTICE)).toBeNull());
    expect(of("composer_notice").map((r) => [r.phase, r.hideReason])).toEqual([["shown", undefined], ["hidden", "cleared"]]);
    expect(field().value).toBe("Also check the docs");
    // And it goes as an ordinary send.
    refuse = null;
    send("Also check the docs");
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "send_message")).toHaveLength(2));
    expect(field().value).toBe("");
  });

  it("still raises a genuine failure of the send", async () => {
    render(<Tab />);
    refuse = "network disconnected";
    send("Run the tests");
    await waitFor(() => expect(banner()).toBeTruthy());
    expect(status()).toBe("waiting");
    expect(field().value).toBe("Run the tests");
    await waitFor(() => expect(of("banner").map((r) => [r.phase, r.reason, r.placement])).toEqual([["shown", "disconnected", "composer"]]));
  });
});

describe("what of a warning was seen, and what was pressed (#815)", () => {
  const failed = () => {
    emit({ type: "recovery", kind: "failed" });
    showStatus("waiting");
  };

  it("says nothing of a tab mounted in the background, and tells hiding and resurfacing by the tab in front", async () => {
    const view = render(<Tab active={false} />);
    failed();
    view.rerender(<Tab active={false} />);
    await act(async () => {});
    expect(reports).toEqual([]);
    view.rerender(<Tab active />);
    await waitFor(() => expect(of("banner")).toHaveLength(1));
    // Drawn again with nothing changed: no second showing.
    view.rerender(<Tab active />);
    emit({ type: "status", text: "still here" });
    expect(of("banner")).toHaveLength(1);
    view.rerender(<Tab active={false} />);
    view.rerender(<Tab active />);
    await waitFor(() => expect(of("banner")).toHaveLength(3));
    expect(of("banner").map((r) => [r.phase, r.hideReason, r.reason, r.activeTab])).toEqual([
      // Hidden by the tab going behind another: said as the tab is then, not in front.
      ["shown", undefined, "failed", true], ["hidden", "tab_hidden", "failed", false], ["resurfaced", undefined, "failed", true],
    ]);
    expect(of("banner")[1].durationMs).toBeGreaterThanOrEqual(0);
    view.unmount();
    expect(of("banner").at(-1)).toMatchObject({ phase: "hidden", hideReason: "unmounted" });
  });

  it("tells each action's start and result, with how it was pressed, and a second press while one runs as rejected", async () => {
    render(<Tab />);
    failed();
    const retry = await screen.findByRole("button", { name: "Retry safely" });
    act(() => {
      fireEvent.click(retry, { detail: 0 });
      fireEvent.click(retry, { detail: 1 });
    });
    await waitFor(() => expect(stopping).not.toBeNull());
    const actions = () => reports.filter((r) => r.kind === "action").map((r) => [r.action, r.phase, r.result, r.input, r.rejectReason, r.reason, r.tabStatus]);
    expect(actions()).toEqual([
      ["retry", "start", "accepted", "keyboard", undefined, "failed", "waiting"],
      ["retry", "start", "rejected", "pointer", "in_progress", "failed", "waiting"],
    ]);
    expect(reports.find((r) => r.kind === "action")!.sinceExposureMs).toBeGreaterThanOrEqual(0);
    await act(async () => stopping!.resolve());
    await waitFor(() => expect(actions().at(-1)).toEqual(["retry", "result", "ok", undefined, undefined, null, "in_progress"]));
    // The banner went with the warning, said as cleared.
    expect(of("banner").map((r) => [r.phase, r.hideReason])).toEqual([["shown", undefined], ["hidden", "cleared"]]);
  });

  it("tells Stop session, Continue here and a failed action with the warning its error would be", async () => {
    render(<Tab />);
    emit({ type: "recovery", kind: "disconnected" });
    showStatus("waiting");
    fireEvent.click(await screen.findByRole("button", { name: "Continue here" }));
    await waitFor(() => expect(reports.filter((r) => r.action === "continue_here")).toHaveLength(2));
    expect(reports.filter((r) => r.action === "continue_here").map((r) => r.result)).toEqual(["accepted", "ok"]);

    emit({ type: "recovery", kind: "disconnected" });
    showStatus("waiting");
    refuse = "Codex connection timed out";
    fireEvent.click(await screen.findByRole("button", { name: "Continue here" }));
    await waitFor(() => expect(reports.filter((r) => r.action === "continue_here")).toHaveLength(4));
    expect(reports.filter((r) => r.action === "continue_here").at(-1)).toMatchObject({ result: "failed", errorKind: "timeout" });

    fireEvent.click(within(banner()!).getByRole("button", { name: "Stop session" }));
    await waitFor(() => expect(stopping).not.toBeNull());
    await act(async () => stopping!.resolve());
    await waitFor(() => expect(reports.filter((r) => r.action === "stop").map((r) => [r.surface, r.result])).toEqual([["banner", "accepted"], ["banner", "ok"]]));
  });

  it("gets on with the tab when the runtime cannot take a report", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "report_recovery_ui" ? Promise.reject("unknown method runtime.session.incidentUi") : original(command, args));
    render(<Tab />);
    failed();
    fireEvent.click(await screen.findByRole("button", { name: "Retry safely" }));
    await waitFor(() => expect(stopping).not.toBeNull());
    await act(async () => stopping!.resolve());
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([command, args]) => command === "send_message" && (args as { text: string }).text.startsWith("Review the previous"))).toBe(true));
  });
});
