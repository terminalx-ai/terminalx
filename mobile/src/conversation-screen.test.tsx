// @vitest-environment jsdom
import { act, type ReactNode } from "react";
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
}));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => mocks.params, useRouter: () => ({ push: mocks.push, setParams: mocks.setParams }) }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "test" }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => mocks.storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { mocks.storage.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { mocks.storage.delete(key); }),
} }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ChevronRight", "Search", "ChevronUp", "FileText", "Paperclip", "Radio", "Send", "Terminal", "X"].map((name) => [name, () => null])));
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box, Text: Box, ScrollView: Box, KeyboardAvoidingView: Box, Image: () => null, RefreshControl: () => null,
    Platform: { OS: "web", select: ({ default: fallback }: any) => fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: any) => <button disabled={disabled} aria-label={accessibilityLabel} aria-pressed={accessibilityState?.selected} onClick={onPress}>{children}</button>,
    TextInput: ({ value, onChangeText, placeholder }: any) => <input value={value} onInput={(event) => onChangeText(event.currentTarget.value)} placeholder={placeholder} />,
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: any) => <div>{ListHeaderComponent}{data.length ? data.map((item: unknown, index: number) => <div key={index}>{renderItem({ item })}</div>) : ListEmptyComponent}{ListFooterComponent}</div>,
    SectionList: ({ sections, renderItem, ListHeaderComponent, ListEmptyComponent }: any) => <div>{ListHeaderComponent}{sections.length ? sections.flatMap((section: any) => section.data.map((item: any) => <div key={item.key}>{renderItem({ item })}</div>)) : ListEmptyComponent}</div>,
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  EmptyState: ({ title }: any) => <div>{title}</div>, StatusDot: () => null,
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
  mocks.setParams.mockImplementation((params) => Object.assign(mocks.params, params));
  mocks.app = {
    logs: [],
    activeHost: { id: mocks.params.hostId, label: "Mac", endpoint: "localhost" }, connectionStage: "connected",
    sessions: [{ id: "worktree", title: "Create a new issue", project: "TerminalX", worktree: "issue-132", modified: "today", tabs: [
      { id: "claude", harness: "claude", status: "waiting" }, { id: "codex", harness: "codex", status: "in_progress" },
    ] }],
    connection: { onEvent: () => () => {}, reportError: vi.fn() },
    api: {
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
    await type("Claude draft");
    await click("CodexWorking"); await render();
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
});
