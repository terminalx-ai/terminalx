// @vitest-environment jsdom
import { act, useEffect, useImperativeHandle, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { AgentEvent } from "@terminalx/portable/events";
import SessionScreen from "../app/session/[sessionId]";
import SessionsScreen from "../app/(tabs)/sessions";
import { forgetConversationState, sendHeldMessages } from "@mobile/state/conversation-state";
import { RelayOuterError } from "./transport/relay-client";

const mocks = vi.hoisted(() => ({
  params: { sessionId: "worktree", tabId: "claude", hostId: "mac" },
  storage: new Map<string, string>(),
  app: {} as any,
  push: vi.fn(),
  alert: vi.fn(),
  setParams: vi.fn(),
  sessionListeners: new Map<string, (event: unknown) => void>(),
  sessionReady: new Map<string, () => void>(),
  terminalListeners: new Map<string, (event: unknown) => void>(),
  featureListeners: new Set<() => void>(),
  listProps: {} as any,
  scrollToOffset: vi.fn(),
  initialBatchOnly: false,
  uuids: 0,
  sheetChoice: "Choose File",
  pasted: new Set<(image: { data: string; width: number; height: number }) => void>(),
  keyboardDismissed: vi.fn(),
}));
vi.mock("../modules/paste-image", () => ({ addPasteImageListener: (listener: any) => { mocks.pasted.add(listener); return () => { mocks.pasted.delete(listener); }; } }));
vi.mock("expo-router", () => ({ useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), Stack: { Screen: ({ options }: { options: { title: string } }) => <div data-testid="screen-title">{options.title}</div> }, useLocalSearchParams: () => mocks.params, useRouter: () => ({ push: mocks.push, setParams: mocks.setParams }) }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
// The Sessions screen reads the cloud catalog for pinned cloud projects (#1469);
// its provider loads native modules. No cloud account here: the screen as it
// is drawn without the provider.
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => null, useCatalogSnapshot: () => ({ organizations: [], loading: false, error: null, refreshedAt: null, saved: false, titles: {}, deletesOrganizations: false }) }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-crypto", () => ({ randomUUID: () => `uuid-${++mocks.uuids}` }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: vi.fn() }));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => mocks.storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { mocks.storage.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { mocks.storage.delete(key); }),
  multiGet: vi.fn(async (keys: string[]) => keys.map((key) => [key, mocks.storage.get(key) ?? null])),
  multiSet: vi.fn(async (pairs: [string, string][]) => { for (const [key, value] of pairs) mocks.storage.set(key, value); }),
  multiRemove: vi.fn(async (keys: string[]) => { for (const key of keys) mocks.storage.delete(key); }),
} }));
// The + chooser: the test picks a file unless it chose the photo library (the chooser itself: ui/choices.test.ts).
vi.mock("@mobile/ui/choices", () => ({
  showChoices: (_title: string, choices: readonly string[], choose: (choice: string) => void) => { if (choices.includes(mocks.sheetChoice)) choose(mocks.sheetChoice); },
}));
vi.mock("react-native", () => {
  const Box = ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => <div role={accessibilityRole === "link" ? "link" : undefined}>{children}</div>;
  return {
    useWindowDimensions: () => ({ width: 375, height: 667, scale: 2, fontScale: 1 }),
    AppState: { currentState: "active" },
    AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove: () => undefined }) },
    Animated: { View: Box, Value: class { setValue() {} interpolate() { return "0deg"; } }, loop: () => ({ start: () => undefined, stop: () => undefined }), timing: () => ({}) },
    Easing: { linear: (value: number) => value },
    View: Box, Text: Box, KeyboardAvoidingView: Box,
    // A horizontal strip says its frame's style (merged), which is where it clips touches.
    ScrollView: ({ children, horizontal, style, contentContainerStyle }: any) => <div data-strip={horizontal ? JSON.stringify({ frame: Object.assign({}, ...[style].flat(3).filter(Boolean)), content: Object.assign({}, ...[contentContainerStyle].flat(3).filter(Boolean)) }) : undefined}>{children}</div>,
    Keyboard: { addListener: () => ({ remove: () => undefined }), isVisible: () => false, dismiss: () => mocks.keyboardDismissed() },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    ActivityIndicator: () => null,
    Alert: { alert: (...args: unknown[]) => mocks.alert(...args) },
    Modal: ({ visible, children }: any) => visible ? <div role="dialog">{children}</div> : null, Image: () => null, RefreshControl: () => null,
    Platform: { OS: "web", select: ({ default: fallback }: any) => fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    // A long press is a right-click here.
    Pressable: ({ children, onPress, onLongPress, disabled, accessibilityLabel, accessibilityState, accessibilityHint, hitSlop }: any) => <button disabled={disabled} aria-label={accessibilityLabel} data-hitslop={hitSlop === undefined ? undefined : JSON.stringify(hitSlop)} aria-pressed={accessibilityState?.selected} aria-expanded={accessibilityState?.expanded} aria-description={accessibilityHint} onClick={onPress} onContextMenu={onLongPress ? (event) => { event.preventDefault(); onLongPress(); } : undefined}>{children}</button>,
    TextInput: ({ value, onChangeText, placeholder, onFocus, onBlur, autoFocus }: any) => <input value={value} autoFocus={autoFocus} onInput={(event) => onChangeText(event.currentTarget.value)} onFocus={onFocus} onBlur={onBlur} placeholder={placeholder} />,
    FlatList: (props: any) => {
      mocks.listProps = props;
      useImperativeHandle(props.ref, () => ({ scrollToOffset: mocks.scrollToOffset }));
      const { data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent } = props;
      const mounted = mocks.initialBatchOnly ? data.slice(0, props.initialNumToRender ?? 10) : data;
      return <div>{ListHeaderComponent}{data.length ? mounted.map((item: unknown, index: number) => <div key={index}>{renderItem({ item })}</div>) : ListEmptyComponent}<div data-testid="list-footer">{ListFooterComponent}</div></div>;
    },
    SectionList: ({ sections, renderItem, renderSectionHeader, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: any) => <div>{ListHeaderComponent}{sections.length ? sections.map((section: any) => <section key={section.key} data-section={section.key}>
      {renderSectionHeader?.({ section })}{section.data.map((item: any, index: number) => <div key={item.key}>{renderItem({ item, index, section })}</div>)}
    </section>) : ListEmptyComponent}{ListFooterComponent}</div>,
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
  mocks.sessionReady.clear();
  mocks.terminalListeners.clear();
  mocks.featureListeners.clear();
  mocks.push.mockClear();
  mocks.keyboardDismissed.mockClear();
  mocks.scrollToOffset.mockClear();
  mocks.initialBatchOnly = false;
  mocks.sheetChoice = "Choose File";
  mocks.uuids = 0;
  mocks.setParams.mockImplementation((params) => Object.assign(mocks.params, params));
  mocks.app = {
    logs: [],
    hosts: [], activeHost: { id: mocks.params.hostId, label: "Mac", endpoint: "localhost" }, connectionStage: "connected", connectionAttempt: 0,
    sessions: [{ id: "worktree", title: "Create a new issue", project: "TerminalX", worktree: "issue-132", modified: "today", tabs: [
      { id: "claude", harness: "claude", status: "waiting" }, { id: "codex", harness: "codex", status: "in_progress" },
    ] }],
    connection: { onEvent: () => () => {}, reportError: vi.fn(), retryNow: vi.fn() },
    retryConnection: vi.fn(),
    api: {
      features: async () => ({}),
      onFeaturesChanged: (listener: () => void) => { mocks.featureListeners.add(listener); return () => { mocks.featureListeners.delete(listener); }; },
      // An older Mac: no session controls; `session-controls.test.tsx` covers them.
      sessionControls: async () => false,
      transport: () => "relay",
      reassemblesFragments: async () => false,
      tail: vi.fn(async (_session: string, tab: string) => ({ events: [event(tab, `${tab} transcript`)], hasMore: false })),
      listNotes: vi.fn(async () => []),
      markRead: vi.fn(async () => {}),
      subscribeSession: vi.fn((tab, listener, ready) => { mocks.sessionListeners.set(tab, listener); if (ready) mocks.sessionReady.set(tab, ready); return () => { mocks.sessionListeners.delete(tab); mocks.sessionReady.delete(tab); }; }),
      subscribeTerminal: vi.fn((_session, tab, listener) => { mocks.terminalListeners.set(tab, listener); return () => { mocks.terminalListeners.delete(tab); }; }),
      readTerminal: vi.fn(async (_session, tab) => `${tab} output`),
      respondPermission: vi.fn(async () => ({ answered: true })),
      answerQuestions: vi.fn(async () => ({ answered: true })),
      queueInput: vi.fn(async () => true), releaseInput: vi.fn(async () => {}),
      postNote: vi.fn(async (_session, text) => ({ sent: true, note: { id: "note", body: text, createdAt: 0, author: { userId: "me" } } })),
      sendSession: vi.fn(async () => ({ sent: true, queued: false })),
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

// #987: the session says which machine it is on, by the name it has on this phone.
it("names the machine in the session subtitle with the name saved on this phone", async () => {
  const host = { id: mocks.params.hostId, label: "This computer", hostName: "Office iMac", customName: "Desk", publicKeyB64: "k", endpoint: "localhost", lastConnectedAt: 1, provenance: { kind: "explicit" } };
  mocks.app = { ...mocks.app, hosts: [host], activeHost: host };
  await render();
  expect(container.textContent).toContain("TerminalX · Desk");
  expect(container.textContent).not.toContain("Office iMac");
});

// 22.07 frame 5: the header names the session by its branch, the notifications sheet by the session's own title, as its notifications do.
it("titles the session's notification sheet with the session's title, not the branch the header shows", async () => {
  mocks.app = { ...mocks.app, sessions: mocks.app.sessions.map((session: { id: string }) => session.id === "worktree" ? { ...session, branch: "pro-990-notifications" } : session) };
  await render();
  expect(container.textContent).toContain("pro-990-notifications");
  await act(async () => { [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "Notifications for this session")!.click(); });
  const sheet = container.querySelector("[role='dialog']")!;
  expect(sheet.textContent).toContain("Create a new issue");
  expect(sheet.textContent).toContain("Notifications for this session");
  expect(sheet.textContent).not.toContain("pro-990-notifications");
});

describe("mobile transcript ordering (#384)", () => {
  const at = (seq: number, ts: string, payload: AgentEvent["payload"]): AgentEvent => ({ ...event("claude", "", seq), ts, payload });
  // The native list is inverted; its data starts at the newest message.
  const messages = () => [...mocks.listProps.data].reverse().map((item) => item.kind === "note" ? item.note.body
    : item.row.kind === "work" ? item.row.item.text
      : item.row.kind === "markdown" ? item.row.token.text : item.row.text);

  it("keeps an old completed exchange before promptless work and queued follow-ups", async () => {
    const old = "2026-10-03T10:35:00Z";
    const recent = "2026-10-04T21:00:00Z";
    const followups = Array.from({ length: 15 }, (_, index) => [
      at(4334 + index * 2, recent, { type: "user_message", text: `Follow-up ${index}`, queued: true }),
      at(4335 + index * 2, recent, { type: "assistant_text", text: `Reply ${index}` }),
    ]).flat();
    mocks.app.api.tail.mockResolvedValueOnce({ events: [
      at(4330, old, { type: "user_message", text: "Old prompt", queued: false }),
      at(4331, old, { type: "assistant_text", text: "Old answer" }),
      at(4332, old, { type: "turn_completed", status: "ok", authFailed: false }),
      at(4333, recent, { type: "status", text: "Resuming work" }),
      ...followups,
    ], hasMore: false });
    await render();
    const expected = ["Old prompt", "Old answer", "Resuming work", ...Array.from({ length: 15 }, (_, index) => [`Follow-up ${index}`, `Reply ${index}`]).flat()];
    expect(messages()).toEqual(expected);

    await act(async () => mocks.sessionListeners.get("claude")!(at(4364, "2026-10-04T21:13:00Z", { type: "assistant_text", text: "Newest message" })));
    expect(messages()).toEqual([...expected, "Newest message"]);
    mocks.app.connectionStage = "reconnecting";
    await render();
    expect(messages()).toEqual([...expected, "Newest message"]);
  });

  it("places notes around a promptless turn using its first event, even after completion", async () => {
    const events = [
      at(1, "2026-10-03T10:00:00Z", { type: "user_message", text: "Old prompt", queued: false }),
      at(2, "2026-10-03T10:01:00Z", { type: "turn_completed", status: "ok", authFailed: false, finalText: "Old answer" }),
      at(3, "2026-10-04T10:00:00Z", { type: "assistant_text", text: "Continuing without a prompt" }),
    ];
    mocks.app.api.tail.mockResolvedValueOnce({ events, hasMore: false });
    mocks.app.api.listNotes.mockResolvedValueOnce([
      { id: "after", body: "Later note", createdAt: Date.parse("2026-10-04T10:01:00Z"), author: { userId: "me" } },
      { id: "before", body: "Earlier note", createdAt: Date.parse("2026-10-04T09:59:00Z"), author: { userId: "me" } },
    ]);
    await render();
    const expected = ["Old prompt", "Old answer", "Earlier note", "Continuing without a prompt", "Later note"];
    expect(messages()).toEqual(expected);
    await act(async () => mocks.sessionListeners.get("claude")!(at(4, "2026-10-04T10:02:00Z", { type: "turn_completed", status: "ok", authFailed: false })));
    expect(messages()).toEqual(expected);
  });

  it("keeps a partial turn after older history when its prompt arrives on an earlier page", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [
      at(3, "2026-10-04T10:01:00Z", { type: "assistant_text", text: "Partial-page reply" }),
    ], hasMore: true }).mockResolvedValueOnce({ events: [
      at(1, "2026-10-03T10:00:00Z", { type: "turn_completed", status: "ok", authFailed: false, finalText: "Older answer" }),
      at(2, "2026-10-04T10:00:00Z", { type: "user_message", text: "Missing prompt", queued: false }),
    ], hasMore: false });
    await render();
    expect(messages()).toEqual(["Partial-page reply"]);
    await click("Load earlier");
    expect(messages()).toEqual(["Older answer", "Missing prompt", "Partial-page reply"]);
  });
});

describe("messages for the agent and worktree notes (#541)", () => {
  // Every row of the conversation that shows this text, as a note or as a prompt.
  const shown = (text: string) => mocks.listProps.data.filter((item: any) => (item.kind === "note" ? item.note.body : item.row.text) === text);
  const at = Date.parse("2026-09-15T00:00:00Z");
  const note = (id: string, body: string, createdAt: number, promotedTo?: { tabId: string; seq: number }[]) => ({ id, body, createdAt, author: { userId: "me", displayName: "Paresh" }, ...(promotedTo ? { promotedTo } : {}) });
  const publish = async (text: string, seq = 2) => { await act(async () => mocks.sessionListeners.get("claude")!(event("claude", text, seq))); };

  it("sends a text message straight to the agent and shows it once, as the prompt", async () => {
    await render(); await type("Run the tests"); await click("Send");
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("claude", "Run the tests", [], expect.any(String));
    expect(mocks.app.api.postNote).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Sent to the agent.");
    await publish("Run the tests");
    expect(shown("Run the tests")).toEqual([expect.objectContaining({ kind: "turn", row: expect.objectContaining({ kind: "prompt" }) })]);
  });

  it("attaches photos from the library as JPEG, named for the photo", async () => {
    mocks.sheetChoice = "Photo Library";
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({ canceled: false, assets: [
      { uri: "file:///IMG_1.HEIC", fileName: "IMG_1.HEIC", mimeType: "image/heic", base64: "anBn", assetId: "a1", width: 1, height: 1 },
      { uri: "file:///shared", fileName: null, mimeType: "image/png", base64: "cG5n", assetId: null, width: 1, height: 1 },
    ] } as any);
    await render(); await click("Add attachment"); await click("Send");
    expect(vi.mocked(ImagePicker.launchImageLibraryAsync)).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 8, base64: true }));
    expect(DocumentPicker.getDocumentAsync).not.toHaveBeenCalled();
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("claude", "", [
      { mediaType: "image/jpeg", data: "anBn", name: "IMG_1.jpg" },
      { mediaType: "image/jpeg", data: "cG5n", name: "Photo 2.jpg" },
    ], expect.any(String));
  });

  it("attaches an image pasted into the message field, and only there", async () => {
    const paste = (data: string) => act(async () => { for (const listener of mocks.pasted) listener({ data, width: 1, height: 1 }); });
    await render();
    // Pasted while the field is not being typed in: not this message's.
    await paste("bm90");
    await act(async () => { input().focus(); });
    await paste("anBn");
    await act(async () => { input().blur(); });
    await click("Send");
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("claude", "", [{ mediaType: "image/jpeg", data: "anBn", name: "Pasted image.jpg" }], expect.any(String));
  });

  it("sends the text and its attachments in one message", async () => {
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({ canceled: false, assets: [{ uri: "file:///brief.pdf", name: "brief.pdf", mimeType: "application/pdf", size: 3, base64: "cGRm", lastModified: 1 }] } as any);
    await render(); await click("Add attachment"); await type("See the brief"); await click("Send");
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("claude", "See the brief", [{ mediaType: "application/pdf", data: "cGRm", name: "brief.pdf" }], expect.any(String));
    expect(mocks.app.api.postNote).not.toHaveBeenCalled();
    await publish("See the brief");
    expect(shown("See the brief")).toHaveLength(1);
  });

  it("adds a worktree note once and sends nothing to the agent", async () => {
    await render(); mocks.sheetChoice = "Worktree note"; await click("Add attachment"); await type("Deploying at 5"); await click("Send");
    expect(mocks.app.api.postNote).toHaveBeenCalledWith("worktree", "Deploying at 5", expect.any(String));
    expect(mocks.app.api.sendSession).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Note added.");
    expect(shown("Deploying at 5")).toEqual([expect.objectContaining({ kind: "note" })]);
  });

  it("leaves no note behind when a send fails, and a retry sends the message once", async () => {
    mocks.app.api.sendSession
      .mockRejectedValueOnce(new Error("Connection closed"))
      .mockResolvedValueOnce({ sent: false, message: "The agent is busy" });
    await render(); await type("Retry me");
    await click("Send");
    expect(container.textContent).toContain("Message not sent: Connection closed");
    await click("Send");
    expect(container.textContent).toContain("Message not sent: The agent is busy");
    expect(input().value).toBe("Retry me");
    expect(shown("Retry me")).toHaveLength(0);
    await click("Send");
    expect(container.textContent).not.toContain("Sent to the agent.");
    expect(container.textContent).not.toContain("Message not sent");
    expect(input().value).toBe("");
    // Every try of one draft goes under one id, so a Mac that already has it does not take it again (#675).
    const [first] = mocks.app.api.sendSession.mock.calls[0].slice(3);
    expect(first).toEqual(expect.any(String));
    expect(mocks.app.api.sendSession.mock.calls).toEqual([["claude", "Retry me", [], first], ["claude", "Retry me", [], first], ["claude", "Retry me", [], first]]);
    expect(mocks.app.api.postNote).not.toHaveBeenCalled();
    await publish("Retry me");
    expect(shown("Retry me")).toHaveLength(1);
  });

  it("says a send failed with the connection in plain words, keeps the draft, and and Resend holds it until connected (#670, #983)", async () => {
    const lost = new RelayOuterError(1001, "Stream end encountered", false);
    mocks.app.api.sendSession.mockRejectedValueOnce(lost);
    await render(); await type("How is it going?"); await click("Send");
    expect(container.textContent).toContain("Not sent: the connection to your computer dropped. Your message is still in the box.");
    expect(container.textContent).not.toContain("relay_outer");
    expect(input().value).toBe("How is it going?");
    expect(mocks.app.connection.reportError).toHaveBeenCalledWith("Session message failed", lost);
    mocks.app = { ...mocks.app, connectionStage: "reconnecting" }; await render();
    // Not connected, Resend holds the message, and it goes by itself once the phone is connected (#983).
    await click("Resend");
    expect(container.textContent).toContain("Sends when connected.");
    expect(mocks.app.api.sendSession).toHaveBeenCalledTimes(1);
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionEpoch: 1 }; await render();
    await act(async () => { await Promise.resolve(); });
    // Resend goes under the same id as the first try (#675).
    const [sendId] = mocks.app.api.sendSession.mock.calls[0].slice(3);
    expect(sendId).toEqual(expect.any(String));
    expect(mocks.app.api.sendSession.mock.calls).toEqual([["claude", "How is it going?", [], sendId], ["claude", "How is it going?", [], sendId]]);
    expect(container.textContent).not.toContain("Sent to the agent.");
    expect(input().value).toBe("");
    expect(() => button("Resend")).toThrow();
  });

  it("does not call a send the computer never answered 'not sent', nor offer to send it again", async () => {
    const timedOut = new Error("RPC timed out: session.send");
    mocks.app.api.sendSession.mockRejectedValueOnce(timedOut);
    await render(); await type("Run the migration"); await click("Send");
    expect(container.textContent).toContain("Not confirmed: your computer didn't answer in time, so the message may have reached the agent. Check the conversation before sending it again.");
    expect(container.textContent).not.toContain("Not sent");
    expect(container.textContent).not.toContain("RPC timed out");
    expect(() => button("Resend")).toThrow();
    expect(input().value).toBe("Run the migration");
    expect(mocks.app.connection.reportError).toHaveBeenCalledWith("Session message failed", timedOut);
  });

  it("says a worktree note the computer never answered may have been added, not that it reached the agent", async () => {
    mocks.app.api.postNote.mockRejectedValueOnce(new Error("RPC timed out: chat.post"));
    await render(); mocks.sheetChoice = "Worktree note"; await click("Add attachment"); await type("Deploying at 5"); await click("Send");
    expect(container.textContent).toContain("Not confirmed: your computer didn't answer in time, so the note may have been added. Check the notes before adding it again.");
    expect(container.textContent).not.toContain("agent. Check");
    expect(() => button("Resend")).toThrow();
    expect(input().value).toBe("Deploying at 5");
  });

  it("does not offer Resend when the relay refuses the pairing, and keeps the computer's own refusals as they are", async () => {
    mocks.app.api.sendSession
      .mockRejectedValueOnce(new RelayOuterError(4401, "", false))
      .mockResolvedValueOnce({ sent: false, message: "The agent is busy" });
    await render(); await type("Ship it"); await click("Send");
    expect(container.textContent).toContain("Not sent: this phone is no longer paired with your computer; pair it again from Machines. Your message is still in the box.");
    expect(() => button("Resend")).toThrow();
    await click("Send");
    expect(container.textContent).toContain("Message not sent: The agent is busy");
    expect(() => button("Resend")).toThrow();
  });

  it("shows a promoted note and its user message as a single row, and the note in other tabs", async () => {
    mocks.app.api.tail.mockImplementation(async (_session: string, tab: string) => ({ events: tab === "claude" ? [event("claude", "Ship it", 2)] : [event(tab, `${tab} transcript`)], hasMore: false }));
    mocks.app.api.listNotes.mockResolvedValue([note("promoted", "Ship it", at - 86_400_000, [{ tabId: "claude", seq: 2 }])]);
    await render();
    expect(mocks.listProps.data).toHaveLength(1);
    expect(shown("Ship it")).toEqual([expect.objectContaining({ kind: "turn", row: expect.objectContaining({ kind: "prompt" }) })]);
    await select("codex");
    expect(shown("Ship it")).toEqual([expect.objectContaining({ kind: "note" })]);
  });

  it("shows an existing note once after it is promoted to the agent", async () => {
    const listeners: ((message: { method: string; params?: unknown }) => void)[] = [];
    mocks.app.connection.onEvent = (listener: (typeof listeners)[number]) => { listeners.push(listener); return () => {}; };
    const existing = note("existing", "Ship it", at - 86_400_000);
    mocks.app.api.listNotes.mockResolvedValueOnce([existing]).mockResolvedValueOnce([{ ...existing, promotedTo: [{ tabId: "claude", seq: 2 }] }]);
    await render();
    expect(shown("Ship it")).toEqual([expect.objectContaining({ kind: "note" })]);
    await publish("Ship it");
    await act(async () => {
      for (const listener of listeners) listener({ method: "chat.changed", params: { worktreeId: "worktree" } });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(shown("Ship it")).toEqual([expect.objectContaining({ kind: "turn", row: expect.objectContaining({ kind: "prompt" }) })]);
  });

  it("hides the note an older phone saved just before sending it, but not one added long before", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "From an older phone")], hasMore: false });
    mocks.app.api.listNotes.mockResolvedValueOnce([note("by-hand", "From an older phone", at - 3_600_000), note("legacy", "From an older phone", at - 1_200)]);
    await render();
    expect([...shown("From an older phone")].reverse()).toEqual([
      expect.objectContaining({ kind: "note", note: expect.objectContaining({ id: "by-hand" }) }),
      expect.objectContaining({ kind: "turn", row: expect.objectContaining({ kind: "prompt" }) }),
    ]);
  });
});

describe("sending a draft again after a lost reply (#675)", () => {
  const sendIds = () => mocks.app.api.sendSession.mock.calls.map((call: unknown[]) => call[3]);
  const dropped = () => new Error("Connection closed");

  it("sends a draft again under its id, an edited one under a new id, and retires the id once sent", async () => {
    mocks.app.api.sendSession.mockRejectedValueOnce(dropped()).mockRejectedValueOnce(dropped()).mockRejectedValueOnce(dropped());
    await render(); await type("Ship it");
    await click("Send"); await click("Send");
    expect(sendIds()[0]).toEqual(expect.any(String));
    expect(sendIds()[1]).toBe(sendIds()[0]);
    // Space around the text is not sent, so it is the same message.
    await type("  Ship it "); await click("Send");
    expect(sendIds()[2]).toBe(sendIds()[0]);

    await type("Ship it now"); await click("Send");
    expect(sendIds()[3]).not.toBe(sendIds()[0]);
    expect(container.textContent).not.toContain("Sent to the agent.");
    expect(input().value).toBe("");
    // The same text sent after that is meant as a second message.
    await type("Ship it now"); await click("Send");
    expect(sendIds()[4]).not.toBe(sendIds()[3]);
  });

  it("starts a new id when an attachment is added or removed", async () => {
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({ canceled: false, assets: [{ uri: "file:///brief.pdf", name: "brief.pdf", mimeType: "application/pdf", size: 3, base64: "cGRm", lastModified: 1 }] } as any);
    mocks.app.api.sendSession.mockRejectedValueOnce(dropped()).mockRejectedValueOnce(dropped());
    await render(); await type("See the brief");
    await click("Send");
    await click("Add attachment"); await click("Send");
    await click("Remove brief.pdf"); await click("Send");
    const [plain, attached, removed] = sendIds();
    expect(attached).not.toBe(plain);
    expect(removed).not.toBe(attached);
  });

  it("posts a note again under its id, and the same text for the agent is another message", async () => {
    mocks.app.api.sendSession.mockRejectedValueOnce(dropped());
    mocks.app.api.postNote.mockRejectedValueOnce(dropped());
    await render(); await type("Deploying at 5");
    await click("Send");
    mocks.sheetChoice = "Worktree note"; await click("Add attachment"); await click("Send"); await click("Send");
    const [[, , first], [, , again]] = mocks.app.api.postNote.mock.calls;
    expect(again).toBe(first);
    expect(first).not.toBe(sendIds()[0]);
    expect(container.textContent).not.toContain("Note added.");
    expect(input().value).toBe("");
  });

  it("keeps a failed draft's id when the app is closed and opened again", async () => {
    mocks.app.api.sendSession.mockRejectedValueOnce(dropped());
    await render(); await type("Survive a restart"); await click("Send");
    expect(container.textContent).toContain("Message not sent: Connection closed");

    // Closed: only what the phone saved is left.
    await act(async () => root.unmount());
    forgetConversationState("");
    root = createRoot(container);
    await render();
    expect(input().value).toBe("Survive a restart");
    await click("Send");
    expect(sendIds()[1]).toBe(sendIds()[0]);
    expect(container.textContent).not.toContain("Sent to the agent.");
    // Sent: neither the draft nor its id waits for the next launch.
    expect([...mocks.storage.keys()].filter((key) => key.startsWith("terminalx:draft"))).toEqual([]);
  });
});

describe("mobile transcript mount budget (#385)", () => {
  it("mounts only a small part of a page with twenty long prompts", async () => {
    mocks.initialBatchOnly = true;
    mocks.app.api.tail.mockResolvedValueOnce({ events: Array.from({ length: 20 }, (_, turn) => [
      event("claude", `Prompt ${turn}`, turn * 11 + 1),
      ...Array.from({ length: 10 }, (_, reply) => ({
        ...event("claude", "", turn * 11 + reply + 2),
        payload: { type: "assistant_text", text: `${"Synthetic paragraph.\n\n".repeat(16)}reply-marker-${turn}-${reply}` },
      })),
    ]).flat(), hasMore: false });
    await render();
    expect(container.textContent).toContain("reply-marker-19-9");
    expect(container.textContent?.match(/reply-marker-/g)?.length ?? 0).toBeLessThanOrEqual(12);
    expect(container.textContent).not.toContain("Prompt 0");
  });
});

describe("mobile conversation navigation", () => {
  it("keeps the composer placeholder and draft stable while reconnecting", async () => {
    await render(); await type("Keep my draft");
    expect(input().placeholder).toBe("Message Claude Code");
    const placeholder = input().placeholder;
    for (const stage of ["reconnecting", "connected", "cant-connect", "connected"]) {
      mocks.app.connectionStage = stage;
      await render();
      expect(input().placeholder).toBe(placeholder);
      expect(input().value).toBe("Keep my draft");
      // A message can be sent whatever the connection: while it is down, it is held (#983).
      expect(button("Send").disabled).toBe(false);
      expect(container.textContent).toContain("claude transcript");
    }
  });

  it("lists each session once with its status in words, and opens its tabs in place", async () => {
    mocks.app.sessions = [{ ...mocks.app.sessions[0], issueRef: "PRO-132", manualStatus: "in_review" }];
    await render(true);
    // Named by its title, its status and tabs in words, its branch after; on a Mac that sends no row facts a waiting tab needs the person.
    const rows = () => [...container.querySelectorAll("button")].filter((item) => item.getAttribute("aria-label")?.startsWith("Create a new issue"));
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute("aria-label")).toBe("Create a new issue, Needs you, 2 tabs, branch issue-132");
    expect(rows()[0].getAttribute("aria-description")).toContain("Shows its tabs");
    // Under the pinned section, and nothing about its issue or manual status.
    expect(container.querySelector('[data-section="needs"]')?.textContent).toContain("Needs you");
    expect(container.textContent).not.toMatch(/PRO-132|Backlog|In review/);
    await act(async () => rows()[0].click());
    expect(rows()[0].getAttribute("aria-expanded")).toBe("true");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(button("Claude Code, Needs you")).toBeTruthy();
    await click("Codex, Working");
    expect(mocks.push).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({ sessionId: "worktree", tabId: "codex", hostId: mocks.params.hostId }) }));
    // The Mac says what the tab waits for: a question reads in the issue's words, and wins over the working tab.
    mocks.app.sessions = [{ ...mocks.app.sessions[0], rowStatus: { tabs: [{ status: "waiting", activity: "needs_answer" }, { status: "in_progress", activity: null }] } }];
    await render(true);
    expect(rows()[0].getAttribute("aria-label")).toContain("Needs your answer, 2 tabs");
    // A session with one tab opens it at once.
    mocks.app.sessions = [{ ...mocks.app.sessions[0], rowStatus: undefined, tabs: [{ id: "codex", harness: "codex", status: "in_progress" }] }];
    await render(true);
    expect(rows()[0].getAttribute("aria-label")).toBe("Create a new issue, Working, branch issue-132");
    await act(async () => rows()[0].click());
    expect(mocks.push).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({ tabId: "codex" }) }));
  });

  it("filters to what needs the person or what works, with counts, and keeps the choice", async () => {
    const working = { id: "busy", title: "Runtime handover", project: "TerminalX", worktree: "pro-341", branch: "pro-341-runtime", modified: "2026-11-07T10:00:00Z", tabs: [{ id: "w", harness: "claude", status: "in_progress" }] };
    mocks.app.sessions = [mocks.app.sessions[0], working];
    await render(true);
    const titles = () => [...container.querySelectorAll("button")].map((item) => item.getAttribute("aria-label") ?? "").filter((label) => /^(Create a new issue|Runtime handover),/.test(label)).map((label) => label.split(",")[0]);
    expect(titles()).toEqual(["Create a new issue", "Runtime handover"]);
    await click("Needs you, 1");
    expect(button("Needs you, 1").getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toEqual(["Create a new issue"]);
    expect(container.textContent).toContain("1 session is waiting for you.");
    await click("Working, 1");
    expect(titles()).toEqual(["Runtime handover"]);
    // Leaving the list and coming back keeps the filter while the app runs.
    await act(async () => { root.render(<div />); });
    await render(true);
    expect(button("Working, 1").getAttribute("aria-pressed")).toBe("true");
    // Search from the header narrows every count.
    await click("Search sessions");
    await type("handover");
    expect(button("All, 1")).toBeTruthy();
    expect(button("Needs you, 0")).toBeTruthy();
    await click("Close search");
    await click("All, 2");
  });

  it("switches agents, keeps drafts and transcripts separate, and sends to the selected tab", async () => {
    await render();
    expect(container.querySelector('[data-testid="screen-title"]')?.textContent).toBe("Claude Code");
    await type("Claude draft");
    await click("Open Codex"); await render();
    expect(container.querySelector('[data-testid="screen-title"]')?.textContent).toBe("Codex");
    expect(mocks.params.tabId).toBe("codex");
    expect(input().value).toBe("");
    expect(container.textContent).toContain("codex transcript");
    expect(container.textContent).not.toContain("claude transcript");
    await type("Codex draft");
    await click("Send");
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("codex", "Codex draft", [], expect.any(String));
    expect(mocks.app.api.postNote).not.toHaveBeenCalled();
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
    mocks.app.api.sendSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(); await type("Send once"); await click("Send");
    await select("codex"); await type("Other draft"); await select("claude");
    expect(button("Send").disabled).toBe(true);
    await act(async () => finish({ sent: true, queued: false }));
    expect(input().value).toBe("");
    expect(container.textContent).not.toContain("Sent to the agent.");
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
    mocks.app.api.tail.mockRejectedValueOnce(new Error("Transcript event 12 is too large to load on mobile. Open this conversation on your computer."));
    await render();
    expect(container.textContent).toContain("Open this conversation on your computer.");
    expect(container.textContent).not.toContain("No transcript yet");
    expect(container.textContent).not.toContain("Loading transcript");
    expect(button("Try again").disabled).toBe(false);
    await click("Try again");
    expect(container.textContent).toContain("claude transcript");
    expect(container.textContent).not.toContain("Open this conversation on your computer.");
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
    await click("Try again");
    expect(container.textContent).not.toContain("Connection closed");
    expect(input().value).toBe("Keep my draft");
  });

  it("says nothing but the subtitle while the connection drops during the initial load, and offers Try again only after 15 s (#983)", async () => {
    let reject!: (reason: Error) => void;
    mocks.app.api.tail.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    mocks.app.connectionEpoch = 1;
    await render();
    expect(container.textContent).toContain("Loading transcript");
    mocks.app = { ...mocks.app, connectionStage: "reconnecting" };
    await render();
    await act(async () => reject(new RelayOuterError(1001, "Stream end encountered", false)));
    // Connecting is the subtitle's to say: no card, no error, no button.
    expect(container.textContent).toContain("Connecting…");
    expect(container.textContent).not.toContain("Could not load transcript");
    expect(container.textContent).not.toContain("connection to your computer dropped");
    expect(container.textContent).not.toContain("relay_outer");
    expect(container.textContent).not.toContain("Loading transcript");
    expect(() => button("Try again")).toThrow();
    // However many attempts: until 15 s have passed without a connection, still no button.
    mocks.app = { ...mocks.app, connectionStage: "unreachable", connectionAttempt: 12 };
    await render();
    expect(() => button("Try again")).toThrow();
    expect(container.textContent).not.toContain("Waiting for Mac…");
    // 15 s on (the app's one clock), the phone says it waits for the Mac, and Try again tries now and counts afresh.
    mocks.app = { ...mocks.app, connectionWaiting: true };
    await render();
    expect(container.textContent).toContain("Waiting for Mac…");
    expect(container.textContent).toContain("Can’t reach Mac. Messages show once it connects.");
    expect(input().placeholder).toBe("Message sends when connected");
    await click("Try again");
    expect(mocks.app.retryConnection).toHaveBeenCalledTimes(1);
    expect(mocks.app.api.tail).toHaveBeenCalledTimes(1);
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionAttempt: 0, connectionWaiting: false, connectionEpoch: 2 };
    await render();
    expect(container.textContent).toContain("claude transcript");
    expect(container.textContent).not.toContain("Waiting for Mac…");
    expect(() => button("Try again")).toThrow();
  });

  it("keeps the saved transcript on screen while reconnecting, and says so in the subtitle alone (#983)", async () => {
    await render();
    expect(container.textContent).toContain("claude transcript");
    mocks.app.connectionStage = "connecting"; mocks.app.connectionEpoch = 1;
    await render();
    expect(container.textContent).toContain("claude transcript");
    expect(container.textContent).toContain("Connecting…");
    expect(container.textContent).not.toContain("Reconnecting");
    expect(() => button("Try again")).toThrow();
    mocks.app = { ...mocks.app, connectionWaiting: true };
    await render();
    expect(container.textContent).toContain("claude transcript");
    expect(container.textContent).toContain("Can’t reach Mac. Showing saved messages.");
  });

  it("says in plain words when a sync fails with the connection, and logs the code (#670)", async () => {
    const lost = new RelayOuterError(4408, "", false);
    mocks.app.api.tail.mockRejectedValueOnce(lost);
    await render();
    expect(container.textContent).toContain("Couldn’t load new messages from Mac.");
    expect(container.textContent).not.toContain("relay_outer");
    expect(mocks.app.connection.reportError).toHaveBeenCalledWith("Transcript sync failed", lost);
  });

  it("stops asking for a page that keeps dropping the connection over Relay, until Retry (#670)", async () => {
    mocks.app.api.features = async () => ({ transcript: 1 });
    mocks.app.api.syncTranscript = vi.fn().mockRejectedValue(new RelayOuterError(1001, "Stream end encountered", false));
    await render();
    // The connection drops, the phone reconnects and asks again, and it drops again.
    mocks.app = { ...mocks.app, connectionStage: "connecting" }; await render();
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionEpoch: 1 }; await render();
    mocks.app = { ...mocks.app, connectionStage: "connecting" }; await render();
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionEpoch: 2 }; await render();
    expect(mocks.app.api.syncTranscript).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("This conversation is too large to load over Relay; open it on the same Wi-Fi as your computer.");
    expect(container.textContent).not.toContain("relay_outer");
    // The next reconnect does not ask for it again, so the connection stays up for notes and sends.
    mocks.app = { ...mocks.app, connectionStage: "connecting" }; await render();
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionEpoch: 3 }; await render();
    expect(mocks.app.api.syncTranscript).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("too large to load over Relay");
    // Retry asks once more.
    mocks.app.api.syncTranscript.mockResolvedValueOnce({ events: [event("claude", "loaded at last", 10)], reset: true, cursor: { offset: 10, digest: "a".repeat(64) }, hasMore: false, hasEarlier: false });
    await click("Try again");
    expect(mocks.app.api.syncTranscript).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("loaded at last");
    expect(container.textContent).not.toContain("too large to load over Relay");
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
    mocks.app.api.syncTranscript = vi.fn().mockRejectedValueOnce(new Error("Event too large. Open this conversation on your computer."));
    await render();
    expect(container.textContent).toContain("Event too large");
    mocks.app.api.syncTranscript.mockResolvedValueOnce(page(10, true));
    await click("Try again");
    expect(container.textContent).toContain("synced 10");
    expect(container.textContent).not.toContain("Event too large");

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
  const latestText = () => mocks.listProps.data[0]?.row.text;

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
    expect(mocks.listProps.data.map((item: any) => item.row.text)).toEqual(["current", "earlier"]);
    expect(mocks.listProps.maintainVisibleContentPosition).toBe(position);
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
    expect(button("Jump to latest")).toBeTruthy();
  });

  it("retains earlier history when subscription catch-up finishes after pagination", async () => {
    vi.useFakeTimers();
    try {
      const current = Array.from({ length: 20 }, (_, i) => event("claude", `current ${100 + i}`, 100 + i));
      mocks.app.api.tail.mockResolvedValueOnce({ events: current, hasMore: true });
      await render(); await scroll(900);
      let finish!: (value: unknown) => void;
      mocks.app.api.tail.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await act(async () => { mocks.sessionReady.get("claude")?.(); await vi.advanceTimersByTimeAsync(100); });
      const earlier = Array.from({ length: 20 }, (_, i) => event("claude", `earlier ${80 + i}`, 80 + i));
      mocks.app.api.tail.mockResolvedValueOnce({ events: earlier, hasMore: true });
      await click("Load earlier");
      expect(mocks.listProps.data).toHaveLength(40);
      await act(async () => finish({ events: current, hasMore: true }));
      expect(mocks.listProps.data).toHaveLength(40);
      expect(container.textContent).toContain("earlier 80");
      expect(button("Jump to latest")).toBeTruthy();
      expect(mocks.scrollToOffset).not.toHaveBeenCalled();
      mocks.app.api.tail.mockResolvedValueOnce({ events: [event("claude", "oldest", 60)], hasMore: false });
      await click("Load earlier");
      expect(mocks.app.api.tail).toHaveBeenLastCalledWith("worktree", "claude", 80);
      expect(mocks.listProps.data).toHaveLength(41);
    } finally { vi.useRealTimers(); }
  });
});

describe("the phone's terminal view, as on the desktop", () => {
  const terminalMac = () => {
    mocks.app.api.features = async () => ({ terminal: 1 });
    mocks.app.api.openTerminal = vi.fn(async () => ({ opened: true }));
    mocks.app.api.queueInput = vi.fn(async () => ({ accepted: true }));
  };
  const show = async (packet: unknown) => { await act(async () => { mocks.terminalListeners.get("claude")!(packet); }); };
  const sent = () => mocks.app.api.queueInput.mock.calls.map(([, , text]: string[]) => text);
  const openTerminalView = async () => {
    await render();
    await click("Terminal");
    await vi.waitFor(() => expect(mocks.terminalListeners.has("claude")).toBe(true));
  };

  it("opens the tab's terminal on the computer before watching it, and draws the agent's screen", async () => {
    terminalMac();
    await openTerminalView();
    expect(mocks.app.api.openTerminal).toHaveBeenCalledWith("worktree", "claude");
    expect(mocks.app.api.openTerminal.mock.invocationCallOrder[0]).toBeLessThan(mocks.app.api.subscribeTerminal.mock.invocationCallOrder[0]);
    // The chat's transcript requests stop: only the terminal is shown.
    await show({ type: "scrollback", serialized: "\x1b[?1049h\x1b[2J\x1b[1;1H\x1b[1mCodex\x1b[0m ready\x1b[3;1H› ", cols: 40, rows: 4 });
    await vi.waitFor(() => expect(container.textContent).toContain("Codex ready"));
    expect(container.textContent).not.toContain("\x1b[");
    await show({ type: "resized", cols: 60, rows: 6 });
    await show({ type: "data", chunk: "\x1b[2J\x1b[1;1Hredrawn at 60 columns" });
    await vi.waitFor(() => expect(container.textContent).toContain("redrawn at 60 columns"));
    expect(container.textContent).not.toContain("Codex ready");
  });

  it("types keys as the desktop terminal sends them, in the program's modes", async () => {
    terminalMac();
    await openTerminalView();
    await show({ type: "scrollback", serialized: "$ ", cols: 40, rows: 4 });
    await vi.waitFor(() => expect(button("Escape").disabled).toBe(false));
    await type("l");
    await click("Escape");
    await click("Up");
    await click("Control"); await type("c");
    // A full-screen program turns on application cursor keys and bracketed paste.
    await show({ type: "data", chunk: "\x1b[?1h\x1b[?2004h" });
    await vi.waitFor(async () => { await click("Up"); expect(sent().at(-1)).toBe("\x1bOA"); });
    // Sent whole as a paste (line breaks to Enter is `pasteSequence`'s, in keys.test.ts).
    await click("Buffered");
    await type("git status");
    await click("Send terminal input");
    expect(sent().slice(0, 4)).toEqual(["l", "\x1b", "\x1b[A", "\x03"]);
    // Written first, it goes whole, and Enter with it.
    expect(sent().at(-1)).toBe("\x1b[200~git status\x1b[201~\r");
  });

  it("says why the terminal cannot open, and opens it again on request", async () => {
    terminalMac();
    mocks.app.api.openTerminal.mockResolvedValueOnce({ opened: false, message: "Wait for Codex to finish this turn, or interrupt it, before opening its terminal." });
    await render();
    await click("Terminal");
    await vi.waitFor(() => expect(container.textContent).toContain("Wait for Codex to finish this turn"));
    expect(mocks.app.api.subscribeTerminal).not.toHaveBeenCalled();
    expect(button("Escape").disabled).toBe(true);
    let finish!: (value: { opened: boolean }) => void;
    mocks.app.api.openTerminal.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click("Try again");
    expect(container.textContent).toContain("Opening…");
    expect(container.textContent).not.toContain("Wait for Codex to finish this turn");
    await act(async () => finish({ opened: true }));
    await vi.waitFor(() => expect(mocks.terminalListeners.has("claude")).toBe(true));
    expect(mocks.app.api.openTerminal).toHaveBeenCalledTimes(2);
  });

  it("shows the computer's reason when typing is refused, and keeps the keys for another try", async () => {
    terminalMac();
    mocks.app.api.queueInput.mockResolvedValueOnce({ accepted: false, message: "Another mobile client or terminal instance owns this driver lease." });
    await openTerminalView();
    await show({ type: "scrollback", serialized: "$ ", cols: 40, rows: 4 });
    await vi.waitFor(() => expect(button("Escape").disabled).toBe(false));
    await click("Escape");
    expect(container.textContent).toContain("owns this driver lease");
    await click("Tab");
    expect(sent()).toEqual(["\x1b", "\t"]);
    expect(container.textContent).not.toContain("owns this driver lease");
  });

  it("releases the tab's driver lease when the view goes away", async () => {
    terminalMac();
    await openTerminalView();
    await click("Chat");
    expect(mocks.app.api.releaseInput).toHaveBeenCalledWith("worktree", "claude");
    expect(mocks.terminalListeners.has("claude")).toBe(false);
  });

  // #730: a Mac whose runtime is older than its app names no terminal until the runtime is replaced.
  it("offers the Terminal view as soon as the computer's runtime serves it, without reconnecting", async () => {
    terminalMac();
    mocks.app.api.features = async () => ({});
    await render();
    const labels = () => [...container.querySelectorAll("button")].map((item) => item.getAttribute("aria-label") ?? item.textContent);
    expect(labels()).not.toContain("Terminal");
    mocks.app.api.features = async () => ({ terminal: 1 });
    await act(async () => { for (const listener of mocks.featureListeners) listener(); });
    await vi.waitFor(() => expect(labels()).toContain("Terminal"));
    await click("Terminal");
    await vi.waitFor(() => expect(mocks.terminalListeners.has("claude")).toBe(true));
    // And it goes again with a runtime that does not serve it: the chat is shown.
    mocks.app.api.features = async () => ({});
    await act(async () => { for (const listener of mocks.featureListeners) listener(); });
    await vi.waitFor(() => expect(labels()).not.toContain("Terminal"));
    await vi.waitFor(() => expect(container.textContent).toContain("claude transcript"));
    expect(mocks.terminalListeners.has("claude")).toBe(false);
  });

  it("says the computer needs updating when it refuses to open the terminal, and the chat keeps working", async () => {
    terminalMac();
    // As the transport reads a runtime's refusal of an operation it does not know (`refusal.ts`).
    mocks.app.api.openTerminal.mockResolvedValue({ opened: false, message: "TerminalX on your computer needs updating or restarting to do this." });
    await render();
    await click("Terminal");
    await vi.waitFor(() => expect(container.textContent).toContain("The terminal isn't available"));
    expect(container.textContent).toContain("TerminalX on your computer needs updating or restarting to do this.");
    expect(container.textContent).not.toContain("Unsupported paired-device owner operation");
    await click("Chat");
    await vi.waitFor(() => expect(container.textContent).toContain("claude transcript"));
    await type("still here");
    await click("Send");
    await vi.waitFor(() => expect(mocks.app.api.sendSession).toHaveBeenCalled());
  });
});

describe("a compaction on the paired Mac, as the desktop shows it (#644)", () => {
  const scope = { sessionId: "worktree", tabId: "claude", conversationId: null, provider: "claude", threadId: "thread", subagentId: null };
  const lifecycle = (seq: number, evidence: Record<string, unknown>) => ({ ...event("claude", "", seq), payload: { type: "context_compaction_lifecycle", persisted: true, confirmedStart: true, evidence: { scope, generation: 1, ...evidence } } });
  const started = [event("claude", "/compact"), lifecycle(2, { type: "connection_opened" }), lifecycle(3, { type: "item_started", turnId: "turn", itemId: "item" })];

  it("shows it running only once the conversation caught up with the computer's, and its status unknown before that and while disconnected", async () => {
    vi.useFakeTimers();
    try {
      mocks.app.api.tail.mockResolvedValue({ events: started, hasMore: false });
      await render();
      // Read, but before the Mac confirmed the subscription: its end may have gone unheard.
      expect(container.textContent).toContain("Compaction status unknown");
      expect(container.textContent).not.toContain("Compacting context…");
      expect(container.textContent).not.toContain("Context compacted");
      await act(async () => { mocks.sessionReady.get("claude")?.(); await vi.advanceTimersByTimeAsync(100); });
      expect(container.textContent).toContain("Compacting context…");
      expect(container.textContent).not.toContain("Compaction status unknown");
      // The connection drops: what is shown is what was last seen.
      mocks.app.connectionStage = "reconnecting";
      await render();
      expect(container.textContent).toContain("Compaction status unknown");
      expect(container.textContent).not.toContain("Compacting context…");
    } finally { vi.useRealTimers(); }
  });

  it("says compacted once it ended", async () => {
    mocks.app.api.tail.mockResolvedValue({ events: [...started, lifecycle(4, { type: "item_completed", turnId: "turn", itemId: "item" })], hasMore: false });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Context compacted"));
    expect(container.textContent).not.toContain("Compacting context…");
  });
});

// #979: an agent's question is answered from the phone, as on the desktop.
describe("an agent's question on the phone (#979)", () => {
  const questions = [
    { question: "Which checks should run?", multiSelect: true, freeText: false, options: [{ label: "Lint, format", description: "Both" }, { label: "Tests", description: "Unit tests only" }] },
    { question: "Which branch?", multiSelect: false, freeText: true, options: [{ label: "main" }, { label: "next" }] },
  ];
  const question = { ...event("claude", "", 2), payload: { type: "questions_asked", requestId: "q1", toolUseId: "", questions } };
  const permission = { ...event("claude", "", 3), payload: { type: "permission_requested", requestId: "p1", toolUseId: "tool", toolName: "shell", input: {}, options: [{ id: "allow", label: "Allow", kind: "allow_once" }] } };
  const decided = (requestId: string, seq: number) => ({ ...event("claude", "", seq), payload: { type: "permission_decided", requestId, allowed: true, label: "Answered", automatic: false } });
  const asks = (...events: unknown[]) => mocks.app.api.tail.mockImplementation(async (_session: string, tab: string) => ({ events: tab === "claude" ? [event(tab, "Ship it"), ...events] : [event(tab, `${tab} transcript`)], hasMore: false }));
  const text = () => container.textContent ?? "";
  const takesAnswers = () => { mocks.app.api.features = async () => ({ questions: 1 }); };

  it("shows the question with every option, and sends the answer the desktop's card would send", async () => {
    takesAnswers();
    asks(question);
    await render();
    for (const shown of ["2 questions", "Which checks should run?", "Lint, format", "Both", "Tests", "Unit tests only", "Choose any that apply", "Which branch?", "main", "next"]) expect(text()).toContain(shown);
    expect(text()).not.toContain("Permission");
    expect(text()).not.toContain("from your computer");

    await click("Tests. Unit tests only"); await click("Lint, format. Both"); await click("main"); await click("next");
    await click("Answer");
    expect(mocks.app.api.answerQuestions).toHaveBeenCalledTimes(1);
    expect(mocks.app.api.answerQuestions).toHaveBeenCalledWith("worktree", "claude", "q1", { "Which checks should run?": "Tests, Lint, format", "Which branch?": "next" });
    // The card stays until the Mac says the question is answered, then goes without a refresh.
    expect(text()).toContain("Which branch?");
    await act(async () => mocks.sessionListeners.get("claude")!(decided("q1", 3)));
    expect(text()).not.toContain("Which branch?");
    expect(() => button("Answer")).toThrow();
  });

  it("skips with an empty answer set, and goes away when the computer answers first", async () => {
    takesAnswers();
    asks(question);
    await render();
    await click("Skip");
    expect(mocks.app.api.answerQuestions).toHaveBeenCalledWith("worktree", "claude", "q1", {});

    // Answered on the Mac: the decision event alone removes the card.
    await act(async () => mocks.sessionListeners.get("claude")!(decided("q1", 3)));
    expect(text()).not.toContain("Which checks should run?");
  });

  it("sends one answer for a double tap, and says the computer's message when the answer came too late", async () => {
    takesAnswers();
    asks(question);
    let settle!: (result: { answered: false; message: string }) => void;
    mocks.app.api.answerQuestions.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    await render();
    await click("main");
    await act(async () => { button("Answer").click(); button("Answer").click(); button("Skip").click(); });
    expect(mocks.app.api.answerQuestions).toHaveBeenCalledTimes(1);
    expect([button("Answer").disabled, button("Skip").disabled]).toEqual([true, true]);

    await act(async () => settle({ answered: false, message: "internal: that question is no longer open" }));
    expect(text()).toContain("That question is no longer open.");
    expect(button("Answer").disabled).toBe(false);
  });

  it("gives a question and a permission request a card each, answered separately", async () => {
    takesAnswers();
    asks(question, permission);
    await render();
    expect(text()).toContain("Which branch?");
    await click("Allow");
    expect(mocks.app.api.respondPermission).toHaveBeenCalledWith("worktree", "claude", "p1", "allow");
    expect(mocks.app.api.answerQuestions).not.toHaveBeenCalled();
    await click("next"); await click("Answer");
    expect(mocks.app.api.answerQuestions).toHaveBeenCalledWith("worktree", "claude", "q1", { "Which branch?": "next" });
  });

  it("shows the question read-only with a Mac that takes no answer from a phone", async () => {
    // An older Mac: `sync.capabilities` does not name `questions`.
    asks(question);
    await render();
    for (const shown of ["2 questions", "Which checks should run?", "Lint, format", "Unit tests only", "Which branch?", "next"]) expect(text()).toContain(shown);
    expect(text()).toContain("Answer this question from your computer.");
    expect(text()).not.toContain("Permission");
    // No button that would fail.
    expect(() => button("Answer")).toThrow();
    expect(() => button("Skip")).toThrow();
    expect(button("Tests. Unit tests only").disabled).toBe(true);
    expect(mocks.app.api.answerQuestions).not.toHaveBeenCalled();
  });

  it("keeps the options readable and selectable while disconnected, and what was chosen across tabs", async () => {
    takesAnswers();
    asks(question);
    await render();
    await click("Tests. Unit tests only");
    mocks.app.connectionStage = "reconnecting";
    await render();
    expect(text()).toContain("Reconnect before answering.");
    expect([button("Answer").disabled, button("Skip").disabled]).toEqual([true, true]);
    await click("next");

    // Another tab and back, then connected again: the choices are still there.
    await select("codex");
    expect(text()).not.toContain("Which branch?");
    mocks.app.connectionStage = "connected";
    await select("claude");
    await click("Answer");
    expect(mocks.app.api.answerQuestions).toHaveBeenCalledWith("worktree", "claude", "q1", { "Which checks should run?": "Tests", "Which branch?": "next" });
  });
});

describe("the session screen's status line, keyboard and send feedback (#985)", () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const at = (seq: number, ts: string, payload: unknown) => ({ id: `claude-${seq}`, sessionId: "worktree", tabId: "claude", harness: "claude", seq, ts, payload });
  const publish = async (...events: unknown[]) => { for (const next of events) await act(async () => mocks.sessionListeners.get("claude")!(next)); };
  const text = () => container.textContent ?? "";
  const question = (seq: number, ts: string) => at(seq, ts, { type: "questions_asked", requestId: "q1", toolUseId: "", questions: [{ question: "Merge now, or wait for the macOS job?", multiSelect: false, freeText: false, options: [{ label: "Merge now" }, { label: "Wait for it" }] }] });
  const permission = (seq: number, ts: string) => at(seq, ts, { type: "permission_requested", requestId: "p1", toolUseId: "tool", toolName: "shell", input: {}, options: [{ id: "allow", label: "Allow", kind: "allow_once" }] });
  const working = () => [at(1, ago(3), { type: "user_message", text: "What's the latest status?", queued: false }), at(2, ago(3), { type: "turn_started" })];
  /** A Mac that takes session controls from the phone, with this tab running a turn. */
  const takesControls = () => {
    mocks.app.api.features = async () => ({ sessionControls: 1, questions: 1 });
    mocks.app.api.tabControls = vi.fn(async () => ({ harness: "claude", model: "opus", effort: "high", permissionMode: "default", status: "in_progress" }));
    mocks.app.api.models = vi.fn(async () => []);
    mocks.app.api.interrupt = vi.fn(async () => ({ done: true }));
    mocks.app.api.stop = vi.fn(async () => ({ done: true }));
  };

  it("goes from Working to Needs your answer under the question card, then to Done when the turn ends", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: working(), hasMore: false });
    await render();
    expect(text()).toContain("Working · 3 min");
    await publish(question(3, ago(1)));
    expect(text()).not.toContain("Working ·");
    expect(text()).toContain("Needs your answer · 1 min");
    // Drawn under the card it is about.
    expect(text().indexOf("Needs your answer")).toBeGreaterThan(text().indexOf("Merge now, or wait for the macOS job?"));
    await publish(at(4, ago(0), { type: "permission_decided", requestId: "q1", allowed: true, label: "Merge now", automatic: false }));
    expect(text()).toContain("Working · 3 min");
    const end = ago(0);
    await publish(at(5, end, { type: "turn_completed", status: "ok", authFailed: false, finalText: "Merged." }));
    expect(text()).not.toContain("Working ·");
    expect(text()).toContain(`Done · ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(end))}`);
  });

  it("goes straight from Working to Done", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: working(), hasMore: false });
    await render();
    expect(text()).toContain("Working · 3 min");
    await publish(at(3, ago(0), { type: "turn_completed", status: "ok", authFailed: false }));
    expect(text()).toContain("Done · ");
    expect(text()).not.toContain("Working");
  });

  it("says Needs approval under a permission card, and Stopped or Failed with the reason when a turn ends that way", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: [...working(), permission(3, ago(2))], hasMore: false });
    await render();
    expect(text()).toContain("Needs approval · 2 min");
    expect(text().indexOf("Needs approval")).toBeGreaterThan(text().indexOf("shell"));
    await publish(at(4, ago(0), { type: "permission_decided", requestId: "p1", allowed: false, label: "Deny", automatic: false }), at(5, ago(0), { type: "recovery", kind: "timeout" }), at(6, ago(0), { type: "turn_completed", status: "aborted", authFailed: false }));
    expect(text()).toContain("Stopped · timed out");
    await publish(at(7, ago(0), { type: "user_message", text: "Try again", queued: false }), at(8, ago(0), { type: "turn_completed", status: "error", authFailed: false, finalText: "API Error: 529 overloaded" }));
    expect(text()).toContain("Failed · API Error: 529 overloaded");
  });

  it("stops the turn from the line's Stop with the composer's own interrupt", async () => {
    takesControls();
    mocks.app.api.tail.mockResolvedValueOnce({ events: working(), hasMore: false });
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(text()).toContain("Working · 3 min");
    await click("Stop");
    expect(mocks.app.api.interrupt).toHaveBeenCalledWith("worktree", "claude");
    expect(mocks.app.api.stop).not.toHaveBeenCalled();
  });

  it("keeps Send in the composer while the agent works; Stop on the line, held, stops the session after asking (22.03)", async () => {
    takesControls();
    mocks.alert.mockReset();
    mocks.app.api.tail.mockResolvedValueOnce({ events: working(), hasMore: false });
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(text()).toContain("Working · 3 min");
    expect(() => button("Interrupt")).toThrow();
    expect(button("Send").disabled).toBe(true);
    await act(async () => { button("Stop").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    const [title, , choices] = mocks.alert.mock.calls[0] as [string, string, { text: string; onPress?: () => void }[]];
    expect(title).toBe("Stop this session?");
    expect(mocks.app.api.stop).not.toHaveBeenCalled();
    await act(async () => { choices.find((choice) => choice.text === "Stop")!.onPress!(); });
    expect(mocks.app.api.stop).toHaveBeenCalledWith("worktree", "claude");
    expect(mocks.app.api.interrupt).not.toHaveBeenCalled();
  });

  it("keeps Stop, and its long press, while a question the phone cannot answer and a permission request are open", async () => {
    takesControls();
    // This Mac takes controls but no answers from the phone, and reports the tab as waiting on the reader, not in progress.
    mocks.app.api.features = async () => ({ sessionControls: 1 });
    mocks.app.api.tabControls = vi.fn(async () => ({ harness: "claude", model: "opus", effort: "high", permissionMode: "default", status: "waiting" }));
    mocks.alert.mockReset();
    mocks.app.api.tail.mockResolvedValueOnce({ events: [...working(), question(3, ago(1))], hasMore: false });
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(text()).toContain("Answer this question from your computer.");
    expect(text()).toContain("Needs your answer · 1 min");
    await click("Stop");
    expect(mocks.app.api.interrupt).toHaveBeenCalledWith("worktree", "claude");
    await act(async () => { button("Stop").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const [title, , choices] = mocks.alert.mock.calls[0] as [string, string, { text: string; onPress?: () => void }[]];
    expect(title).toBe("Stop this session?");
    await act(async () => { choices.find((choice) => choice.text === "Stop")!.onPress!(); });
    expect(mocks.app.api.stop).toHaveBeenCalledWith("worktree", "claude");

    await publish(at(4, ago(0), { type: "permission_decided", requestId: "q1", allowed: true, label: "Merge now", automatic: false }), permission(5, ago(0)));
    expect(text()).toContain("Needs approval");
    await click("Stop");
    expect(mocks.app.api.interrupt).toHaveBeenCalledTimes(2);
  });

  it("gives the composer's model, effort and permission mark 44 pt places to tap, which the strip they scroll in does not clip", async () => {
    takesControls();
    mocks.app.api.models = vi.fn(async () => [{ id: "opus", label: "Opus", harness: "claude", efforts: ["low", "medium", "high"], defaultEffort: "high", acceptsImages: true, isDefault: true, upgrade: null, description: null }]);
    mocks.app.api.tail.mockResolvedValueOnce({ events: working(), hasMore: false });
    await render();
    await act(async () => { await Promise.resolve(); });
    // The composer's strip: the last horizontal one, after the chat tabs.
    const strip = JSON.parse([...container.querySelectorAll("[data-strip]")].at(-1)!.getAttribute("data-strip")!);
    // The composer's row is 32 pt; the strip reaches 6 pt past it on each side, so its frame is 44 pt and nothing moves.
    expect(32 - 2 * strip.frame.marginVertical).toBeGreaterThanOrEqual(44);
    expect(strip.content.minHeight).toBeGreaterThanOrEqual(44);
    const slop = (label: string | RegExp) => {
      const found = [...container.querySelectorAll("button")].find((item) => typeof label === "string" ? item.getAttribute("aria-label") === label : label.test(item.getAttribute("aria-label") ?? ""))!;
      return JSON.parse(found.getAttribute("data-hitslop")!) as { top: number; bottom: number; left: number; right: number };
    };
    // Drawn sizes: a 14 pt line of text is 17 pt tall, and the mark is an 18 pt icon; "High" is about 29 pt wide.
    for (const [label, tall] of [["Opus", 17], ["High", 17], [/^Permission mode/, 18]] as const) {
      const { top, bottom } = slop(label);
      expect(tall + top + bottom, String(label)).toBeGreaterThanOrEqual(43);
      // Never past the strip's frame, where the ScrollView would cut it.
      expect(top, String(label)).toBeLessThanOrEqual((44 - tall) / 2 + 0.5);
    }
    const effort = slop("High");
    const mode = slop(/^Permission mode/);
    expect(29 + effort.left + effort.right).toBeGreaterThanOrEqual(42);
    expect(18 + mode.left + mode.right).toBeGreaterThanOrEqual(44);
    // Neighbours split their gaps (5 pt and 12 pt) instead of overlapping.
    expect(slop("Opus").right + effort.left).toBeLessThanOrEqual(5);
    expect(effort.right + mode.left).toBeLessThanOrEqual(12);
    expect(mode.right).toBeLessThanOrEqual(strip.content.paddingRight);
  });

  it("drops the status line while not connected; the composer keeps its buttons (22.01)", async () => {
    takesControls();
    mocks.app.api.tail.mockResolvedValueOnce({ events: working(), hasMore: false });
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(text()).toContain("Working · 3 min");
    mocks.app = { ...mocks.app, connectionStage: "reconnecting" };
    await render();
    expect(text()).not.toContain("Working");
    expect(() => button("Stop")).toThrow();
    expect(button("Send")).toBeDefined();
    expect(button("Add attachment")).toBeDefined();
  });

  it("offers no Stop to a Mac that takes no controls from the phone", async () => {
    mocks.app.api.tail.mockResolvedValueOnce({ events: working(), hasMore: false });
    await render();
    expect(text()).toContain("Working · 3 min");
    expect(() => button("Stop")).toThrow();
  });

  it("never says a message was sent, and a failed send's line does not outlive the screen", async () => {
    await render(); await type("Ship it"); await click("Send");
    expect(mocks.app.api.sendSession).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("");
    for (const said of ["Sent to the agent.", "Queued for the agent."]) expect(text()).not.toContain(said);
    mocks.app.api.sendSession.mockRejectedValueOnce(new RelayOuterError(1001, "Stream end encountered", false));
    await type("Ship it again"); await click("Send");
    expect(text()).toContain("Not sent: the connection to your computer dropped. Your message is still in the box.");
    expect(button("Resend").disabled).toBe(false);

    // Left and opened again, with the conversation state this app keeps between visits.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(input().value).toBe("Ship it again");
    expect(text()).not.toContain("Not sent");
    expect(() => button("Resend")).toThrow();
    // Another tab and back is leaving the screen too.
    await type("Ship it again"); mocks.app.api.sendSession.mockRejectedValueOnce(new Error("Connection closed")); await click("Send");
    expect(text()).toContain("Message not sent: Connection closed");
    await select("codex"); await select("claude");
    expect(text()).not.toContain("Message not sent");
  });

  it("opens an existing session with the keyboard closed and the composer not focused, until it is tapped", async () => {
    await render();
    expect(mocks.keyboardDismissed).toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input());
    expect(input().autofocus).toBe(false);
    await act(async () => { input().focus(); });
    expect(document.activeElement).toBe(input());
  });
});

describe("one quiet connection state in a session (#983)", () => {
  const errorWords = ["Could not", "Couldn’t", "Can’t reach", "dropped", "isn't reachable", "Reconnecting", "Retry", "Try again", "Host is disconnected", "relay_outer"];
  const quiet = () => {
    for (const words of errorWords) expect(container.textContent, words).not.toContain(words);
  };

  it("opens on a cold start with a reachable Mac without any error or button, saved messages first", async () => {
    mocks.storage.set(`terminalx:transcript:${mocks.params.hostId}:worktree:claude`, JSON.stringify([event("claude", "saved on this phone")]));
    mocks.app = { ...mocks.app, connectionStage: "idle", connectionEpoch: 0 };
    await render();
    quiet();
    expect(container.textContent).toContain("Connecting…");
    mocks.app = { ...mocks.app, connectionStage: "connecting" };
    await render();
    await act(async () => { await Promise.resolve(); });
    quiet();
    expect(container.textContent).toContain("saved on this phone");
    expect(container.textContent).toContain("Connecting…");
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionEpoch: 1, updating: true };
    await render();
    quiet();
    expect(container.textContent).toContain("Updating…");
    mocks.app = { ...mocks.app, updating: false };
    await render();
    await act(async () => { await Promise.resolve(); });
    quiet();
    expect(container.textContent).toContain("claude transcript");
    // Connected is the absence of a message: the subtitle is the project again.
    expect(container.textContent).not.toContain("Connecting…");
    expect(container.textContent).not.toContain("Connected");
    expect(container.textContent).toContain("TerminalX");
  });

  it("says Catching up only while the transcript is read, through the app's one state", async () => {
    const ends: ReturnType<typeof vi.fn>[] = [];
    mocks.app.beginUpdate = vi.fn(() => { const end = vi.fn(); ends.push(end); return end; });
    let resolve!: (value: unknown) => void;
    mocks.app.api.tail.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    expect(mocks.app.beginUpdate).toHaveBeenCalledTimes(1);
    expect(ends[0]).not.toHaveBeenCalled();
    await act(async () => resolve({ events: [event("claude", "caught up")], hasMore: false }));
    expect(ends[0]).toHaveBeenCalledTimes(1);
  });

  it("holds a message typed while connecting and sends it once on connect, never twice", async () => {
    mocks.app = { ...mocks.app, connectionStage: "connecting" };
    await render();
    expect(input().placeholder).toBe("Message Claude Code");
    await type("Send this when you can");
    expect(button("Send").disabled).toBe(false);
    await click("Send");
    expect(mocks.app.api.sendSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Sends when connected.");
    expect(input().value).toBe("Send this when you can");
    // A second tap while held does nothing more.
    expect(button("Send").disabled).toBe(true);
    // 15 s on, the box says a message waits for the connection.
    mocks.app = { ...mocks.app, connectionWaiting: true };
    await render();
    expect(input().placeholder).toBe("Message sends when connected");
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionWaiting: false, connectionEpoch: 1 };
    await render();
    await act(async () => { await Promise.resolve(); });
    // Connections that come and go after it was sent do not send it again.
    for (const stage of ["reconnecting", "connected", "connecting", "connected"]) {
      mocks.app = { ...mocks.app, connectionStage: stage, connectionEpoch: mocks.app.connectionEpoch + 1 };
      await render();
      await act(async () => { await Promise.resolve(); });
    }
    expect(mocks.app.api.sendSession).toHaveBeenCalledTimes(1);
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("claude", "Send this when you can", [], expect.any(String));
    expect(input().value).toBe("");
    // Gone from the box, and nothing says it was sent (#985): the message is in the transcript.
    for (const said of ["Sent to the agent.", "Sends when connected."]) expect(container.textContent).not.toContain(said);
  });

  it("sends a held message on connect after the chat was left, once, and not again on the next open", async () => {
    mocks.app = { ...mocks.app, connectionStage: "connecting" };
    await render();
    await type("Send this after I leave"); await click("Send");
    expect(container.textContent).toContain("Sends when connected.");
    // Left before the phone connects.
    await act(async () => root.unmount());
    root = createRoot(container);
    // The app connects (the provider sends what is held for this Mac).
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionEpoch: 1 };
    await act(async () => { sendHeldMessages(mocks.params.hostId); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.app.api.sendSession).toHaveBeenCalledTimes(1);
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("claude", "Send this after I leave", [], expect.any(String));
    // Opened again: it was sent, and is not sent a second time.
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(mocks.app.api.sendSession).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("");
    // Gone from the box, and nothing says it was sent (#985): the message is in the transcript.
    for (const said of ["Sent to the agent.", "Sends when connected."]) expect(container.textContent).not.toContain(said);
  });

  it("forgets a held message with the computer or the person signing out: never sent later", async () => {
    mocks.app = { ...mocks.app, connectionStage: "connecting" };
    await render();
    await type("Not for later"); await click("Send");
    await act(async () => root.unmount());
    root = createRoot(container);
    forgetConversationState("");
    await act(async () => { sendHeldMessages(mocks.params.hostId); await Promise.resolve(); });
    expect(mocks.app.api.sendSession).not.toHaveBeenCalled();
  });

  it("takes a held message back when it is edited", async () => {
    mocks.app = { ...mocks.app, connectionStage: "connecting" };
    await render();
    await type("First thought"); await click("Send");
    await type("Second thought");
    expect(container.textContent).not.toContain("Sends when connected.");
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionEpoch: 1 };
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(mocks.app.api.sendSession).not.toHaveBeenCalled();
    expect(input().value).toBe("Second thought");
  });

  it("never shows a transport message, whatever failed", async () => {
    mocks.app.api.tail.mockRejectedValueOnce(new Error("Host is disconnected"));
    mocks.app.api.sendSession.mockRejectedValueOnce(new Error("Relay connection closed"));
    await render();
    expect(container.textContent).not.toContain("Host is disconnected");
    expect(container.textContent).toContain("Couldn’t load new messages from Mac.");
    await type("Hello"); await click("Send");
    expect(container.textContent).not.toContain("Relay connection closed");
    expect(container.textContent).toContain("Not sent: the connection to your computer dropped.");
  });

  it("keeps the tab strip's + and × in place while the connection changes, dimmed and unusable", async () => {
    mocks.app.api.features = async () => ({ sessionControls: 1, closeTab: 1 });
    mocks.app.api.models = vi.fn(async () => []);
    mocks.app.api.tabControls = vi.fn(async () => null);
    await render();
    await act(async () => { await Promise.resolve(); });
    const strip = () => ["New chat in this branch", "Close Claude Code"].map((label) => button(label).disabled);
    expect(strip()).toEqual([false, false]);
    for (const stage of ["reconnecting", "connecting", "cant-connect"]) {
      mocks.app = { ...mocks.app, connectionStage: stage };
      await render();
      expect(strip()).toEqual([true, true]);
    }
    mocks.app = { ...mocks.app, connectionStage: "connected", connectionEpoch: 1 };
    await render();
    expect(strip()).toEqual([false, false]);
  });
});
