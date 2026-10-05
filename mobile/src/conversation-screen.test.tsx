// @vitest-environment jsdom
import { act, useImperativeHandle, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionScreen from "../app/session/[sessionId]";
import SessionsScreen from "../app/(tabs)/sessions";

const mocks = vi.hoisted(() => ({
  params: { sessionId: "worktree", tabId: "claude", hostId: "mac" },
  storage: new Map<string, string>(),
  app: {} as any,
  push: vi.fn(),
  setParams: vi.fn(),
  sessionListeners: new Map<string, (event: unknown) => void>(),
  terminalListeners: new Map<string, (event: unknown) => void>(),
  listProps: {} as any,
  scrollToOffset: vi.fn(),
}));
vi.mock("expo-router", () => ({ Stack: { Screen: ({ options }: { options: { title: string } }) => <div data-testid="screen-title">{options.title}</div> }, useLocalSearchParams: () => mocks.params, useRouter: () => ({ push: mocks.push, setParams: mocks.setParams }) }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "test" }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => mocks.storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { mocks.storage.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { mocks.storage.delete(key); }),
} }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ChevronRight", "Search", "ChevronUp", "FileText", "MoreVertical", "Paperclip", "Radio", "Send", "Terminal", "X"].map((name) => [name, () => null])));
vi.mock("react-native", () => {
  const Box = ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => <div role={accessibilityRole === "link" ? "link" : undefined}>{children}</div>;
  return {
    View: Box, Text: Box, ScrollView: Box, KeyboardAvoidingView: Box, Image: () => null, RefreshControl: () => null,
    Platform: { OS: "web", select: ({ default: fallback }: any) => fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: any) => <button disabled={disabled} aria-label={accessibilityLabel} aria-pressed={accessibilityState?.selected} onClick={onPress}>{children}</button>,
    TextInput: ({ value, onChangeText, placeholder }: any) => <input value={value} onInput={(event) => onChangeText(event.currentTarget.value)} placeholder={placeholder} />,
    FlatList: (props: any) => {
      mocks.listProps = props;
      useImperativeHandle(props.ref, () => ({ scrollToOffset: mocks.scrollToOffset }));
      const { data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent } = props;
      return <div>{ListHeaderComponent}{data.length ? data.map((item: unknown, index: number) => <div key={index}>{renderItem({ item })}</div>) : ListEmptyComponent}<div data-testid="list-footer">{ListFooterComponent}</div></div>;
    },
    SectionList: ({ sections, renderItem, ListHeaderComponent, ListEmptyComponent }: any) => <div>{ListHeaderComponent}{sections.length ? sections.flatMap((section: any) => section.data.map((item: any) => <div key={item.key}>{renderItem({ item })}</div>)) : ListEmptyComponent}</div>,
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  EmptyState: ({ title, detail }: any) => <div>{title}{detail}</div>, StatusDot: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let hostCounter = 0;
const event = (tabId: string, text: string, seq = 1) => ({ id: `${tabId}-${seq}`, sessionId: "worktree", tabId, harness: tabId, seq, ts: "2026-09-15T00:00:00Z", payload: { type: "user_message", text, queued: false } });
const render = async (list = false) => { await act(async () => { root.render(list ? <SessionsScreen /> : <SessionScreen />); }); };
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
};
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const input = () => container.querySelector("input")!;
const type = async (value: string) => { await act(async () => { const field = input(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); };
const select = async (tabId: string) => { mocks.params.tabId = tabId; await render(); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.params = { sessionId: "worktree", tabId: "claude", hostId: `mac-${++hostCounter}` };
  mocks.storage.clear();
  mocks.sessionListeners.clear();
  mocks.terminalListeners.clear();
  mocks.push.mockClear();
  mocks.scrollToOffset.mockClear();
  mocks.setParams.mockImplementation((params) => Object.assign(mocks.params, params));
  mocks.app = {
    logs: [],
    hosts: [], activeHost: { id: mocks.params.hostId, label: "Mac", endpoint: "localhost" }, connectionStage: "connected",
    sessions: [{ id: "worktree", title: "Create a new issue", project: "TerminalX", worktree: "issue-132", modified: "today", tabs: [
      { id: "claude", harness: "claude", status: "waiting" }, { id: "codex", harness: "codex", status: "in_progress" },
    ] }],
    connection: { onEvent: () => () => {}, reportError: vi.fn() },
    api: {
      features: async () => ({}),
      tail: vi.fn(async (_session: string, tab: string) => ({ events: [event(tab, `${tab} transcript`)], hasMore: false })),
      listNotes: vi.fn(async () => []),
      subscribeSession: vi.fn((tab, listener) => { mocks.sessionListeners.set(tab, listener); return () => { mocks.sessionListeners.delete(tab); }; }),
      subscribeTerminal: vi.fn((_session, tab, listener) => { mocks.terminalListeners.set(tab, listener); return () => { mocks.terminalListeners.delete(tab); }; }),
      readTerminal: vi.fn(async (_session, tab) => `${tab} output`),
      respondPermission: vi.fn(async () => ({ answered: true })),
      queueInput: vi.fn(async () => true), releaseInput: vi.fn(async () => {}),
      postNote: vi.fn(async (_session, text) => ({ sent: true, note: { id: "note", body: text, createdAt: 0, author: { userId: "me" } } })),
      promoteNote: vi.fn(async () => ({ sent: true, queued: false })),
    },
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("mobile transcript presentation (#388)", () => {
  it("makes bare URLs clickable in prompts, reasoning, and notes", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "Open https://example.com/prompt"), {
      ...event("claude", "", 2), payload: { type: "reasoning", text: "Looking at https://example.com/thinking" },
    }], hasMore: false });
    mocks.app.api.listNotes.mockResolvedValueOnce([{ id: "note", body: "Reference https://example.com/note", createdAt: 0, author: { userId: "me" } }]);
    await render();
    expect(container.querySelectorAll('[role="link"]')).toHaveLength(3);
  });
  it("omits the redundant picker for a single conversation", async () => {
    mocks.app.sessions[0].tabs = [mocks.app.sessions[0].tabs[0]];
    await render();
    expect(container.querySelector('[data-testid="screen-title"]')?.textContent).toBe("Claude Code");
    expect(container.querySelector('[aria-label="Open Claude Code"]')).toBeNull();
    expect(container.textContent).toContain("claude transcript");
  });

  it("renders the completed fallback with the same markdown renderer", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "Explain this"), {
      ...event("claude", "", 2), payload: { type: "turn_completed", status: "error", authFailed: false, finalText: "**Final answer** with `code`" },
    }], hasMore: false });
    await render();
    expect(container.textContent).toContain("Final answer");
    expect(container.textContent).not.toContain("**Final answer**");
    expect(container.textContent).not.toContain("`code`");
  });

  it("renders assistant markdown instead of its delimiters", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "Explain this"), {
      ...event("claude", "", 2), payload: { type: "assistant_text", text: "**Important** and `value`\n\n# Heading\n\n- First\n- Second\n\n| Name | Value |\n| --- | --- |\n| Answer | 42 |" },
    }], hasMore: false });
    await render();
    expect(container.textContent).toContain("Important");
    expect(container.textContent).toContain("value");
    expect(container.textContent).toContain("Heading");
    expect(container.textContent).toContain("First");
    expect(container.textContent).toContain("Answer");
    expect(container.textContent).not.toContain("**Important**");
    expect(container.textContent).not.toContain("`value`");
    expect(container.textContent).not.toContain("# Heading");
    expect(container.textContent).not.toContain("- First");
    expect(container.textContent).not.toContain("| --- | --- |");
  });

  it("hides harness-only prompts and retains real text around reminders", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [
      event("claude", "<task-notification>\n<task-id>background-123</task-id>\n<output-file>/tmp/private-task.output</output-file>\n</task-notification>"),
      event("claude", "Please continue.\n<system-reminder>Internal harness instructions</system-reminder>", 2),
    ], hasMore: false });
    await render();
    expect(container.textContent).toContain("Please continue.");
    expect(container.textContent).not.toContain("task-notification");
    expect(container.textContent).not.toContain("background-123");
    expect(container.textContent).not.toContain("/tmp/private-task.output");
    expect(container.textContent).not.toContain("system-reminder");
    expect(container.textContent).not.toContain("Internal harness instructions");
    expect(mocks.listProps.data).toHaveLength(1);
  });
});

describe("mobile conversation navigation", () => {
  it("opens each list row with the exact conversation and searches by agent", async () => {
    await render(true);
    const rows = [...container.querySelectorAll("button")].filter((item) => item.textContent?.includes("Create a new issue"));
    expect(rows).toHaveLength(2);
    for (const [index, tabId] of ["claude", "codex"].entries()) {
      await act(async () => rows[index].click());
      expect(mocks.push).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({ sessionId: "worktree", tabId, hostId: mocks.params.hostId }) }));
    }
    await type("Codex");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).not.toContain("Claude Code");
  });

  it("switches agents, keeps drafts and transcripts separate, and sends to the selected tab", async () => {
    await render();
    expect(container.querySelector('[data-testid="screen-title"]')?.textContent).toBe("Claude Code");
    expect(container.textContent).toContain("Create a new issue");
    await type("Claude draft");
    await click("Open Codex"); await render();
    expect(container.querySelector('[data-testid="screen-title"]')?.textContent).toBe("Codex");
    expect(mocks.params.tabId).toBe("codex");
    expect(input().value).toBe("");
    expect(container.textContent).toContain("codex transcript");
    expect(container.textContent).not.toContain("claude transcript");
    await type("Codex draft");
    await click("Send");
    expect(mocks.app.api.promoteNote).toHaveBeenCalledWith("worktree", "codex", "note", []);
    await select("claude");
    expect(input().value).toBe("Claude draft");
    expect(container.textContent).not.toContain("codex transcript");
    expect(mocks.sessionListeners.has("codex")).toBe(false);
  });

  it("keeps Terminal hidden and does not open terminal subscriptions when switching agents", async () => {
    await render(); await type("chat draft"); await select("codex"); await select("claude");
    expect(input().value).toBe("chat draft");
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("Terminal");
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("Chat");
    expect(mocks.app.api.readTerminal).not.toHaveBeenCalled();
    expect(mocks.app.api.subscribeTerminal).not.toHaveBeenCalled();
    expect(mocks.app.api.queueInput).not.toHaveBeenCalled();
  });

  it("targets permission answers independently and keeps a removed tab from falling back", async () => {
    mocks.app.api.tail.mockImplementation(async (_session: string, tab: string) => ({ events: [event(tab, `${tab} transcript`), {
      ...event(tab, "", 2), payload: { type: "permission_requested", requestId: `${tab}-ask`, toolUseId: "tool", toolName: "shell", input: {}, options: [{ id: "allow", label: "Allow", kind: "allow_once" }] },
    }], hasMore: false }));
    await render(); await click("Allow");
    expect(mocks.app.api.respondPermission).toHaveBeenLastCalledWith("worktree", "claude", "claude-ask", "allow");
    await select("codex"); await click("Allow");
    expect(mocks.app.api.respondPermission).toHaveBeenLastCalledWith("worktree", "codex", "codex-ask", "allow");
    mocks.app.sessions[0].tabs = [mocks.app.sessions[0].tabs[0]];
    await render();
    expect(container.textContent).toContain("no longer available");
    expect(button("Allow").disabled).toBe(true);
    expect(mocks.params.tabId).toBe("codex");
  });

  it("does not open a conversation on another Mac with matching worktree and tab IDs", async () => {
    await render(); await type("Private draft");
    mocks.app.activeHost.id = "another-mac";
    await render();
    expect(container.textContent).toContain("Session unavailable");
    expect(container.querySelector("input")).toBeNull();
    mocks.params.hostId = "another-mac";
    await render(); expect(input().value).toBe("");
  });

  it("keeps an in-flight send scoped when returning to its conversation", async () => {
    let finish!: (value: unknown) => void;
    mocks.app.api.promoteNote.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(); await type("Send once"); await click("Send");
    await select("codex"); await type("Other draft"); await select("claude");
    expect(button("Send").disabled).toBe(true);
    await act(async () => finish({ sent: true, queued: false }));
    expect(input().value).toBe("");
    expect(container.textContent).toContain("Sent to the agent.");
    await select("codex"); expect(input().value).toBe("Other draft");
  });

  it("retains the selected agent and draft on reconnect and rejects late transcript loads", async () => {
    let resolve!: (value: unknown) => void;
    mocks.app.api.tail.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render(); await select("codex"); await type("Keep this");
    await act(async () => resolve({ events: [event("claude", "late Claude")], hasMore: false }));
    expect(container.textContent).not.toContain("late Claude");
    mocks.app.connectionStage = "cant-connect"; await render();
    mocks.app.sessions[0].tabs.reverse(); mocks.app.connectionStage = "connected"; await render();
    expect(mocks.params.tabId).toBe("codex"); expect(input().value).toBe("Keep this");
    expect(container.textContent).toContain("codex transcript");
    await select("claude"); expect(input().value).toBe("");
    expect(container.textContent).toContain("claude transcript");
  });

  it("reads what it missed after a reconnect that was never shown, keeping what is on screen (PRO-50)", async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("claude transcript");
    expect(mocks.app.api.tail).toHaveBeenCalledTimes(1);
    // Back from the home screen: the stage never left "connected", only the epoch moved.
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "claude transcript"), event("claude", "written while away", 2)], hasMore: false });
    mocks.app = { ...mocks.app, connectionEpoch: 1 };
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(mocks.app.api.tail).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("claude transcript");
    expect(container.textContent).toContain("written while away");
    expect(container.textContent).not.toContain("Session unavailable");
  });

  it("clears failed initial loading and retries without showing empty-history copy", async () => {
    mocks.app.api.tail.mockRejectedValueOnce(new Error("Transcript event 12 is too large to load on mobile. Open this conversation on your Mac."));
    await render();
    expect(container.textContent).toContain("Could not load transcript");
    expect(container.textContent).toContain("Open this conversation on your Mac.");
    expect(container.textContent).not.toContain("No transcript yet");
    expect(container.textContent).not.toContain("Loading transcript");
    expect(button("Retry loading transcript").disabled).toBe(false);
    await click("Retry loading transcript");
    expect(container.textContent).toContain("claude transcript");
    expect(container.textContent).not.toContain("Could not load transcript");
    expect(mocks.app.api.tail).toHaveBeenCalledTimes(2);
  });

  it("keeps cached history and the draft visible when a refresh fails", async () => {
    await render(); await type("Keep my draft");
    mocks.app.api.tail.mockRejectedValueOnce(new Error("Connection closed"));
    mocks.app.connectionEpoch = 1;
    await render();
    expect(container.textContent).toContain("claude transcript");
    expect(container.textContent).toContain("Connection closed");
    expect(input().value).toBe("Keep my draft");
    await click("Retry loading transcript");
    expect(container.textContent).not.toContain("Could not load transcript");
    expect(input().value).toBe("Keep my draft");
  });

  it("shows a recoverable offline error when the connection drops during the initial load", async () => {
    let reject!: (reason: Error) => void;
    mocks.app.api.tail.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await render();
    expect(container.textContent).toContain("Loading transcript");
    mocks.app.connectionStage = "cant-connect";
    await render();
    await act(async () => reject(new Error("Connection closed")));
    expect(container.textContent).toContain("Reconnect to your Mac");
    expect(container.textContent).not.toContain("No transcript yet");
    expect(container.textContent).not.toContain("Loading transcript");
    expect(button("Retry loading transcript").disabled).toBe(true);
    mocks.app.connectionStage = "connected";
    await render();
    expect(container.textContent).toContain("claude transcript");
    expect(container.textContent).not.toContain("Could not load transcript");
  });

  it("only shows empty-history copy for a successfully loaded empty transcript", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [], hasMore: false });
    await render();
    expect(container.textContent).toContain("No transcript yet");
    expect(container.textContent).not.toContain("Could not load transcript");
  });

  it("offers earlier context when a page split inside a turn contains only tool results", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [{
      ...event("claude", "", 8), payload: { type: "tool_call_completed", callId: "read", result: { text: "contents", isError: false } },
    }], hasMore: true });
    await render();
    expect(container.textContent).toContain("Earlier turns available");
    expect(container.textContent).not.toContain("No transcript yet");
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "Read the file", 1)], hasMore: false });
    await click("Load earlier");
    expect(mocks.app.api.tail).toHaveBeenLastCalledWith("worktree", "claude", 8);
    expect(container.textContent).toContain("Read the file");
  });

  it("retries the same earlier cursor after failure and prevents duplicate loads", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "latest", 10)], hasMore: true });
    await render();
    let reject!: (reason: Error) => void;
    mocks.app.api.tail.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await click("Load earlier");
    expect(button("Loading earlier…").disabled).toBe(true);
    await click("Loading earlier…");
    expect(mocks.app.api.tail).toHaveBeenCalledTimes(2);
    await act(async () => reject(new Error("Timed out")));
    expect(container.textContent).toContain("latest");
    expect(container.textContent).toContain("Could not load earlier turns");
    expect(container.textContent).toContain("Timed out");
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "earlier", 9)], hasMore: false });
    await click("Retry loading earlier");
    expect(mocks.app.api.tail.mock.calls.slice(1)).toEqual([["worktree", "claude", 10], ["worktree", "claude", 10]]);
    expect(container.textContent).toContain("earlier");
    expect(container.textContent).toContain("latest");
    expect(container.textContent).not.toContain("Could not load earlier turns");
    expect(container.textContent).not.toContain("Load earlier");
  });

  it("retries a failed incremental page and keeps the earlier cursor during live catch-up", async () => {
    mocks.app.api.features = async () => ({ transcript: 1 });
    const page = (seq: number, reset = false) => ({
      events: [event("claude", `synced ${seq}`, seq)], reset,
      cursor: { offset: seq, digest: "a".repeat(64) }, hasMore: false, hasEarlier: true,
    });
    mocks.app.api.syncTranscript = vi.fn().mockRejectedValueOnce(new Error("Event too large. Open this conversation on your Mac."));
    await render();
    expect(container.textContent).toContain("Could not load transcript");
    expect(container.textContent).toContain("Event too large");
    mocks.app.api.syncTranscript.mockResolvedValueOnce(page(10, true));
    await click("Retry loading transcript");
    expect(container.textContent).toContain("synced 10");
    expect(container.textContent).not.toContain("Could not load transcript");

    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "earlier", 5)], hasMore: true });
    await click("Load earlier");
    expect(mocks.app.api.tail).toHaveBeenLastCalledWith("worktree", "claude", 10);
    mocks.app.api.syncTranscript.mockResolvedValueOnce(page(11));
    await act(async () => {
      mocks.sessionListeners.get("claude")!(event("claude", "live", 11));
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(container.textContent).toContain("synced 11");
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "oldest", 1)], hasMore: false });
    await click("Load earlier");
    expect(mocks.app.api.tail).toHaveBeenLastCalledWith("worktree", "claude", 5);
  });

  it("uses the page cursor and replaces an unverified older cached range", async () => {
    mocks.storage.set(`terminalx:transcript:${mocks.params.hostId}:worktree:claude`, JSON.stringify([event("claude", "cached", 1)]));
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "latest", 10)], hasMore: true });
    await render();
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "gap", 5)], hasMore: true });
    await click("Load earlier");
    expect(mocks.app.api.tail).toHaveBeenLastCalledWith("worktree", "claude", 10);
    expect(container.textContent).not.toContain("cached");
    expect(container.textContent).toContain("gap");
    await click("Load earlier");
    expect(mocks.app.api.tail).toHaveBeenLastCalledWith("worktree", "claude", 5);
  });

  it("ignores an earlier page that finishes after switching conversations", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "latest", 10)], hasMore: true });
    await render();
    let finish!: (value: unknown) => void;
    mocks.app.api.tail.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click("Load earlier");
    await select("codex");
    await act(async () => finish({ events: [event("claude", "stale earlier", 5)], hasMore: false }));
    expect(container.textContent).not.toContain("stale earlier");
    await select("claude");
    expect(container.textContent).not.toContain("stale earlier");
  });

  it("does not report a successful transcript load as failed when notes cannot load", async () => {
    mocks.app.api.listNotes.mockRejectedValueOnce(new Error("Notes unavailable"));
    await render();
    expect(container.textContent).toContain("claude transcript");
    expect(container.textContent).not.toContain("Could not load transcript");
  });
});

// Native geometry and gestures are exercised by scripts/transcript-viewport.
// These integration tests cover cache/host sequencing and conversation identity.
describe("mobile latest conversation edge", () => {
  const scroll = async (offset: number) => {
    await act(async () => mocks.listProps.onScroll({ nativeEvent: { contentOffset: { y: offset } } }));
  };
  const latestText = () => mocks.listProps.data[0]?.turn.prompt.text;

  it("opens cached content and then the newer host tail at the latest edge", async () => {
    const key = `terminalx:transcript:${mocks.params.hostId}:worktree:claude`;
    mocks.storage.set(key, JSON.stringify([event("claude", "cached latest")]));
    let resolve!: (value: unknown) => void;
    mocks.app.api.tail.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    expect(latestText()).toBe("cached latest");
    expect(mocks.listProps.inverted).toBe(true);
    await act(async () => resolve({ events: [event("claude", "host latest", 2)], hasMore: true }));
    expect(latestText()).toBe("host latest");
    expect(container.querySelector('[data-testid="list-footer"]')?.contains(button("Load earlier"))).toBe(true);
    expect(container.textContent).not.toContain("Jump to latest");
  });

  it("keeps a reader away through host loading, live events and reconnects; switching resets the edge", async () => {
    let resolve!: (value: unknown) => void;
    mocks.storage.set(`terminalx:transcript:${mocks.params.hostId}:worktree:claude`, JSON.stringify([event("claude", "cached latest")]));
    mocks.app.api.tail.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render(); await scroll(600);
    await act(async () => resolve({ events: [event("claude", "host latest", 2)], hasMore: true }));
    await act(async () => mocks.sessionListeners.get("claude")?.(event("claude", "live latest", 3)));
    // The authoritative host tail includes the event it just published, both
    // on reconnect and when this conversation is opened again.
    mocks.app.api.tail.mockImplementation(async (_session: string, tab: string) => ({ events: [event(tab, tab === "claude" ? "live latest" : "codex transcript", tab === "claude" ? 3 : 1)], hasMore: true }));
    mocks.app = { ...mocks.app, connectionEpoch: 1 }; await render();
    expect(button("Jump to latest")).toBeTruthy();
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
    await click("Jump to latest");
    expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
    await scroll(0);
    expect(container.textContent).not.toContain("Jump to latest");
    await scroll(600); await select("codex");
    expect(latestText()).toBe("codex transcript");
    expect(container.textContent).not.toContain("Jump to latest");
    await select("claude");
    expect(latestText()).toBe("live latest");
    expect(container.textContent).not.toContain("Jump to latest");
  });

  it("follows content and keyboard layout only near latest, and never interrupts a drag", async () => {
    await render();
    await act(async () => mocks.listProps.onContentSizeChange(400, 5000));
    expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
    mocks.scrollToOffset.mockClear();
    await act(async () => mocks.listProps.onScrollBeginDrag());
    await act(async () => mocks.listProps.onContentSizeChange(400, 6000));
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
    await scroll(600);
    await act(async () => mocks.listProps.onScrollEndDrag());
    await act(async () => { mocks.listProps.onContentSizeChange(400, 7000); mocks.listProps.onLayout(); });
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
    await scroll(30);
    await act(async () => mocks.listProps.onLayout());
    expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  });

  it("adds earlier history at the opposite edge without resetting the reader", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "current", 30)], hasMore: true });
    await render(); await scroll(900);
    const position = mocks.listProps.maintainVisibleContentPosition;
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "earlier", 1)], hasMore: false });
    await click("Load earlier");
    expect(mocks.app.api.tail).toHaveBeenLastCalledWith("worktree", "claude", 30);
    expect(mocks.listProps.data.map((item: any) => item.turn.prompt.text)).toEqual(["current", "earlier"]);
    expect(mocks.listProps.maintainVisibleContentPosition).toBe(position);
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
    expect(button("Jump to latest")).toBeTruthy();
  });
});
