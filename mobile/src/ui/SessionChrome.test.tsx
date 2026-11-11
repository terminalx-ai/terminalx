// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTabs, NewChatSheet, SessionHeader } from "./SessionChrome";
import { shortProject } from "./ChatListRow";

const mocks = vi.hoisted(() => ({ app: {} as any }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("./theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("./glass", () => ({ GlassIconButton: ({ label, onPress }: any) => <button aria-label={label} onClick={onPress} /> }));
vi.mock("./primitives", () => ({ Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button> }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box, Text: Box, ScrollView: Box, KeyboardAvoidingView: Box, Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Modal: ({ visible, children }: any) => visible ? <div role="dialog">{children}</div> : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: any) => <button disabled={disabled} aria-label={accessibilityLabel} aria-selected={accessibilityState?.selected} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    TextInput: ({ value, onChangeText, accessibilityLabel }: any) => <input aria-label={accessibilityLabel} value={value} onInput={(event) => onChangeText(event.currentTarget.value)} />,
  };
});

let root: Root;
let container: HTMLDivElement;
const session = { id: "s", title: "Widget", project: "Easy Widget", worktree: "develop-widget", modified: "x", tabs: [
  { id: "a", harness: "claude", title: "Functionality", status: "in_progress" as const },
  { id: "b", harness: "codex", title: "Generate butterfly", status: "idle" as const },
] };
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label) as HTMLButtonElement | undefined;
const render = (node: ReactNode) => act(async () => { root.render(node); });

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.app = {
    refreshSessions: vi.fn(async () => undefined),
    api: {
      tabControls: vi.fn(async () => ({ harness: "claude", model: "opus", effort: "high", permissionMode: "plan" })),
      models: vi.fn(async () => [{ id: "opus", harness: "claude" }, { id: "gpt-5", harness: "codex" }]),
      continueInNewTab: vi.fn(async () => ({ started: true, tabId: "c", delivered: true, inInput: false })),
    },
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("the branch's chats as tabs", () => {
  it("names each chat, marks the open one, and opens another", async () => {
    const onSelect = vi.fn();
    await render(<ChatTabs session={session} selectedTabId="a" onSelect={onSelect} />);
    expect(button("Functionality, open")?.getAttribute("aria-selected")).toBe("true");
    await act(async () => button("Open Generate butterfly")!.click());
    expect(onSelect).toHaveBeenCalledWith("b");
    // No + where the Mac takes no new chats from the phone.
    expect(button("New chat in this branch")).toBeUndefined();
  });

  it("offers + for another chat in the branch", async () => {
    const onAdd = vi.fn();
    await render(<ChatTabs session={session} selectedTabId="a" onSelect={vi.fn()} onAdd={onAdd} />);
    await act(async () => button("New chat in this branch")!.click());
    expect(onAdd).toHaveBeenCalled();
  });
});

describe("closing a chat", () => {
  it("closes from the open tab's ×, never the last chat", async () => {
    const onClose = vi.fn();
    await render(<ChatTabs session={session} selectedTabId="a" onSelect={vi.fn()} onClose={onClose} />);
    expect(button("Close Generate butterfly")).toBeUndefined();
    await act(async () => button("Close Functionality")!.click());
    expect(onClose).toHaveBeenCalledWith("a");
    await render(<ChatTabs session={{ ...session, tabs: [session.tabs[0]] }} selectedTabId="a" onSelect={vi.fn()} onClose={onClose} />);
    expect(button("Close Functionality")).toBeUndefined();
  });
});

describe("the session's bar", () => {
  it("has one button to the other view: Terminal from the chat, Chat from the terminal", async () => {
    const onView = vi.fn();
    await render(<SessionHeader title="develop-widget" subtitle="Easy Widget" onBack={vi.fn()} view="chat" onView={onView} />);
    expect(button("Chat")).toBeUndefined();
    await act(async () => button("Terminal")!.click());
    expect(onView).toHaveBeenLastCalledWith("terminal");
    await render(<SessionHeader title="develop-widget" onBack={vi.fn()} view="terminal" onView={onView} />);
    await act(async () => button("Chat")!.click());
    expect(onView).toHaveBeenLastCalledWith("chat");
    // No terminal on this Mac: no switch.
    await render(<SessionHeader title="develop-widget" onBack={vi.fn()} onView={onView} />);
    expect(button("Chat") ?? button("Terminal")).toBeUndefined();
  });

  it("shortens a project to lead a row's title without crowding its branch", () => {
    expect(shortProject("terminalx")).toBe("terminalx");
    expect(shortProject("opengateway-web")).toBe("opengatew…");
    expect(shortProject("Latent-mac-app")).toBe("Latent-ma…");
  });
});

describe("a new chat in the branch", () => {
  const type = (value: string) => act(async () => {
    const field = container.querySelector("input[aria-label='First message']") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("starts with this tab's settings for the same agent, then opens it", async () => {
    const onStarted = vi.fn();
    await render(<NewChatSheet visible sessionId="s" tabId="a" onClose={vi.fn()} onStarted={onStarted} />);
    expect(button("Start chat")!.disabled).toBe(true);
    await type("Polish the widget's empty state");
    await act(async () => button("Start chat")!.click());
    expect(mocks.app.api.continueInNewTab).toHaveBeenCalledWith("s", "a", { harness: "claude", model: "opus", effort: "high", permissionMode: "plan" }, "Polish the widget's empty state");
    expect(mocks.app.refreshSessions).toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledWith("c");
  });

  it("starts another agent on its own default model, keeping the permissions", async () => {
    await render(<NewChatSheet visible sessionId="s" tabId="a" onClose={vi.fn()} onStarted={vi.fn()} />);
    await act(async () => button("Codex")!.click());
    await type("Draw a butterfly");
    await act(async () => button("Start chat")!.click());
    expect(mocks.app.api.continueInNewTab).toHaveBeenCalledWith("s", "a", { harness: "codex", model: "", effort: null, permissionMode: "plan" }, "Draw a butterfly");
  });

  it("says why the Mac would not start it, and stays open", async () => {
    mocks.app.api.continueInNewTab.mockResolvedValueOnce({ started: false, message: "The Mac is busy." });
    const onStarted = vi.fn();
    await render(<NewChatSheet visible sessionId="s" tabId="a" onClose={vi.fn()} onStarted={onStarted} />);
    await type("Hello");
    await act(async () => button("Start chat")!.click());
    expect(container.textContent).toContain("The Mac is busy.");
    expect(onStarted).not.toHaveBeenCalled();
  });
});
