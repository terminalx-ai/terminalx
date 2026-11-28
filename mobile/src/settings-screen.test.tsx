// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsScreen from "../app/(tabs)/settings";
import PrivacyScreen from "../app/privacy";
import ConnectionLogScreen from "../app/connection-log";
import AccountScreen from "../app/account";
import SupportReportScreen from "../app/support-report";
import { pairingInstance, endPairingInstance } from "./store/pairing-instance";
import { defaultSettings } from "./notifications/model";
import { resetCancelledNoticeForTests } from "./account/cancelled-notice";
import { accountDeletionText } from "./account/deletion";
import { plainRead } from "./account/fixtures";
import { resetPendingDeletionForTests } from "./account/pending-deletion";

// #987: Settings in plain words. Machines are managed on the Machines tab only.
const support = vi.hoisted(() => ({ preview: vi.fn(), submit: vi.fn(), copy: vi.fn(), events: vi.fn(), hosts: vi.fn(), preventRemove: vi.fn() }));
const mocks = vi.hoisted(() => ({ app: {} as any, push: vi.fn(), back: vi.fn(), setName: vi.fn(), alert: vi.fn(), notifications: null as any, storage: new Map<string, string>(), organizations: [] as any[], catalog: null as any }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => mocks.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { mocks.storage.set(key, value); },
  removeItem: async (key: string) => { mocks.storage.delete(key); },
} }));
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: () => ({ organizations: mocks.organizations.map((organization) => ({ organization })) }) }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/ui/theme", async (actual) => ({ ...(await actual<typeof import("@mobile/ui/theme")>()), useTheme: () => ({ palette: { accent: "#e7806d", border: "#333" }, name: "Ember", setName: mocks.setName }) }));
vi.mock("@mobile/support/api", () => ({ supportApi: support }));
vi.mock("expo-clipboard", () => ({ setStringAsync: support.copy }));
vi.mock("@mobile/store/hosts", () => ({ readHosts: support.hosts }));
vi.mock("@mobile/transport/connection", () => ({ scopedConnectionSnapshot: support.events, supportConnectionStages: ["connected"], supportConnectionClassifications: ["relay"] }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  // The screen comes into view once, when it is drawn.
  return { usePreventRemove: support.preventRemove, useRouter: () => ({ push: mocks.push, back: mocks.back }), useFocusEffect: (run: () => void) => useEffect(run, [run]) };
});
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.2.32", ios: { buildNumber: "118" } } } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@mobile/notifications/store", () => ({ useNotificationSettings: () => mocks.notifications }));
vi.mock("react-native", () => {
  const flat = (style: unknown): Record<string, unknown> => Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? style as Record<string, unknown> : {};
  const View = ({ children, testID, style }: { children?: ReactNode; testID?: string; style?: unknown }) => <div data-testid={testID} data-bg={flat(style).backgroundColor as string | undefined}>{children}</div>;
  return {
    useWindowDimensions: () => ({ width: 375, height: 667, scale: 2, fontScale: 1 }),
    View, Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>, ScrollView: View,
    FlatList: ({ data = [], renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: any) => (
      <div>
        {ListHeaderComponent}
        {data.length ? data.map((item: unknown, index: number) => <div key={keyExtractor ? keyExtractor(item, index) : index}>{renderItem({ item, index })}</div>) : ListEmptyComponent}
        {ListFooterComponent}
      </div>
    ),
    TextInput: ({ accessibilityLabel, value, onChangeText }: any) => <input aria-label={accessibilityLabel} value={value} onChange={(event) => onChangeText(event.currentTarget.value)} />,
    Platform: { OS: "ios" }, Alert: { alert: mocks.alert }, useColorScheme: () => "dark",
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityState }: any) => <button aria-label={accessibilityLabel} aria-pressed={accessibilityState?.selected} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    Switch: ({ value, onValueChange, accessibilityLabel }: any) => <input type="checkbox" role="switch" aria-label={accessibilityLabel} checked={!!value} onChange={(event) => onValueChange(event.currentTarget.checked)} />,
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button onClick={onPress} disabled={disabled}>{label}</button>,
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
  support.preview.mockReset();
  support.submit.mockReset();
  support.copy.mockReset();
  support.events.mockReset();
  support.hosts.mockReset().mockImplementation(async () => mocks.app.hosts);
  support.preventRemove.mockReset();
  mocks.back.mockReset();
  mocks.setName.mockReset();
  mocks.alert.mockReset();
  mocks.notifications = { ...defaultSettings(), allow: true };
  mocks.organizations = [];
  mocks.catalog = null;
  mocks.storage.clear();
  resetPendingDeletionForTests();
  resetCancelledNoticeForTests();
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
  expect(headings).toEqual(["Notifications", "Appearance", "Data", "Studio MacBook", "Privacy and help"]);
  expect(container.textContent).toContain("Native CodexExperimental. A more reliable chat for new Codex sessions.");
});

it("keeps sending recent sessions ahead of time off until the person turns it on, on this phone (#1283)", async () => {
  await show(<SettingsScreen />);
  const toggle = () => container.querySelector("[aria-label='Send recent sessions ahead of time']") as HTMLInputElement;
  expect(toggle().checked).toBe(false);
  expect(container.textContent).toContain("Uses more data while the app is open.");
  await act(async () => { toggle().click(); });
  expect(toggle().checked).toBe(true);
  expect(mocks.storage.get("terminalx:prefetch:v1")).toBe("on");
  await act(async () => { toggle().click(); });
  expect(mocks.storage.get("terminalx:prefetch:v1")).toBe("off");
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
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "How your data stays on your computer")!.click());
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

it("lists the account's organizations with the role in each, each opening its own page (#1292)", async () => {
  mocks.organizations = [
    { orgId: "org-personal", name: "Alex", role: "owner", isPersonal: true },
    { orgId: "org-team", name: "Test organization", role: "owner", isPersonal: false },
    { orgId: "org-other", name: "Other team", role: "member" },
  ];
  await show(<AccountScreen />);
  expect([...container.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Organizations"]);
  const rows = [...container.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label"));
  expect(rows).toEqual(["Alex, Owner", "Test organization, Owner", "Other team, Member", `${accountDeletionText.rowTitle}. ${accountDeletionText.rowHint}`]);
  expect(container.textContent).toContain("Personal · Owner");
  await act(async () => (container.querySelector("button[aria-label='Test organization, Owner']") as HTMLButtonElement).click());
  expect(mocks.push).toHaveBeenCalledWith({ pathname: "/organization/[orgId]", params: { orgId: "org-team" } });
});

it("has Delete account as a row below Sign out, not a second red button, opening its own page (PRO-584)", async () => {
  await show(<AccountScreen />);
  const text = container.textContent!;
  expect(text.indexOf("Sign out")).toBeLessThan(text.indexOf(accountDeletionText.rowTitle));
  expect(text).toContain(accountDeletionText.rowHint);
  expect([...container.querySelectorAll("button")].filter((b) => b.textContent === "Delete account")).toEqual([]);
  await act(async () => (container.querySelector(`button[aria-label='${accountDeletionText.rowTitle}. ${accountDeletionText.rowHint}']`) as HTMLButtonElement).click());
  expect(mocks.push).toHaveBeenCalledWith("/delete-account");
});

it("says on the signed-out card when the account will be deleted, until the day passes (PRO-584)", async () => {
  mocks.app.session = null;
  const day = new Date(2099, 11, 9, 12).getTime();
  mocks.storage.set("terminalx:account-deletion:v1", JSON.stringify({ deleteAfter: day }));
  await show(<SettingsScreen />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(container.textContent).toContain(accountDeletionText.doneHead("9 December 2099"));
  expect(container.textContent).toContain(accountDeletionText.doneKeep("9 December 2099"));
  expect(container.textContent).toContain("Not signed in");

  act(() => root.unmount());
  root = createRoot(container);
  resetPendingDeletionForTests();
  mocks.storage.set("terminalx:account-deletion:v1", JSON.stringify({ deleteAfter: Date.now() - 1 }));
  await show(<SettingsScreen />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(container.textContent).not.toContain("will be deleted on");
  expect(mocks.storage.has("terminalx:account-deletion:v1")).toBe(false);
});

it("says once that signing in cancelled the deletion, and that stopped cloud workspaces stay stopped (PRO-584)", async () => {
  mocks.app.session = { user: { userId: "user-alex", displayName: "Alex", email: "alex@example.com" } };
  const read = { ...plainRead(), notice: "cancelled", deletion: { id: "del_1", kind: "self", state: "cancelled", requestedAt: "2026-11-25T12:00:00.000Z", workspaces: [{ workspaceId: "ws_1", action: "stop", state: "stopped" }] } };
  mocks.catalog = { api: { accountDeletion: vi.fn(async () => read), acknowledgeAccountDeletionNotice: vi.fn(async () => undefined) } };
  await show(<SettingsScreen />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(container.textContent).toContain(accountDeletionText.cancelled);
  expect(container.textContent).toContain(accountDeletionText.cancelledStopped);
  expect(mocks.catalog.api.acknowledgeAccountDeletionNotice).toHaveBeenCalledTimes(1);
  // Read once for the sign-in: drawn again, it asks nothing more.
  await show(<SettingsScreen />);
  expect(mocks.catalog.api.accountDeletion).toHaveBeenCalledTimes(1);
});

it("offers Sign in in place of the account row when signed out", async () => {
  mocks.app.session = null;
  await show(<SettingsScreen />);
  expect(container.querySelector("button[aria-label^='Account']")).toBeNull();
  expect(container.textContent).toContain("Not signed in");
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Sign in")!.click();
  expect(mocks.app.signIn).toHaveBeenCalledTimes(1);
});

const supportReceipt = "c1e725d7-9bcb-49f6-abf1-5fdf0f1d3464";

const tap = (label: string) => act(async () => {
  [...container.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
});

it("opens support reports from Settings and cancels before sending", async () => {
  await show(<SettingsScreen />);
  await tap("Send a support report");
  expect(mocks.push).toHaveBeenCalledWith("/support-report");

  await show(<SupportReportScreen />);
  expect(support.preview).not.toHaveBeenCalled();
  await tap("Cancel");
  expect(mocks.back).toHaveBeenCalled();
  expect(support.submit).not.toHaveBeenCalled();
});

function prepareMobileSupport(now: number) {
  mocks.app.session.user.userId = "my-account";
  const machine = { ...mocks.app.hosts[0], provenance: { kind: "automatic", userId: "my-account" } };
  mocks.app.hosts = [machine];
  support.events.mockReturnValue({
    events: [{ at: now - 500, kind: "connected", classification: "relay", detail: "ghp_CANARY" }],
    retainedSince: now - 499, pairings: [{ hostId: machine.id, instance: pairingInstance(machine.id) }],
  });
  support.preview.mockResolvedValue({
    key: supportReceipt, from: now - 1000, to: now, server: { status: "omitted", events: [], capturedAt: now, truncated: false },
  });
  return machine;
}

async function showMobilePreview() {
  await show(<SupportReportScreen />);
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="This phone’s connection events"]')!.click());
  expect(support.events).not.toHaveBeenCalled();
  await tap("Prepare preview");
  expect(container.textContent).toContain("Phone: Included");
}

it("previews scoped mobile events and retries the reviewed submission before confirming delivery", async () => {
  const now = Date.now();
  prepareMobileSupport(now);
  support.submit.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ reference: supportReceipt });
  await showMobilePreview();
  expect(support.events).toHaveBeenCalledWith(mocks.app.logs, "my-account", mocks.app.hosts, { from: now - 1000, to: now });
  await tap("Send to TerminalX Support");
  expect(container.textContent).not.toContain("Report delivered");
  expect(support.preventRemove).toHaveBeenCalledWith(true);
  await show(<SettingsScreen />);
  await show(<SupportReportScreen />);
  await tap("Retry same report");
  expect(container.textContent).toContain(supportReceipt);
  expect(support.submit.mock.calls[0]!.slice(0, 2)).toEqual(support.submit.mock.calls[1]!.slice(0, 2));
  expect(JSON.stringify(support.submit.mock.calls)).not.toContain("ghp_CANARY");
  await tap("Done");
});

it("hides a pending report after the contributing machine is forgotten and paired again", async () => {
  const machine = prepareMobileSupport(Date.now());
  support.submit.mockRejectedValueOnce(new Error("offline"));
  await showMobilePreview();
  await tap("Send to TerminalX Support");
  await show(<SettingsScreen />);
  endPairingInstance(machine.id);
  pairingInstance(machine.id);
  await show(<SupportReportScreen />);
  expect(container.textContent).toContain("Pairing access changed");
  expect(container.textContent).not.toMatch(/Review diagnostic fields|Copy local report|Retry same report/);
  expect(support.submit).toHaveBeenCalledTimes(1);
});

it("refuses to copy if the saved pairing disappeared before the settings view refreshed", async () => {
  prepareMobileSupport(Date.now());
  await showMobilePreview();
  support.hosts.mockResolvedValueOnce([]);
  await tap("Copy local report");
  expect(container.textContent).toContain("Pairing access changed");
  expect(support.copy).not.toHaveBeenCalled();
});
