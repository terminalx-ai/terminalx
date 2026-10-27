import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { SessionEntry } from "@/types/session";
import type { OutboxEntry } from "@/lib/cloudAgentApi";
import type { SessionBackend } from "@/lib/sessionBackend";

// PRO-85: Up and Down in the composer recall the tab's messages, the same in a local and a cloud tab.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => false, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn(),
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
// The transcript is not under test; the real composer in its footer is.
vi.mock("@/components/chat/Chat", () => ({ Chat: ({ footer }: { footer: React.ReactNode }) => <div>{footer}</div> }));
vi.mock("@/components/chat/Dictation", () => ({ DictationStatus: () => null, MicButton: () => null, useDictationInto: () => ({ dictating: false, toggle: vi.fn() }), useDictationShortcuts: vi.fn() }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: () => null }));

import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyEvent } from "@/lib/agentEvents";
import { upsertSession, useSessionStore } from "@/lib/sessions";
import { setDraft } from "@/lib/drafts";
import { resetComposerHistory } from "@/components/chat/useComposerHistory";

let seq = 0;
let session: SessionEntry;
let logSessionId: string;
/** What the saved conversation holds when the tab opens. */
let saved: AgentEvent[];
let sends: string[];

const event = (payload: Payload, ts = "2026-10-01T10:00:00Z"): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: logSessionId, tabId: session.tabs[0].id, harness: "claude", ts, payload });
const user = (text: string, queued = false) => event({ type: "user_message", text, queued });

function LocalTab() {
  const current = useSessionStore().sessions.find((s) => s.id === session.id)!;
  return <TooltipProvider><TabView session={current} tab={current.tabs[0]} active /></TooltipProvider>;
}

/** A cloud session's backend as TabView sees it: sends go to the mailbox outbox, and the runtime holds queued follow-ups. */
let outbox: OutboxEntry[];
let followUps: { clientCommandId: string; text: string }[];
function cloudBackend(onChange: () => void): SessionBackend {
  const entries = outbox;
  const queued = followUps;
  return {
    kind: "cloud",
    key: `cloud:org-1:ws-1:${logSessionId}`,
    generation: "g1",
    caps: { local: false, write: true, steer: true, images: false, recovery: false, interrupt: false },
    readOnlyReason: null,
    logSessionId,
    openTab: () => undefined,
    send: async (tabId, text) => {
      sends.push(text);
      outbox = [...outbox, { clientCommandId: `c${++seq}`, tabId, kind: "send", text, state: "queued", createdAt: Date.now(), updatedAt: Date.now() }];
      onChange();
      return { events: [], queued: true };
    },
    steer: async () => undefined,
    interrupt: async () => undefined,
    stop: async () => undefined,
    respondPermission: async () => undefined,
    answerQuestions: async () => undefined,
    setModel: async () => undefined,
    setEffort: async () => undefined,
    setPermissionMode: async () => undefined,
    markRead: async () => undefined,
    patchTab: () => undefined,
    setTabStatus: () => undefined,
    outbox: { entries: (tabId) => entries.filter((entry) => entry.tabId === tabId), followUps: () => queued, deciding: () => false, sendAgain: async () => undefined },
  };
}

function CloudTab() {
  // The real cloud backend is rebuilt when its outbox changes; so is this one.
  const [, setVersion] = useState(0);
  const backend = cloudBackend(() => setVersion((v) => v + 1));
  return <TooltipProvider><TabView session={session} tab={session.tabs[0]} active backend={backend} /></TooltipProvider>;
}

const field = () => document.querySelector("textarea") as HTMLTextAreaElement;
const press = (key: "ArrowUp" | "ArrowDown" | "Enter") => fireEvent.keyDown(field(), { key });
const walk = (key: "ArrowUp" | "ArrowDown", times: number) => Array.from({ length: times }, () => (press(key), field().value));

/** A tab's log reaches the view on the next frame. */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

const KINDS = {
  local: {
    Tab: LocalTab,
    // first and second were sent and answered; the third was queued behind the running turn.
    open: () => {
      saved = [user("first"), event({ type: "turn_completed", status: "ok", authFailed: false }), user("second"), user("third, queued while working", true)];
    },
  },
  cloud: {
    Tab: CloudTab,
    // first is in the transcript, second is a follow-up queued on the runtime, the third still waits in the mailbox.
    open: () => {
      act(() => applyEvent(user("first")));
      followUps = [{ clientCommandId: "c-second", text: "second" }];
      outbox = [{ clientCommandId: "c-third", tabId: session.tabs[0].id, kind: "send", text: "third, queued while working", state: "queued", createdAt: Date.parse("2026-10-01T10:05:00Z"), updatedAt: 0 }];
    },
  },
} as const;

beforeEach(() => {
  resetComposerHistory();
  const n = ++seq;
  logSessionId = `session${n}`;
  session = { id: logSessionId, projectPath: "/workspace", cwd: "/workspace", title: "History", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `tab${n}`, harness: "claude", model: "default", permissionMode: "default", status: "in_progress", created: "", modified: "" }] };
  saved = [];
  sends = [];
  outbox = [];
  followUps = [];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: { text?: string }) => {
    if (command === "load_tab_events") return saved;
    if (command === "send_message") {
      sends.push(args!.text!);
      return { queued: true, events: [user(args!.text!, true)] };
    }
    if (command === "list_models" || command === "list_workspaces" || command === "list_slash_commands" || command === "search_files") return [];
    return null;
  });
  upsertSession(session);
  setDraft(session.tabs[0].id, "");
});
afterEach(cleanup);

describe.each(["local", "cloud"] as const)("composer history in a %s tab", (kind) => {
  const mount = async () => {
    const view = render((() => { const { Tab } = KINDS[kind]; return <Tab />; })());
    await waitFor(() => expect(field()).toBeTruthy());
    // The saved conversation has loaded once its newest message can be recalled.
    await waitFor(() => {
      press("ArrowUp");
      expect(field().value).not.toBe("");
    });
    press("ArrowDown");
    expect(field().value).toBe("");
    return view;
  };

  it("walks back through the tab's messages, queued follow-ups included, and forward again to the draft", async () => {
    KINDS[kind].open();
    await mount();

    expect(walk("ArrowUp", 4)).toEqual(["third, queued while working", "second", "first", "first"]);
    expect(walk("ArrowDown", 3)).toEqual(["second", "third, queued while working", ""]);
  });

  it("keeps a multi-line draft: the arrows move its caret, and browsing from its first line gives it back", async () => {
    KINDS[kind].open();
    await mount();
    const draft = "a draft\nover two lines";
    fireEvent.change(field(), { target: { value: draft } });

    // The caret is on the last line: Up is not the history's.
    expect(press("ArrowUp")).toBe(true);
    expect(field().value).toBe(draft);

    field().setSelectionRange(2, 2);
    expect(walk("ArrowUp", 2)).toEqual(["third, queued while working", "second"]);
    expect(walk("ArrowDown", 2)).toEqual(["third, queued while working", draft]);
  });

  it("recalls a message sent while the agent works, and has the history again after a restart", async () => {
    KINDS[kind].open();
    const view = await mount();

    fireEvent.change(field(), { target: { value: "one more thing" } });
    press("Enter");
    await waitFor(() => expect(sends).toEqual(["one more thing"]));
    await waitFor(() => expect(field().value).toBe(""));
    await nextFrame();
    expect(walk("ArrowUp", 2)).toEqual(["one more thing", "third, queued while working"]);

    // A recalled message goes out again like any other text.
    press("Enter");
    await waitFor(() => expect(sends).toEqual(["one more thing", "third, queued while working"]));
    await waitFor(() => expect(field().value).toBe(""));
    await nextFrame();

    view.unmount();
    resetComposerHistory();
    await mount();
    expect(walk("ArrowUp", 4)).toEqual(["third, queued while working", "one more thing", "second", "first"]);
  });
});

// #637: exercise the real local backend/composer with a deferred runtime reply.
describe("detached runtime send acknowledgment", () => {
  it.each(["accepted", "queued", "refused"])("shows progress before a %s runtime reply and preserves edits", async (outcome) => {
    let resolve!: (value: { queued: boolean; events: AgentEvent[] }) => void;
    let reject!: (error: Error) => void;
    const delivery = new Promise<{ queued: boolean; events: AgentEvent[] }>((yes, no) => { resolve = yes; reject = no; });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args?: { text?: string }) => {
      if (command === "send_message") { sends.push(args!.text!); return delivery; }
      return original(command, args);
    });
    const view = render(<LocalTab />);
    fireEvent.change(field(), { target: { value: "hello" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(view.getByText("Sending…")).toBeTruthy();
    expect(sends).toEqual(["hello"]);
    expect(mocks.invoke).toHaveBeenCalledWith("send_message", expect.objectContaining({ text: "hello", images: [] }));
    press("Enter");
    fireEvent.change(field(), { target: { value: "next" } });
    // Explicitly clearing a draft must survive a late delivery error too.
    if (outcome === "refused") fireEvent.change(field(), { target: { value: "" } });
    await act(async () => {
      if (outcome === "refused") reject(new Error("delivery uncertain"));
      else resolve({ queued: outcome === "queued", events: [] });
    });
    expect(view.queryByText("Sending…")).toBeNull();
    expect(field().value).toBe(outcome === "refused" ? "" : "next");
    expect(sends).toEqual(["hello"]);
  });
});

// R1/R2: real module-level draft/history stores, real Composer and local adapter;
// only IPC delivery is deferred. No detached process is launched by these drafts.
describe("pending send ownership across session remounts", () => {
  function deferDelivery() {
    let resolve!: (value: { queued: boolean; events: AgentEvent[] }) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<{ queued: boolean; events: AgentEvent[] }>((yes, no) => { resolve = yes; reject = no; });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args?: { text?: string }) => {
      if (command === "send_message") { sends.push(args!.text!); return promise; }
      return original(command, args);
    });
    return { resolve, reject };
  }

  describe.each(["accepted", "queued", "refused"])("%s reply", (outcome) => {
    it.each([undefined, "N", "", "P"])("preserves remounted draft ownership for %j", async (next) => {
      const delivery = deferDelivery();
      let view = render(<LocalTab />);
      fireEvent.change(field(), { target: { value: "P" } });
      fireEvent.click(view.getByRole("button", { name: "Send" }));
      view.unmount();
      // A write without any mounted composer must also be tracked, even P -> P.
      if (next !== undefined) act(() => setDraft(session.tabs[0].id, next));
      view = render(<LocalTab />);
      expect(view.getByText("Sending…")).toBeTruthy();
      expect(view.getByRole("button", { name: "Sending" }).hasAttribute("disabled")).toBe(true);
      press("Enter");
      expect(sends).toEqual(["P"]);
      await act(async () => {
        if (outcome === "refused") delivery.reject(new Error("network disconnected"));
        else delivery.resolve({ queued: outcome === "queued", events: [] });
      });
      expect(view.queryByText("Sending…")).toBeNull();
      expect(field().value).toBe(next ?? (outcome === "refused" ? "P" : ""));
      expect(sends).toEqual(["P"]);
      if (outcome === "refused") {
        expect(view.getAllByText("The connection was lost. The process outcome is unknown.").length).toBeGreaterThan(0);
        view.unmount();
        view = render(<LocalTab />);
        expect(view.getAllByText("The connection was lost. The process outcome is unknown.").length).toBeGreaterThan(0);
      }
    });
  });

  it("retains a rejection that arrives with no view mounted", async () => {
    const delivery = deferDelivery();
    let view = render(<LocalTab />);
    fireEvent.change(field(), { target: { value: "P" } });
    press("Enter");
    view.unmount();
    await act(async () => delivery.reject(new Error("network disconnected")));
    view = render(<LocalTab />);
    expect(view.queryByText("Sending…")).toBeNull();
    expect(view.getAllByText("The connection was lost. The process outcome is unknown.").length).toBeGreaterThan(0);
    expect(field().value).toBe("P");
    expect(sends).toEqual(["P"]);
  });

  it("observes edits in the returned composer before original acceptance", async () => {
    const delivery = deferDelivery();
    let view = render(<LocalTab />);
    fireEvent.change(field(), { target: { value: "P" } });
    press("Enter");
    view.unmount();
    view = render(<LocalTab />);
    fireEvent.change(field(), { target: { value: "N" } });
    press("Enter");
    await act(async () => delivery.resolve({ queued: false, events: [] }));
    expect(field().value).toBe("N");
    expect(sends).toEqual(["P"]);
    expect(view.queryByText("Sending…")).toBeNull();
  });

  it.each([false, true])("retains newer browsing and saved N (remount=%s)", async (remount) => {
    saved = [user("H")];
    const delivery = deferDelivery();
    let view = render(<LocalTab />);
    await waitFor(() => { press("ArrowUp"); expect(field().value).toBe("H"); });
    press("ArrowDown");
    fireEvent.change(field(), { target: { value: "P" } });
    press("Enter");
    if (remount) { view.unmount(); view = render(<LocalTab />); }
    fireEvent.change(field(), { target: { value: "N" } });
    press("ArrowUp");
    expect(field().value).toBe("H");
    await act(async () => delivery.resolve({ queued: false, events: [] }));
    expect(field().value).toBe("H");
    press("ArrowDown");
    expect(field().value).toBe("N");
    expect(sends).toEqual(["P"]);
  });

  it.each([false, true])("restores the untouched recalled-send draft (remount=%s)", async (remount) => {
    saved = [user("H")];
    const delivery = deferDelivery();
    let view = render(<LocalTab />);
    await waitFor(() => { press("ArrowUp"); expect(field().value).toBe("H"); });
    press("ArrowDown");
    fireEvent.change(field(), { target: { value: "saved draft" } });
    press("ArrowUp");
    press("Enter");
    if (remount) { view.unmount(); view = render(<LocalTab />); }
    await act(async () => delivery.resolve({ queued: false, events: [] }));
    expect(field().value).toBe("saved draft");
    expect(sends).toEqual(["H"]);
  });
});

// R3: real TabView/Composer and ownership/draft stores; the cloud backend's
// enqueue boundary is deferred independently of live connection attachment.
describe("cloud send ownership across connection generations", () => {
  function deferredCloud() {
    let resolve!: (value: { queued: boolean; events: AgentEvent[] }) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<{ queued: boolean; events: AgentEvent[] }>((yes, no) => { resolve = yes; reject = no; });
    const send = vi.fn(() => promise);
    const backend = { ...cloudBackend(() => {}), send };
    return { backend, send, resolve, reject };
  }
  function cloudView(backend: SessionBackend) {
    return <TooltipProvider><TabView session={session} tab={session.tabs[0]} active backend={backend} /></TooltipProvider>;
  }

  describe.each([false, true])("remount=%s", (remount) => {
    it.each(["accepted", "refused"])("retains pending ownership and current feedback on %s", async (outcome) => {
      const delivery = deferredCloud();
      let view = render(cloudView(delivery.backend));
      fireEvent.change(field(), { target: { value: "P" } });
      press("Enter");
      expect(delivery.send).toHaveBeenCalledExactlyOnceWith(session.tabs[0].id, "P", []);
      const reconnected = { ...delivery.backend, generation: "g2" };
      if (remount) { view.unmount(); view = render(cloudView(reconnected)); }
      else view.rerender(cloudView(reconnected));
      expect(view.getByText("Sending…")).toBeTruthy();
      expect(view.getByRole("button", { name: "Sending" }).hasAttribute("disabled")).toBe(true);
      press("Enter");
      expect(delivery.send).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (outcome === "accepted") delivery.resolve({ queued: true, events: [] });
        else delivery.reject(new Error("enqueue refused"));
      });
      expect(view.queryByText("Sending…")).toBeNull();
      expect(field().value).toBe(outcome === "accepted" ? "" : "P");
      expect(delivery.send).toHaveBeenCalledTimes(1);
      if (outcome === "refused") {
        expect(view.getByText(/Could not queue the command/)).toBeTruthy();
        view.unmount();
        view = render(cloudView({ ...reconnected, generation: "g3" }));
        expect(view.getByText(/Could not queue the command/)).toBeTruthy();
      }
    });

    it("preserves a newer draft when g1 accepts after reconnect", async () => {
      const delivery = deferredCloud();
      let view = render(cloudView(delivery.backend));
      fireEvent.change(field(), { target: { value: "P" } });
      press("Enter");
      const reconnected = { ...delivery.backend, generation: "g2" };
      if (remount) { view.unmount(); view = render(cloudView(reconnected)); }
      else view.rerender(cloudView(reconnected));
      fireEvent.change(field(), { target: { value: "N" } });
      press("Enter");
      await act(async () => delivery.resolve({ queued: true, events: [] }));
      expect(field().value).toBe("N");
      expect(delivery.send).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["organization", "workspace", "session"])("keeps a different %s destination independent of an old failure", async (part) => {
    const first = deferredCloud();
    const second = deferredCloud();
    const key = part === "organization" ? `cloud:org-2:ws-1:${logSessionId}`
      : part === "workspace" ? `cloud:org-1:ws-2:${logSessionId}`
      : `cloud:org-1:ws-1:other-${logSessionId}`;
    const other = { ...second.backend, key, generation: "g2" };
    let view = render(cloudView(first.backend));
    fireEvent.change(field(), { target: { value: "P" } });
    press("Enter");
    view.unmount();
    view = render(cloudView(other));
    expect(view.queryByText("Sending…")).toBeNull();
    fireEvent.change(field(), { target: { value: "N" } });
    press("Enter");
    expect(second.send).toHaveBeenCalledTimes(1);
    await act(async () => first.reject(new Error("old destination refused")));
    expect(view.getByText("Sending…")).toBeTruthy();
    expect(view.queryByText(/Could not queue the command/)).toBeNull();
    expect(field().value).toBe("N");
    await act(async () => second.resolve({ queued: true, events: [] }));
    expect(field().value).toBe("");
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
  });
});
