// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewSessionScreen from "../app/session/new";
import SessionsScreen from "../app/(tabs)/sessions";
import SettingsScreen from "../app/(tabs)/settings";

// A phone starts sessions and changes this Mac's settings as the desktop does.
const mocks = vi.hoisted(() => ({ app: {} as any, push: vi.fn(), replace: vi.fn(), navigate: vi.fn(), uuids: 0 }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {}, name: "Den", setName: vi.fn() }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace, navigate: mocks.navigate, dismissTo: vi.fn() }) }));
vi.mock("expo-crypto", () => ({ randomUUID: () => `draft-${++mocks.uuids}` }));
vi.mock("@mobile/notifications/local", () => ({ localNotificationsEnabled: async () => false, enableLocalNotifications: vi.fn(), disableLocalNotifications: vi.fn() }));
vi.mock("@mobile/pairing/account", () => ({ accountHostIdentityMatches: () => true }));
vi.mock("@terminalx/portable/dashboard", () => ({}));
vi.mock("@mobile/data/conversations", () => ({ conversationRows: () => [], statusLabel: () => "" }));
vi.mock("lucide-react-native", () => Object.fromEntries(["Check", "ChevronDown", "ChevronUp", "ChevronRight", "Plus", "Search", "Trash2", "MoreVertical", "Keyboard", "QrCode", "X"].map((name) => [name, () => null])));
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box, Text: Box, RefreshControl: () => null, Platform: { OS: "ios" }, Alert: { alert: vi.fn() },
    Modal: ({ visible, children }: any) => visible ? <div>{children}</div> : null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: any) => <button disabled={disabled} aria-label={accessibilityLabel} aria-pressed={accessibilityState?.selected} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    TextInput: ({ value, onChangeText, accessibilityLabel, placeholder }: any) => <input aria-label={accessibilityLabel} placeholder={placeholder} value={value} onInput={(event) => onChangeText(event.currentTarget.value)} />,
    Switch: ({ value, onValueChange, accessibilityLabel }: any) => <input type="checkbox" role="switch" aria-label={accessibilityLabel} checked={!!value} onChange={(event) => onValueChange(event.currentTarget.checked)} />,
    SectionList: ({ ListHeaderComponent }: any) => <div>{ListHeaderComponent}</div>,
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>, Screen: ({ children }: any) => <div>{children}</div>,
  SectionTitle: ({ children }: any) => <div>{children}</div>, EmptyState: ({ title, detail }: any) => <div>{title} {detail}</div>, StatusDot: () => null,
}));

const options = {
  projects: [{ id: "p-repo", name: "terminalx", git: true, lastUsed: true }, { id: "p-notes", name: "notes", git: false, lastUsed: false }],
  agents: [
    { id: "claude", name: "Claude Code", available: true, installHint: "", effort: true, permissionModes: true, models: [{ id: "opus", label: "Opus", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }] },
    { id: "codex", name: "Codex", available: true, installHint: "", effort: true, permissionModes: true, models: [{ id: "gpt-5", label: "GPT-5", isDefault: true, efforts: ["medium", "high"], defaultEffort: "medium" }] },
    { id: "opencode", name: "OpenCode", available: false, installHint: "brew install opencode", effort: false, permissionModes: false, models: [] },
  ],
  modes: [{ id: "plan", label: "Plan" }, { id: "manual", label: "Ask every time" }, { id: "bypassPermissions", label: "Bypass permissions" }],
  defaultMode: "bypassPermissions",
  nativeCodex: true,
};

let root: Root;
let container: HTMLDivElement;
const render = (screen: ReactNode) => act(async () => { root.render(screen); });
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
const click = async (label: string) => { expect(button(label), label).toBeDefined(); await act(async () => { button(label)!.click(); }); };
const type = async (label: string, value: string) => {
  const field = container.querySelector(`input[aria-label='${label}']`) as HTMLInputElement;
  expect(field, label).not.toBeNull();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.push.mockReset(); mocks.replace.mockReset(); mocks.uuids = 0;
  const host = { id: "mac-1", label: "Mac", hostName: "Studio", provenance: { kind: "explicit" } };
  mocks.app = {
    ready: true, session: null, hosts: [host], activeHost: host, connectionStage: "connected", connectionAttempt: 0, sessions: [], logs: [], loadingSessions: false,
    connection: { restart: vi.fn() }, refreshSessions: vi.fn(async () => undefined), forgetHost: vi.fn(), renameHost: vi.fn(), reconnectHost: vi.fn(), connectHost: vi.fn(),
    api: {
      features: vi.fn(async () => ({ sessionCreate: 1, macSettings: 1 })),
      newSessionOptions: vi.fn(async () => options),
      createSession: vi.fn(async () => ({ created: true, sessionId: "s-1", tabId: "t-1", title: "Fix the login redirect", native: false, queued: false })),
      macSettings: vi.fn(async () => ({ nativeCodex: false })),
      setNativeCodex: vi.fn(async (on: boolean) => ({ nativeCodex: on })),
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("starting a session from the phone", () => {
  it("opens on the project last used, in a new worktree, with the first installed agent's defaults", async () => {
    await render(<NewSessionScreen />);
    expect(button("terminalx")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("New worktree")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("Claude Code")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("Opus")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("high")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("Bypass permissions")!.getAttribute("aria-pressed")).toBe("true");
    // An agent the Mac does not have cannot be chosen.
    expect(button("OpenCode")!.disabled).toBe(true);
    expect(container.textContent).toContain("Not installed · brew install opencode");
    // Nothing to send yet.
    expect(button("Start session")!.disabled).toBe(true);
  });

  it("starts what was chosen, under one draft id, and opens the new session", async () => {
    await render(<NewSessionScreen />);
    await click("Codex");
    expect(button("GPT-5")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("medium")!.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Native Codex is on for this Mac");
    await click("On the checkout");
    await click("Plan");
    await type("First message", "Fix the login redirect");
    await click("Start session");
    expect(mocks.app.api.createSession).toHaveBeenCalledWith({
      where: { projectId: "p-repo", useWorktree: false }, agent: "codex", model: "gpt-5", effort: "medium", mode: "plan", title: "", text: "Fix the login redirect",
    }, "draft-1");
    expect(mocks.replace).toHaveBeenCalledWith({ pathname: "/session/[sessionId]", params: { sessionId: "s-1", tabId: "t-1", hostId: "mac-1", title: "Fix the login redirect" } });
    expect(mocks.app.refreshSessions).toHaveBeenCalled();
  });

  it("keeps the draft id when the Mac's reply is lost, so starting it again finds the first session", async () => {
    mocks.app.api.createSession.mockResolvedValueOnce({ created: false, message: "The paired-device connection or account changed." });
    await render(<NewSessionScreen />);
    await click("Quick chat");
    await type("First message", "What is a monad?");
    await click("Start session");
    expect(container.textContent).toContain("The paired-device connection or account changed.");
    expect(mocks.replace).not.toHaveBeenCalled();
    await click("Start session");
    const calls = mocks.app.api.createSession.mock.calls;
    expect(calls.map((call: unknown[]) => call[1])).toEqual(["draft-1", "draft-1"]);
    expect(calls[1][0].where).toEqual({ quick: true });
    // An edited draft is another session, under another id.
    mocks.replace.mockReset();
    await type("First message", "What is a functor?");
    await click("Start session");
    expect(mocks.app.api.createSession.mock.calls[2][1]).toBe("draft-2");
  });

  it("does not offer a worktree for a folder project", async () => {
    await render(<NewSessionScreen />);
    await click("notes");
    expect(button("New worktree")).toBeUndefined();
  });

  it("says when the Mac cannot start sessions for a phone", async () => {
    mocks.app.api.newSessionOptions.mockResolvedValue(null);
    await render(<NewSessionScreen />);
    expect(container.textContent).toContain("Update TerminalX on this Mac");
  });

  it("is offered on the sessions screen by a Mac that can start sessions", async () => {
    await render(<SessionsScreen />);
    await click("New session");
    expect(mocks.push).toHaveBeenCalledWith("/session/new");
    mocks.app.api.features.mockResolvedValue({});
    await render(<SessionsScreen />);
    mocks.app = { ...mocks.app, activeHost: { ...mocks.app.activeHost, id: "mac-2" } };
    await render(<SessionsScreen />);
    expect(button("New session")).toBeUndefined();
  });
});

describe("this Mac's settings on the phone", () => {
  it("turns Native Codex on for the Mac's next Codex sessions", async () => {
    await render(<SettingsScreen />);
    expect(container.textContent).toContain("This Mac · Studio");
    const toggle = container.querySelector("input[aria-label='Native Codex']") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.click(); });
    expect(mocks.app.api.setNativeCodex).toHaveBeenCalledWith(true);
    expect((container.querySelector("input[aria-label='Native Codex']") as HTMLInputElement).checked).toBe(true);
  });

  it("puts the switch back and says why when the Mac refuses", async () => {
    mocks.app.api.setNativeCodex.mockRejectedValue(new Error("this paired device is read-only"));
    await render(<SettingsScreen />);
    await act(async () => { (container.querySelector("input[aria-label='Native Codex']") as HTMLInputElement).click(); });
    expect(container.textContent).toContain("this paired device is read-only");
    expect((container.querySelector("input[aria-label='Native Codex']") as HTMLInputElement).checked).toBe(false);
  });

  it("asks for an update on a Mac that does not offer its settings", async () => {
    mocks.app.api.macSettings.mockResolvedValue(null);
    await render(<SettingsScreen />);
    expect(container.textContent).toContain("Update TerminalX on this Mac to change its settings");
    expect(container.querySelector("input[aria-label='Native Codex']")).toBeNull();
  });
});
