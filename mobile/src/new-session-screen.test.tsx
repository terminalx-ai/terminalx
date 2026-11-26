// @vitest-environment jsdom
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewSessionScreen from "../app/session/new";
import SessionsScreen from "../app/(tabs)/sessions";
import SettingsScreen from "../app/(tabs)/settings";
import { AccountChoices } from "@mobile/ui/AccountChoices";
import { HostApi, type NewSessionAgent } from "@mobile/data/host-api";
import type { HostConnection } from "@mobile/transport/connection";
import { agentDefaults, initialChoices, request, type NewSessionChoices } from "@mobile/data/new-session";

// A phone starts sessions and changes this Mac's settings as the desktop does.
const mocks = vi.hoisted(() => ({ app: {} as any, push: vi.fn(), replace: vi.fn(), navigate: vi.fn(), uuids: 0 }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
// The Sessions screen reads the cloud catalog for pinned cloud projects (#1469);
// its provider loads native modules. No cloud account here: the screen as it
// is drawn without the provider.
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => null, useCatalogSnapshot: () => ({ organizations: [], loading: false, error: null, refreshedAt: null, saved: false, titles: {}, deletesOrganizations: false }) }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {}, name: "Den", setName: vi.fn() }), THEMES: ["Den"], themePalette: () => ({ page: "#000", accent: "#fff" }) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.1", ios: { buildNumber: "2" } } } }));
vi.mock("expo-router", () => ({ useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useRouter: () => ({ push: mocks.push, replace: mocks.replace, navigate: mocks.navigate, dismissTo: vi.fn() }) }));
vi.mock("expo-crypto", () => ({ randomUUID: () => `draft-${++mocks.uuids}` }));
vi.mock("@mobile/notifications/local", () => ({ localNotificationsEnabled: async () => false, enableLocalNotifications: vi.fn(), disableLocalNotifications: vi.fn() }));
vi.mock("@mobile/pairing/account", () => ({ accountHostIdentityMatches: () => true }));
vi.mock("@terminalx/portable/dashboard", () => ({}));
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AppState: { currentState: "active" },
    View: Box, Text: Box, RefreshControl: () => null, Platform: { OS: "ios" }, Alert: { alert: vi.fn() }, useColorScheme: () => "dark",
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
    ready: true, session: null, hosts: [host], activeHost: host, connectionStage: "connected", connectionAttempt: 0, sessions: [], logs: [],
    connection: { restart: vi.fn() }, refreshSessions: vi.fn(async () => undefined), forgetHost: vi.fn(), renameHost: vi.fn(), reconnectHost: vi.fn(), connectHost: vi.fn(),
    api: {
      features: vi.fn(async () => ({ sessionCreate: 1, macSettings: 1 })),
      onFeaturesChanged: () => () => {},
      newSessionOptions: vi.fn(async () => options),
      createSession: vi.fn(async () => ({ created: true, sessionId: "s-1", tabId: "t-1", title: "Fix the login redirect", native: false, queued: false })),
      onSettingsChanged: vi.fn((_listener: () => void) => () => {}),
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
    expect(container.textContent).toContain("Native Codex is on for this computer");
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

  it("keeps the draft id when the computer's reply is lost, so starting it again finds the first session", async () => {
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

  it("says when the computer cannot start sessions for a phone", async () => {
    mocks.app.api.newSessionOptions.mockResolvedValue(null);
    await render(<NewSessionScreen />);
    expect(container.textContent).toContain("Update TerminalX on this computer");
  });

  it("no longer puts New session on the sessions screen: it is the tab bar's", async () => {
    await render(<SessionsScreen />);
    expect(button("New session")).toBeUndefined();
  });
});

describe("this computer's settings on the phone", () => {
  it("reloads the open switch when the computer's settings file changes", async () => {
    await render(<SettingsScreen />);
    mocks.app.api.macSettings.mockResolvedValue({ nativeCodex: true });
    await act(async () => mocks.app.api.onSettingsChanged.mock.calls[0][0]());
    expect((container.querySelector("input[aria-label='Native Codex']") as HTMLInputElement).checked).toBe(true);
  });

  it("turns Native Codex on for the computer's next Codex sessions", async () => {
    await render(<SettingsScreen />);
    // Under the machine's name (#987), not "This Mac".
    expect(container.textContent).toContain("Studio");
    expect(container.textContent).not.toContain("This computer");
    const toggle = container.querySelector("input[aria-label='Native Codex']") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.click(); });
    expect(mocks.app.api.setNativeCodex).toHaveBeenCalledWith(true);
    expect((container.querySelector("input[aria-label='Native Codex']") as HTMLInputElement).checked).toBe(true);
  });

  it("puts the switch back and says why when the computer refuses", async () => {
    mocks.app.api.setNativeCodex.mockRejectedValue(new Error("this paired device is read-only"));
    await render(<SettingsScreen />);
    await act(async () => { (container.querySelector("input[aria-label='Native Codex']") as HTMLInputElement).click(); });
    expect(container.textContent).toContain("this paired device is read-only");
    expect((container.querySelector("input[aria-label='Native Codex']") as HTMLInputElement).checked).toBe(false);
  });

  it("asks for an update on a Mac that does not offer its settings", async () => {
    mocks.app.api.macSettings.mockResolvedValue(null);
    await render(<SettingsScreen />);
    expect(container.textContent).toContain("Update TerminalX on this machine to change its settings");
    expect(container.querySelector("input[aria-label='Native Codex']")).toBeNull();
  });
});

// #980: several Claude Code and Codex accounts, chosen per session.
describe("choosing an agent account from the phone", () => {
  const WORK = "0123456789abcdef";
  const withAccounts = {
    ...options,
    agents: [
      { ...options.agents[0], accounts: [{ id: "local", label: "This computer's login", agent: "claude" }, { id: WORK, label: "Work · Max", agent: "claude" }], defaultAccount: "local", projectDefaults: { "p-repo": WORK } },
      options.agents[1], options.agents[2],
    ],
  };
  const claude = withAccounts.agents[0] as NewSessionAgent;
  /** The Account section as the form draws it, holding its own choices. */
  function Form({ agent, initial }: { agent: NewSessionAgent; initial: NewSessionChoices }) {
    const [choices, setChoices] = useState(initial);
    return <><AccountChoices agent={agent} choices={choices} onChange={(patch) => setChoices({ ...choices, ...patch })} /><output>{request(choices, { ...withAccounts, agents: [agent] }).account ?? "none"}</output></>;
  }

  it("shows no Account section with one account, and names none in the request", async () => {
    const one = { ...claude, accounts: [{ id: "local", label: "This computer's login", agent: "claude" }] };
    await render(<Form agent={one} initial={initialChoices(options)} />);
    expect(container.textContent).not.toContain("Account");
    expect(button("This computer's login")).toBeUndefined();
    expect(container.querySelector("output")!.textContent).toBe("none");
    // A Mac without accounts sends no `accounts`: the form and request are as before.
    await render(<Form agent={options.agents[0] as NewSessionAgent} initial={initialChoices(options)} />);
    expect(container.textContent).not.toContain("Account");
    expect(container.querySelector("output")!.textContent).toBe("none");
  });

  it("preselects the project's default with two accounts, and starts on the one picked", async () => {
    await render(<Form agent={claude} initial={initialChoices(withAccounts)} />);
    expect(container.textContent).toContain("Account");
    expect(button("Work · Max")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("This computer's login")!.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("output")!.textContent).toBe(WORK);
    await click("This computer's login");
    expect(button("This computer's login")!.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("output")!.textContent).toBe("local");
    // A quick chat has no project default: the agent's applies.
    await render(<Form agent={claude} initial={{ ...initialChoices(withAccounts), where: { quick: true } }} />);
    expect(container.querySelector("output")!.textContent).toBe("local");
    // Another agent's pick never carries over.
    expect(agentDefaults(withAccounts.agents[1] as NewSessionAgent).account).toBeNull();
  });

  it("draws the Account section on the screen and starts the session on the account picked", async () => {
    mocks.app.api.newSessionOptions.mockResolvedValue(withAccounts);
    await render(<NewSessionScreen />);
    // The project's default is chosen first.
    expect(button("Work · Max")!.getAttribute("aria-pressed")).toBe("true");
    await click("This computer's login");
    await type("First message", "Fix the login redirect");
    await click("Start session");
    expect(mocks.app.api.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "claude", account: "local" }), "draft-1");
    // Another account is another draft: a retry after a lost reply never lands on the first one's session.
    mocks.app.api.createSession.mockResolvedValueOnce({ created: false, message: "lost" });
    await render(<NewSessionScreen key="again" />);
    await type("First message", "Fix the login redirect");
    await click("Start session");
    await click("This computer's login");
    await click("Start session");
    const ids = mocks.app.api.createSession.mock.calls.slice(-2).map((call: unknown[]) => call[1]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(mocks.app.api.createSession.mock.calls.at(-2)[0]).toMatchObject({ account: WORK });
  });

  it("reads accounts from the computer with no token field, and sends the account chosen", async () => {
    const calls: [string, unknown][] = [];
    const host = new HostApi({ request: vi.fn(async (method: string, params?: unknown) => {
      calls.push([method, params]);
      if (method === "sync.capabilities") return { ok: true, value: { sendIds: 1, sessionCreate: 1, macSettings: 1 } };
      if (method === "sessions.options") return { ok: true, value: withAccounts };
      return { ok: true, value: { sessionId: "s-1", tabId: "t-1", title: "Fix it", native: false } };
    }), onEvent: () => () => {} } as unknown as HostConnection);
    const read = (await host.newSessionOptions())!;
    const accounts = read.agents[0].accounts!;
    expect(accounts.map((account) => Object.keys(account).sort())).toEqual([["agent", "id", "label"], ["agent", "id", "label"]]);
    expect(JSON.stringify(read)).not.toMatch(/token/i);
    await host.createSession(request({ ...initialChoices(read), text: "Fix it" }, read), "draft");
    expect(calls.find(([method]) => method === "sessions.create")![1]).toMatchObject({ projectId: "p-repo", agent: "claude", account: WORK });
    // Without accounts, nothing is named: a Mac before accounts refuses a field it does not know.
    await host.createSession(request({ ...initialChoices(options), text: "Fix it" }, options), "draft-2");
    expect(calls.filter(([method]) => method === "sessions.create")[1][1]).not.toHaveProperty("account");
    // Accounts the phone cannot read as ids and labels are refused, not shown half-read.
    const bad = { ...withAccounts, agents: [{ ...claude, accounts: [{ id: 1, label: "x", agent: "claude" }] }] };
    const strict = new HostApi({ request: vi.fn(async (method: string) => method === "sync.capabilities" ? { ok: true, value: { sessionCreate: 1 } } : { ok: true, value: bad }), onEvent: () => () => {} } as unknown as HostConnection);
    await expect(strict.newSessionOptions()).rejects.toThrow("cannot read");
  });
});
