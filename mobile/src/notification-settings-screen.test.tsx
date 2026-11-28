// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  permission: { granted: true, status: "granted" } as { granted: boolean; status: string },
  openedSettings: 0,
  os: "ios",
  app: {} as any,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => fake.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void fake.storage.set(key, value),
    removeItem: async (key: string) => void fake.storage.delete(key),
    getAllKeys: async () => [...fake.storage.keys()],
  },
}));
vi.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: async () => null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "client-id" }));
vi.mock("expo-notifications", () => ({
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: async () => fake.permission,
  requestPermissionsAsync: async () => fake.permission,
  scheduleNotificationAsync: async () => "id",
  setNotificationCategoryAsync: async () => ({}),
}));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => fake.app }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ name: "Ember", palette: {}, setName: vi.fn() }) }));
vi.mock("./ui/theme", () => ({ useTheme: () => ({ name: "Ember", palette: {}, setName: vi.fn() }) }));
vi.mock("@mobile/ui/primitives", () => primitives());
vi.mock("./ui/primitives", () => primitives());
vi.mock("react-native", () => {
  const Box = ({ children, accessibilityRole, style }: { children?: ReactNode; accessibilityRole?: string; style?: unknown }) => <div role={accessibilityRole} data-dimmed={JSON.stringify(style ?? null).includes("0.45") ? "true" : undefined}>{children}</div>;
  return {
    View: Box, Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>, ScrollView: Box,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    Alert: { alert: vi.fn() },
    Platform: { get OS() { return fake.os; } },
    Linking: { openSettings: async () => { fake.openedSettings++; } },
    Modal: ({ visible, children }: any) => visible ? <div role="dialog">{children}</div> : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: any) => <button disabled={disabled} aria-label={accessibilityLabel} aria-selected={accessibilityState?.selected} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    Switch: ({ value, onValueChange, disabled, accessibilityLabel }: any) => <input type="checkbox" aria-label={accessibilityLabel} checked={value} disabled={disabled} onChange={(event) => onValueChange(event.currentTarget.checked)} />,
  };
});

function primitives() {
  return {
    Screen: ({ children, title }: { children?: ReactNode; title?: string }) => <main>{title ? <h1>{title}</h1> : null}{children}</main>,
    Card: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => <section role={accessibilityRole}>{children}</section>,
    SectionTitle: ({ children }: { children: string }) => <h2>{children.toUpperCase()}</h2>,
    Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  };
}

import { NotificationsPage, DELIVERY_NOTE } from "./ui/notifications/NotificationsPage";
import { SessionNotificationsSheet } from "./ui/notifications/SessionNotifications";
import { loadNotificationSettings, resetNotificationSettingsForTests, SETTINGS_KEY } from "./notifications/store";
import { defaultSettings } from "./notifications/model";

let root: Root;
let container: HTMLDivElement;
const host = (id: string, name: string) => ({ id, hostName: name, provenance: { kind: "explicit" } });
const render = (node: ReactNode) => act(async () => { root.render(node); });
const settle = () => act(async () => { await loadNotificationSettings(); await new Promise((resolve) => setTimeout(resolve, 0)); });
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label) as HTMLButtonElement | undefined;
const toggle = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
const click = (element: HTMLElement | null | undefined) => act(async () => { element!.click(); });
const saved = () => JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "null");

function store(settings: object) {
  fake.storage.set(SETTINGS_KEY, JSON.stringify({ ...defaultSettings(), ...settings }));
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fake.storage.clear();
  fake.permission = { granted: true, status: "granted" };
  fake.openedSettings = 0;
  resetNotificationSettingsForTests();
  fake.app = {
    hosts: [host("mbp", "Studio MacBook"), host("mini", "Mac mini"), host("imac", "Office iMac")],
    activeHost: null, connectionStage: "idle", logs: [], session: null,
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

// The Settings row (frame 1) is tested with the rest of Settings, in settings-screen.test.tsx.

describe("the Notifications page (22.07 frames 2 and 3)", () => {
  it("lists the choices in the design's order, with its defaults", async () => {
    store({ allow: true });
    await render(<NotificationsPage />);
    await settle();
    const headings = [...container.querySelectorAll("h2")].map((item) => item.textContent);
    expect(headings).toEqual(["NOTIFY ME WHEN AN AGENT", "PULL REQUESTS", "WHICH SESSIONS", "MACHINES", "QUIET HOURS", "ON THE LOCK SCREEN"]);
    expect(toggle("Allow notifications")!.checked).toBe(true);
    expect(text()).toContain(DELIVERY_NOTE);
    const on = (label: string) => toggle(label)!.checked;
    expect([on("Asks a question"), on("Needs approval"), on("Finishes its task"), on("Fails or stops on an error"), on("Reaches a usage limit")]).toEqual([true, true, true, true, false]);
    expect([on("Pull request checks fail"), on("Pull request merged")]).toEqual([true, false]);
    expect(button("All sessions")!.getAttribute("aria-selected")).toBe("true");
    expect(["Studio MacBook", "Mac mini", "Office iMac"].map((name) => on(`Notifications from ${name}`))).toEqual([true, true, true]);
    expect(text()).toContain("10:00 PM to 7:00 AM");
    expect(button("Show, Session name only")).toBeDefined();
    expect(button("Sound, Default")).toBeDefined();
  });

  it("keeps each change", async () => {
    store({ allow: true });
    await render(<NotificationsPage />);
    await settle();
    await click(toggle("Reaches a usage limit"));
    await click(toggle("Pull request merged"));
    await click(button("Only sessions I started or follow"));
    await click(toggle("Notifications from Office iMac"));
    await click(toggle("Quiet hours"));
    await click(button("Starts, 10:00 PM"));
    await click(button("11:30 PM"));
    await click(toggle("Still notify when an agent needs me"));
    await click(button("Show, Session name only"));
    await click(button("Everything"));
    await settle();
    const value = saved();
    expect(value.kinds).toMatchObject({ usage_limit: true, pr_merged: true });
    expect(value.sessions).toBe("mine");
    expect(value.machines).toEqual({ imac: false });
    expect(value.quietHours).toEqual({ on: true, start: 23 * 60 + 30, end: 7 * 60, stillNotifyNeedsMe: true });
    expect(value.lockScreen).toEqual({ show: "everything", sound: true });
    expect(button("Ends, 7:00 AM")).toBeDefined();
  });
});

describe("with iOS notifications off (22.07 frame 4)", () => {
  it("says so, links to iOS Settings, and keeps the choices visible, dimmed and unchanged", async () => {
    store({ allow: true, kinds: { ...defaultSettings().kinds, usage_limit: true } });
    fake.permission = { granted: false, status: "denied" };
    await render(<NotificationsPage />);
    await settle();
    const notice = container.querySelector("section[role=alert]")!;
    expect(notice.textContent).toContain("Notifications are off for TerminalX");
    expect(notice.textContent).toContain("Turn them on in iOS Settings. Your choices below are kept.");
    await click(button("Open iOS Settings"));
    expect(fake.openedSettings).toBe(1);
    expect(toggle("Allow notifications")).toBeNull();
    expect(toggle("Reaches a usage limit")!.checked).toBe(true);
    expect(toggle("Reaches a usage limit")!.disabled).toBe(true);
    expect(container.querySelector("[data-dimmed=true]")).not.toBeNull();
    expect((await loadNotificationSettings()).kinds.usage_limit).toBe(true);
  });

  it("names the phone’s own Settings on Android, which has no iOS Settings", async () => {
    fake.os = "android";
    try {
      fake.permission = { granted: false, status: "denied" };
      await render(<NotificationsPage />);
      await settle();
      const notice = container.querySelector("section[role=alert]")!;
      expect(notice.textContent).toContain("Turn them on in Settings. Your choices below are kept.");
      expect(notice.textContent).not.toContain("iOS");
      expect(button("Open Settings")).toBeTruthy();
    } finally {
      fake.os = "ios";
    }
  });
});

describe("one session's notifications (22.07 frame 5)", () => {
  it("offers the four choices, marks the current one, and keeps the choice for that session only", async () => {
    store({ allow: true });
    await render(<SessionNotificationsSheet visible hostId="mbp" sessionId="s1" name="Review and merge" onClose={vi.fn()} />);
    await settle();
    expect(text()).toContain("Review and merge");
    expect(text()).toContain("Notifications for this session");
    const labels = [...container.querySelectorAll("[role=dialog] button")].map((item) => item.getAttribute("aria-label")).filter((label) => label !== "Close");
    expect(labels).toEqual(["Use my settings", "Only when it needs me", "Everything from this session", "Mute this session"]);
    expect(button("Use my settings")!.getAttribute("aria-selected")).toBe("true");
    await click(button("Mute this session"));
    await settle();
    expect(saved().perSession).toEqual({ mbp: { s1: "mute" } });
    expect(button("Mute this session")!.getAttribute("aria-selected")).toBe("true");
    await click(button("Use my settings"));
    await settle();
    expect(saved().perSession).toEqual({});
  });
});
