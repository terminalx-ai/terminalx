// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsScreen from "../app/(tabs)/settings";
import PrivacyScreen from "../app/privacy";
import ConnectionLogScreen from "../app/connection-log";
import AccountScreen from "../app/account";
import { defaultSettings } from "./notifications/model";

// #987: Settings in plain words. Machines are managed on the Machines tab only.
const mocks = vi.hoisted(() => ({ app: {} as any, push: vi.fn(), back: vi.fn(), setName: vi.fn(), alert: vi.fn(), notifications: null as any }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/ui/theme", async (actual) => ({ ...(await actual<typeof import("@mobile/ui/theme")>()), useTheme: () => ({ palette: { accent: "#e7806d", border: "#333" }, name: "Ember", setName: mocks.setName }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mocks.push, back: mocks.back }) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.2.32", ios: { buildNumber: "118" } } } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@mobile/notifications/store", () => ({ useNotificationSettings: () => mocks.notifications }));
vi.mock("react-native", () => {
  const flat = (style: unknown): Record<string, unknown> => Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? style as Record<string, unknown> : {};
  const View = ({ children, testID, style }: { children?: ReactNode; testID?: string; style?: unknown }) => <div data-testid={testID} data-bg={flat(style).backgroundColor as string | undefined}>{children}</div>;
  return {
    View, Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>, ScrollView: View,
    Platform: { OS: "ios" }, Alert: { alert: mocks.alert }, useColorScheme: () => "dark",
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityState }: any) => <button aria-label={accessibilityLabel} aria-pressed={accessibilityState?.selected} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    Switch: ({ value, onValueChange, accessibilityLabel }: any) => <input type="checkbox" role="switch" aria-label={accessibilityLabel} checked={!!value} onChange={(event) => onValueChange(event.currentTarget.checked)} />,
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress }: any) => <button onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>, Screen: ({ children }: any) => <div>{children}</div>,
  SectionTitle: ({ children }: any) => <h2>{children}</h2>,
}));

const host = (id: string, fields: object = {}) => ({ id, label: "Paired Mac", hostName: `Mac ${id}`, publicKeyB64: `k-${id}`, endpoint: "ws://x", lastConnectedAt: 1, provenance: { kind: "explicit" }, ...fields });

let root: Root;
let container: HTMLDivElement;
const show = (screen: ReactNode) => act(async () => { root.render(screen); });

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.push.mockReset();
  mocks.back.mockReset();
  mocks.setName.mockReset();
  mocks.alert.mockReset();
  mocks.notifications = { ...defaultSettings(), allow: true };
  const studio = host("studio", { customName: "Studio MacBook" });
  mocks.app = {
    session: { user: { displayName: "Alex", email: "alex@example.com" } },
    hosts: [studio, host("mini"), host("imac")], accountHosts: [], accountMachinePrefs: {}, activeHost: studio,
    connectionStage: "connected", connectionAttempt: 0, logs: [{ id: "1", at: 0, level: "info", message: "Connected", detail: "Studio · relay · https://relay.example" }],
    signIn: vi.fn(), signOut: vi.fn(), forgetHost: vi.fn(), connection: {},
    api: { onSettingsChanged: () => () => {}, features: async () => ({ macSettings: 1 }), onFeaturesChanged: () => () => {}, macSettings: vi.fn(async () => ({ nativeCodex: false })), setNativeCodex: vi.fn() },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("lists no machines and has no one-tap delete", async () => {
  await show(<SettingsScreen />);
  const text = container.textContent!;
  expect(text).not.toContain("Paired machines");
  for (const name of ["Mac mini", "Mac imac"]) expect(text).not.toContain(name);
  expect([...container.querySelectorAll("button")].some((b) => /forget|remove|delete/i.test(`${b.textContent} ${b.getAttribute("aria-label") ?? ""}`))).toBe(false);
  expect(mocks.app.forgetHost).not.toHaveBeenCalled();
});

it("puts the machine's own options under its name, with one line on what they do", async () => {
  await show(<SettingsScreen />);
  const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
  expect(headings).toEqual(["Notifications", "Appearance", "Studio MacBook", "Privacy and help"]);
  expect(container.textContent).toContain("Native CodexExperimental. A more reliable chat for new Codex sessions.");
});

it("clears the previous machine settings while reconnecting and loads them again", async () => {
  await show(<SettingsScreen />);
  expect(container.querySelector("[aria-label='Native Codex']")).not.toBeNull();
  mocks.app.connectionStage = "disconnected";
  await show(<SettingsScreen />);
  expect(container.textContent).toContain("Connect to this machine to change its settings.");
  let resolve!: (value: { nativeCodex: boolean }) => void;
  mocks.app.api.macSettings.mockImplementation(() => new Promise((done) => { resolve = done; }));
  mocks.app.connectionStage = "connected";
  await show(<SettingsScreen />);
  expect(container.textContent).toContain("Reading this machine’s settings…");
  expect(container.querySelector("[aria-label='Native Codex']")).toBeNull();
  await act(async () => resolve({ nativeCodex: true }));
  expect((container.querySelector("[aria-label='Native Codex']") as HTMLInputElement).checked).toBe(true);
});

it("shows each theme's page and accent colours, with a tick on the current one", async () => {
  await show(<SettingsScreen />);
  const { themePalette } = await vi.importActual<typeof import("@mobile/ui/theme")>("@mobile/ui/theme");
  for (const theme of ["Den", "Slate", "Moss", "Ember"] as const) {
    const preview = container.querySelector(`[data-testid='theme-preview-${theme}']`)!;
    expect(preview.getAttribute("data-bg"), theme).toBe(themePalette(theme, "dark").page);
    expect(preview.firstElementChild!.getAttribute("data-bg"), theme).toBe(themePalette(theme, "dark").accent);
  }
  expect(container.querySelector("button[aria-pressed='true']")!.getAttribute("aria-label")).toBe("Ember theme");
  await act(async () => (container.querySelector("button[aria-label='Moss theme']") as HTMLButtonElement).click());
  expect(mocks.setName).toHaveBeenCalledWith("Moss");
});

it("shows the app version and build, and links to the privacy page and the connection log", async () => {
  await show(<SettingsScreen />);
  expect(container.textContent).toContain("Version0.2.32 (118)");
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "How your data stays on your Mac")!.click());
  expect(mocks.push).toHaveBeenLastCalledWith("/privacy");
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Connection log")!.click());
  expect(mocks.push).toHaveBeenLastCalledWith("/connection-log");
});

// #990 (design 22.07 frame 1): notifications have their own page; the row says what is switched on.
it("opens Notifications from a row that says what is switched on", async () => {
  await show(<SettingsScreen />);
  expect(container.textContent).not.toContain("Tell me when an agent finishes");
  const row = container.querySelector("button[aria-label='Notifications, Questions, approvals, finished, failed']") as HTMLButtonElement;
  expect(row.textContent).toBe("NotificationsQuestions, approvals, finished, failed");
  await act(async () => row.click());
  expect(mocks.push).toHaveBeenLastCalledWith("/notifications");
});

it("says Off on the Notifications row while notifications are off, connected or not", async () => {
  mocks.notifications = { ...defaultSettings(), allow: false };
  mocks.app.connectionStage = "unreachable";
  await show(<SettingsScreen />);
  expect(container.querySelector("button[aria-label='Notifications, Off']")).not.toBeNull();
  expect(mocks.alert).not.toHaveBeenCalled();
});

// The words the recording found in Settings: none of them is in Settings or behind its links.
it.each([["Settings", () => <SettingsScreen />], ["the privacy page", () => <PrivacyScreen />], ["the connection log", () => <ConnectionLogScreen />]])("uses no technical words on %s", async (_where, screen) => {
  await show(screen());
  const words = `${container.textContent} ${[...container.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label")).join(" ")}`;
  expect(words.length).toBeGreaterThan(40);
  for (const banned of [/\bRPC\b/i, /ciphertext/i, /socket/i, /redacted/i]) expect(words).not.toMatch(banned);
});

it("shows the account as one row that opens the account screen, with Sign out one step away (22.05)", async () => {
  await show(<SettingsScreen />);
  const row = container.querySelector("button[aria-label='Account, Alex']") as HTMLButtonElement;
  expect(row.textContent).toBe("AAlexalex@example.com");
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Sign out")).toBe(false);
  await act(async () => row.click());
  expect(mocks.push).toHaveBeenCalledWith("/account");

  await show(<AccountScreen />);
  expect(container.textContent).toContain("Signed in asAlexalex@example.com");
  const signOut = [...container.querySelectorAll("button")].find((b) => b.textContent === "Sign out")!;
  await act(async () => signOut.click());
  expect(mocks.app.signOut).toHaveBeenCalledTimes(1);
  expect(mocks.back).toHaveBeenCalledTimes(1);
});

it("offers Sign in in place of the account row when signed out", async () => {
  mocks.app.session = null;
  await show(<SettingsScreen />);
  expect(container.querySelector("button[aria-label^='Account']")).toBeNull();
  expect(container.textContent).toContain("Not signed in");
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Sign in")!.click();
  expect(mocks.app.signIn).toHaveBeenCalledTimes(1);
});
