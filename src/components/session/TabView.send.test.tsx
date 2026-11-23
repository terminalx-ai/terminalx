import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeldQueue, AgentEvent } from "@/types/events";
import type { SessionEntry } from "@/types/session";

// #727: the real TabView, Chat and Composer over the local backend; only the
// runtime's replies are held, so what the window does meanwhile is what is seen.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {}, waiting: {} } }));
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
import { applyEvent } from "@/lib/agentEvents";
import { getErrorToasts, dismissError } from "@/lib/errorToasts";
import type { HeldQueueChange } from "@/lib/heldQueue";
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
  it("draws a sent message in a tab of several thousand events within its budget of reference work", async () => {
    const cost = await sendCost();
    expect(cost.sending, `drawn as sending: ${cost.said}`).toBeLessThan(SENDING_BUDGET);
    expect(cost.sent, `drawn as sent: ${cost.said}`).toBeLessThan(SENT_BUDGET);
  }, CPU_WAIT_MS);

  // PRO-334: the budgets are worth keeping only while they still catch a send
  // that has become twice the work. This one is made so on purpose.
  it("is over that budget once a send is twice the work", async () => {
    const cost = await sendCost({ times: 2 });
    expect(cost.sending, `drawn as sending, twice the work: ${cost.said}`).toBeGreaterThan(SENDING_BUDGET);
    expect(cost.sent, `drawn as sent, twice the work: ${cost.said}`).toBeGreaterThan(SENT_BUDGET);
  }, CPU_WAIT_MS);
});

// What a send may cost in a tab of several thousand events (#727), in units
// of `ReferenceWork` timed beside it. A time in milliseconds held on one
// machine and not on the next: about 30 ms where the test was written was 100
// to 119 ms on hosted runners, over a 100 ms limit with nothing changed
// (PRO-334). A send against a reference timed beside it is a figure that
// goes with neither the machine nor its load (see `sendCost`).
//
// A send costs about 1.2 units to draw as sending and 2.3 to draw as sent
// (1.12 to 1.33 and 1.98 to 2.53 over twelve runs at a load of 130 to 200).
// Each budget is that times the square root of two, so the figure can stray
// by 40% either way before either test above is wrong about it: a send that
// has become twice the work is over, and today's is under. When a change is
// meant to make sending dearer or cheaper, measure again (SEND_COST_LOG) and
// set these from what it costs then.
const SENDING_BUDGET = 1.7;
const SENT_BUDGET = 3.25;

// The first sends are not timed: V8 is still compiling the code a send runs,
// and a send costs three times as much until it has (7 units, then 2).
const SENDS_TO_WARM_UP = 10;
const SENDS_TIMED = 15;
// How long a run may wait for the processor before it is given up on. The
// cost is CPU time, so this is not part of what is checked: at a load of 200
// the twenty-five sends took more than five seconds of the clock.
const CPU_WAIT_MS = 120_000;

/**
 * The work a send's cost is measured in: what a send is made of (React
 * drawing rows again, jsdom changing the page, a query over it) at a fixed
 * size that nothing in the app changes.
 */
function ReferenceWork({ pass }: { pass: number }) {
  return (
    <ul>
      {Array.from({ length: 400 }, (_, row) => (
        <li key={row} data-testid="reference-row" className={(row + pass) % 2 ? "odd" : "even"}><span>{row}</span><b>{row + pass}</b></li>
      ))}
    </ul>
  );
}

/**
 * The CPU time this thread has used, in milliseconds. A wall clock times the
 * scheduler as much as the chat on a machine with other work queued, and the
 * process's CPU time adds what V8 compiles and collects on its other threads
 * whenever it chooses to.
 */
function threadMs() {
  const used = process.threadCpuUsage();
  return (used.user + used.system) / 1000;
}

/**
 * What a send costs the window in a tab of several thousand events: the work
 * to draw it as sending once Enter is pressed, and the work to draw it as sent
 * once the runtime has answered. Each is given in units of the reference work
 * timed just before and just after it, as the median over `SENDS_TIMED` sends,
 * so the speed of the machine, and of the moment, is in both halves of the
 * figure and not in the figure.
 *
 * Nothing here waits: a send that needed a frame or a timer before it was
 * drawn would not be on the page when it is looked for.
 *
 * `times` makes a send that many times the work, by keeping the thread busy
 * for as long again as each step took before the step is called done.
 */
async function sendCost({ times = 1 }: { times?: number } = {}) {
  saved = syntheticLog(320, false).map((event) => ({ ...event, sessionId: session.id, tabId: session.tabs[0].id }));
  nextSeq = saved.length;
  expect(saved.length).toBeGreaterThan(4000);
  runtime(true);
  render(<Tab />);
  await waitFor(() => expect(screen.getAllByTestId("reader-message").length).toBeGreaterThan(0));
  // Only the turns in and near the view are drawn, however long the conversation.
  expect(document.querySelectorAll("[data-turn]").length).toBeLessThan(20);

  // On a page of its own, so nothing a send looks for has to pass over it.
  const page = document.createElement("div");
  const reference = render(<ReferenceWork pass={0} />, { container: page });
  let pass = 0;
  const referenceMs = () => {
    const from = threadMs();
    reference.rerender(<ReferenceWork pass={++pass} />);
    expect(page.querySelectorAll('[data-testid="reference-row"]')).toHaveLength(400);
    return threadMs() - from;
  };
  const stepMs = async (step: () => unknown) => {
    const from = threadMs();
    await step();
    const until = threadMs() + (threadMs() - from) * (times - 1);
    while (threadMs() < until);
    return threadMs() - from;
  };

  const sending: number[] = [];
  const sent: number[] = [];
  const ms = { reference: [] as number[], sending: [] as number[], sent: [] as number[] };
  let before = referenceMs();
  for (let send = 1; send <= SENDS_TO_WARM_UP + SENDS_TIMED; send++) {
    const text = `Follow-up ${send}`;
    fireEvent.change(field(), { target: { value: text } });
    const sendingMs = await stepMs(() => {
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(sendingText()).toContain(text);
    });
    const sentMs = await stepMs(async () => {
      await act(async () => reply!.resolve());
      expect(sendingText()).toBeNull();
      expect(sentText(text)).toBe(true);
    });
    const after = referenceMs();
    const unit = (before + after) / 2;
    before = after;
    if (send <= SENDS_TO_WARM_UP) continue;
    sending.push(sendingMs / unit);
    sent.push(sentMs / unit);
    ms.reference.push(unit);
    ms.sending.push(sendingMs);
    ms.sent.push(sentMs);
  }
  expect(document.querySelectorAll("[data-turn]").length).toBeLessThan(20);

  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const cost = { sending: median(sending), sent: median(sent) };
  const said = `${cost.sending.toFixed(2)} units as sending, ${cost.sent.toFixed(2)} as sent`
    + ` (medians of ${median(ms.sending).toFixed(1)} and ${median(ms.sent).toFixed(1)} ms against ${median(ms.reference).toFixed(1)} ms of reference work)`;
  // A passing run prints nothing, so the figures are kept where asked for: this is what the budgets are set from.
  if (process.env.SEND_COST_LOG) appendFileSync(process.env.SEND_COST_LOG, `${JSON.stringify({ times, ...cost, ms: { reference: median(ms.reference), sending: median(ms.sending), sent: median(ms.sent) } })}\n`);
  return { ...cost, said };
}

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

describe("sending files (PRO-290)", () => {
  const notes = () => new File([new Uint8Array([1, 2, 3])], "notes.md", { type: "text/markdown" });
  const drop = (files: File[]) => fireEvent.drop(field().parentElement!, { dataTransfer: { files, types: ["Files"] } });
  const stored = (folder: string) => [{ path: `/home/.terminalx/attachments/${session.id}/${folder}/notes.md`, name: "notes.md", mediaType: "text/markdown", size: 3 }];

  it("stores a file that is not an image with the session, then sends its reference with the message", async () => {
    runtime(false);
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "store_attachments" ? stored("f1") : normal(command, args));
    render(<Tab />);
    drop([notes()]);
    await screen.findByTitle("notes.md");
    fireEvent.change(field(), { target: { value: "Read these notes" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("send_message", expect.objectContaining({ text: "Read these notes", files: stored("f1") })));
    expect(mocks.invoke).toHaveBeenCalledWith("store_attachments", { sessionId: session.id, files: [{ name: "notes.md", data: "AQID", mediaType: "text/markdown" }] });
    const order = mocks.invoke.mock.calls.map(([command]) => command).filter((command) => command === "store_attachments" || command === "send_message");
    expect(order).toEqual(["store_attachments", "send_message"]);
    await waitFor(() => expect(screen.queryByTitle("notes.md")).toBeNull());
  });

  it("stores a file once: a send that fails after storing it is tried again with the same copy", async () => {
    runtime(false);
    const normal = mocks.invoke.getMockImplementation()!;
    let sends = 0;
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "store_attachments") return stored("f4");
      if (command === "send_message" && ++sends === 1) throw new Error("the runtime restarted");
      return normal(command, args);
    });
    render(<Tab />);
    drop([notes()]);
    await screen.findByTitle("notes.md");
    fireEvent.change(field(), { target: { value: "Read these notes" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(field().value).toBe("Read these notes"));
    expect(await screen.findByTitle("notes.md")).toBeTruthy();
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(sends).toBe(2));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "send_message").map(([, args]) => (args as { files?: unknown }).files)).toEqual([stored("f4"), stored("f4")]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "store_attachments")).toHaveLength(1);
  });

  it("sends nothing and gives the file back when it cannot be stored, and stores it again on the next send", async () => {
    runtime(false);
    const normal = mocks.invoke.getMockImplementation()!;
    let stores = 0;
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "store_attachments") return normal(command, args);
      if (++stores === 1) throw new Error("disk full");
      return stored("f2");
    });
    render(<Tab />);
    drop([notes()]);
    await screen.findByTitle("notes.md");
    fireEvent.change(field(), { target: { value: "Read these notes" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(field().value).toBe("Read these notes"));
    expect(await screen.findByTitle("notes.md")).toBeTruthy();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "send_message")).toBe(false);
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("send_message", expect.objectContaining({ files: stored("f2") })));
    expect(stores).toBe(2);
  });

  it("stores a held follow-up's files first and holds them by reference with its text", async () => {
    const { setPrefs } = await import("@/lib/prefs");
    setPrefs({ followUps: "hold", shortcuts: {} });
    try {
      runtime(false);
      const normal = mocks.invoke.getMockImplementation()!;
      mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command === "store_attachments") return stored("f3");
        if (command !== "change_held_queue") return normal(command, args);
        return { queued: true, events: [{ id: "queue", seq: 1, sessionId: session.id, tabId: session.tabs[0].id, harness: "claude", ts: "",
          payload: { type: "held_queue", queue: { items: [{ id: "held", text: "Read these notes", images: [], files: stored("f3") }], paused: false, sending: null, next: null, error: null } } }] };
      });
      render(<Tab />);
      drop([notes()]);
      await screen.findByTitle("notes.md");
      fireEvent.change(field(), { target: { value: "Read these notes" } });
      fireEvent.keyDown(field(), { key: "Enter" });
      await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("change_held_queue", expect.objectContaining({ change: { type: "enqueue", text: "Read these notes", images: [], files: stored("f3"), sendNow: false } })));
      const order = mocks.invoke.mock.calls.map(([command]) => command).filter((command) => command === "store_attachments" || command === "change_held_queue");
      expect(order).toEqual(["store_attachments", "change_held_queue"]);
      expect(mocks.invoke.mock.calls.some(([command]) => command === "send_message")).toBe(false);
      const tray = await screen.findByRole("region", { name: "Held follow-ups" });
      expect(tray.textContent).toContain("notes.md");
    } finally {
      setPrefs({ followUps: "now" });
    }
  });
});

// #1115: real tray -> owning TabView -> local backend -> runtime command boundary.
describe("editing held goal commands", () => {
  afterEach(() => { for (const toast of getErrorToasts()) dismissError(toast.id); });
  for (const sendNow of [false, true]) {
    it.each([
      ["claude", "/goal objective", "Codex chats only"],
      ["codex", " /goal  ", "Type a goal after /goal"],
      ["codex", "/goal objective", null],
      ["codex", "/goal pause", null],
      ["codex", "/goal resume", null],
      ["claude", "ordinary edited text", null],
    ] as const)(`%s: %s with ${sendNow ? "Save and send now" : "Save then automatic dequeue"}`, async (harness, text, error) => {
      session.tabs[0].harness = harness;
      session.tabs[0].status = "in_progress";
      upsertSession(session);
      // Bare Codex goals need no attachments to match the composer's refusal policy.
      const attachments = text.trim() === "/goal" ? {} : {
        images: [{ url: "/image.png", name: "image.png" }],
        files: [{ path: "/notes.md", name: "notes.md", mediaType: "text/markdown", size: 3 }],
      };
      let queue: HeldQueue = { items: [
        { id: "first", text: "original", images: [], ...attachments },
        { id: "second", text: "later", images: [] },
      ], paused: false, sending: null, next: null, error: null };
      const original = structuredClone(queue);
      const snapshot = (): AgentEvent => ({ id: `q-${++nextSeq}`, seq: nextSeq, sessionId: session.id, tabId: session.tabs[0].id, harness, ts: "",
        payload: { type: "held_queue", queue: structuredClone(queue) } });
      saved = [snapshot()];
      runtime(false);
      const normal = mocks.invoke.getMockImplementation()!;
      const delivered: HeldQueue["items"] = [];
      const dequeue = () => {
        delivered.push(queue.items[0]);
        queue = { ...queue, items: queue.items.slice(1) };
        return snapshot();
      };
      mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command !== "change_held_queue") return normal(command, args);
        const change = args!.change as HeldQueueChange;
        if (change.type === "edit") queue = { ...queue, items: queue.items.map(item => item.id === change.id ? { ...item, text: change.text } : item) };
        return { queued: true, events: [change.type === "sendNow" ? dequeue() : snapshot()] };
      });
      render(<Tab />);
      fireEvent.click(await screen.findByLabelText("Edit follow-up 1"));
      const editor = screen.getByLabelText("Edit held follow-up") as HTMLTextAreaElement;
      fireEvent.change(editor, { target: { value: text } });
      fireEvent.click(screen.getByRole("button", { name: sendNow ? "Save and send now" : "Save" }));
      if (error) {
        await waitFor(() => expect(getErrorToasts().some(toast => toast.cause.includes(error))).toBe(true));
        expect(editor.value).toBe(text);
        expect(queue).toEqual(original);
        expect(mocks.invoke.mock.calls.filter(([command]) => command === "change_held_queue")).toEqual([]);
      } else {
        await waitFor(() => expect(screen.queryByLabelText("Edit held follow-up")).toBeNull());
        if (sendNow) await waitFor(() => expect(delivered).toHaveLength(1));
        else {
          expect(queue.items).toEqual([{ ...original.items[0], text }, original.items[1]]);
          // The runtime publishes its next queue snapshot when the active turn ends.
          act(() => applyEvent(dequeue()));
        }
        expect(delivered).toEqual([{ ...original.items[0], text }]);
        expect(queue.items).toEqual([original.items[1]]);
        expect(mocks.invoke.mock.calls.filter(([command]) => command === "change_held_queue").map(([, args]) => args.change)).toEqual([
          { type: "edit", id: "first", text }, ...(sendNow ? [{ type: "sendNow", id: "first" }] : []),
        ]);
      }
    });
  }
});
