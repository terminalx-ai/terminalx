// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MachinesScreen from "../app/(tabs)/index";
import SessionsScreen from "../app/(tabs)/sessions";
import CloudScreen from "../app/(tabs)/cloud";

// #983: one quiet connection state on every list, and a list spinner only for a pull to refresh.
const mocks = vi.hoisted(() => ({ app: {} as any, catalog: null as any, os: "ios" }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/pairing/account", () => ({ accountHostIdentityMatches: () => true }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("@mobile/ui/PairingScanner", () => ({ PairingScanner: () => null }));
// The ring spinner: the connection line's is the one these tests look for.
vi.mock("@mobile/ui/Spinner", () => ({ Spinner: ({ testID }: { testID?: string }) => testID === "connection-spinner" ? <i data-spinner /> : <i data-row-spinner /> }));
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: (catalog: any) => catalog.getSnapshot() }));
vi.mock("expo-router", () => ({ useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useRouter: () => ({ navigate: vi.fn(), push: vi.fn() }), useSitemap: () => null }));
vi.mock("expo-camera", () => ({ useCameraPermissions: () => [{ granted: true }, vi.fn()], CameraView: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("@terminalx/portable/dashboard", () => ({}));
vi.mock("react-native", () => {
  const Box = ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) => <div aria-label={accessibilityLabel}>{children}</div>;
  // The top bar (#984) fades in and out; here it only needs to exist.
  const Animated = { View: Box, Value: class { constructor(public value: number) {} }, timing: () => ({ start: () => undefined, stop: () => undefined }) };
  return {
    useWindowDimensions: () => ({ width: 375, height: 667, scale: 2, fontScale: 1 }),
    Animated,
    AppState: { currentState: "active" },
    // No launch arguments: the Cloud tab reads `-openWorkspace` from them on iOS.
    Settings: { get: () => undefined },
    View: Box, Text: Box, ScrollView: Box, KeyboardAvoidingView: Box, Platform: { get OS() { return mocks.os; }, select: ({ default: fallback }: any) => fallback },
    // The spinner of the connection line, drawn so a test can see it.
    ActivityIndicator: () => <i data-spinner />,
    // The pull to refresh, drawn as a button: clicking it is the person pulling.
    RefreshControl: ({ refreshing, onRefresh }: any) => <button data-refresh data-refreshing={String(refreshing)} onClick={onRefresh}>pull</button>,
    Modal: ({ visible, children }: any) => visible ? <div data-modal>{children}</div> : null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: any) => <button disabled={disabled} aria-label={accessibilityLabel} onClick={(event) => { event.stopPropagation(); onPress?.(); }}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    TextInput: () => null,
    SectionList: ({ refreshControl, ListHeaderComponent, ListEmptyComponent, sections, renderItem }: any) => <div>{refreshControl}{ListHeaderComponent}{sections.length ? sections.flatMap((section: any) => section.data.map((item: any, index: number) => <div key={index}>{renderItem({ item })}</div>)) : ListEmptyComponent}</div>,
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  Screen: ({ children, refreshControl }: any) => <div>{refreshControl}{children}</div>,
  SectionTitle: ({ children }: any) => <div>{children}</div>,
  EmptyState: ({ title, detail, busy }: any) => <div>{busy ? <i data-empty-spinner /> : null}{title} {detail}</div>,
  StatusDot: () => <b data-dot />,
}));

const host = { id: "host-aaaa1111", label: "Paired Mac", hostName: "Studio MacBook", publicKeyB64: "k", endpoint: "ws://192.0.2.4:6768", lastConnectedAt: 1, provenance: { kind: "explicit" } };

let root: Root;
let container: HTMLDivElement;
const show = (screen: ReactNode) => act(async () => { root.render(screen); });
const refresh = () => container.querySelector<HTMLButtonElement>("[data-refresh]")!;
const spinning = () => refresh().dataset.refreshing === "true";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.app = {
    ready: true, session: { user: { userId: "u", email: "a@b.c" } }, hosts: [host], availableHosts: [], installationState: "ready", activeHost: host,
    connectionStage: "connected", connectionAttempt: 0, connectionWaiting: false, online: true, updating: false,
    sessions: [], logs: [], loadingMachines: false, error: null,
    connection: { restart: vi.fn() }, retryConnection: vi.fn(), clearError: vi.fn(), refreshMachines: vi.fn(async () => undefined), refreshSessions: vi.fn(async () => undefined),
    connectHost: vi.fn(async () => true), renameHost: vi.fn(), reconnectHost: vi.fn(), forgetHost: vi.fn(),
    api: { features: async () => ({}), onFeaturesChanged: () => () => {} },
  };
  mocks.catalog = { refresh: vi.fn(async () => undefined), watch: () => () => undefined, getSnapshot: () => ({ organizations: [], loading: false, error: null, refreshedAt: 1 }) };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("a list's spinner is the person's pull alone (#983)", () => {
  const lists: [string, () => ReactNode, (busy: boolean) => void, () => { mockImplementationOnce(run: () => Promise<void>): unknown }][] = [
    ["Sessions", () => <SessionsScreen />, (busy) => { mocks.app.updating = busy; }, () => mocks.app.refreshSessions],
    ["Machines", () => <MachinesScreen />, (busy) => { mocks.app.loadingMachines = busy; }, () => mocks.app.refreshMachines],
    ["Cloud", () => <CloudScreen />, (busy) => { mocks.catalog.getSnapshot = () => ({ organizations: [], loading: busy, error: null, refreshedAt: 1 }); }, () => mocks.catalog.refresh],
  ];
  it.each(lists)("%s: hidden during a background load, shown from a pull until that refresh ends", async (_name, screen, backgroundLoad, refresher) => {
    backgroundLoad(true);
    await show(screen());
    expect(spinning()).toBe(false);
    const pulled = deferred();
    refresher().mockImplementationOnce(() => pulled.promise);
    await act(async () => { refresh().click(); });
    expect(spinning()).toBe(true);
    // The background load ending does not end the person's refresh.
    backgroundLoad(false);
    await show(screen());
    expect(spinning()).toBe(true);
    await act(async () => { pulled.resolve(); await pulled.promise; });
    expect(spinning()).toBe(false);
  });

  it.each(lists)("%s: an empty list waiting for its first load says so without a spinner of its own", async (_name, screen, backgroundLoad) => {
    backgroundLoad(true);
    // Machines says it is loading only while no machine is paired yet (#994).
    if (_name === "Machines") Object.assign(mocks.app, { hosts: [], activeHost: null });
    // Cloud says it is loading only before its first list is read, with placeholder rows (#988).
    if (_name === "Cloud") mocks.catalog.getSnapshot = () => ({ organizations: [], loading: true, error: null, refreshedAt: null, saved: false });
    await show(screen());
    if (_name === "Cloud") expect(container.querySelector('[aria-label="Loading cloud workspaces"]')).not.toBeNull();
    else expect(container.textContent).toMatch(/Loading|Looking for your Macs/);
    expect(container.querySelector("[data-empty-spinner]")).toBeNull();
  });
});

describe("the Sessions header and the machine's row say the same (#983)", () => {
  const states: [string, object, string, boolean][] = [
    ["connecting", { connectionStage: "connecting" }, "Connecting…", true],
    ["reconnecting", { connectionStage: "cant-connect", connectionAttempt: 7 }, "Connecting…", true],
    ["updating", { connectionStage: "connected", updating: true }, "Updating…", true],
    ["connected", { connectionStage: "connected" }, "Connected", false],
    ["waiting", { connectionStage: "unreachable", connectionWaiting: true }, "Waiting for Mac…", false],
    ["offline", { connectionStage: "reconnecting", online: false }, "No internet", false],
  ];
  it.each(states)("%s", async (_name, facts, words, spinner) => {
    Object.assign(mocks.app, facts);
    for (const screen of [<SessionsScreen key="s" />, <MachinesScreen key="m" />]) {
      await show(screen);
      expect(container.textContent).toContain(words);
      expect(!!container.querySelector("[data-spinner]")).toBe(spinner);
      // None of the old words, attempt counts or addresses.
      for (const old of ["Reconnecting", "attempt", "Can’t connect", "Host unreachable", "Requesting secure credential", "Live · end-to-end", "192.0.2.4"]) expect(container.textContent).not.toContain(old);
    }
  });

  it("puts New session on the Sessions header on Android, whose tab bar has no room for it", async () => {
    await show(<SessionsScreen />);
    expect(container.querySelector("[aria-label=\"New session\"]")).toBeNull();
    mocks.os = "android";
    try {
      await show(<SessionsScreen />);
      expect(container.querySelector("[aria-label=\"New session\"]")).not.toBeNull();
    } finally {
      mocks.os = "ios";
    }
  });

  it("offers Try again on the Sessions header only once the phone has waited for the computer", async () => {
    mocks.app.connectionStage = "unreachable";
    await show(<SessionsScreen />);
    expect(container.textContent).not.toContain("Try again");
    mocks.app = { ...mocks.app, connectionWaiting: true };
    await show(<SessionsScreen />);
    const tryAgain = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => { tryAgain.click(); });
    expect(mocks.app.retryConnection).toHaveBeenCalledTimes(1);
  });

  it("keeps Disconnected on your computer and its Reconnect", async () => {
    mocks.app.connectionStage = "disconnected-on-mac";
    await show(<SessionsScreen />);
    expect(container.textContent).toContain("Disconnected on your computer");
    const reconnect = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reconnect")!;
    await act(async () => { reconnect.click(); });
    expect(mocks.app.connection.restart).toHaveBeenCalledWith("reconnect was chosen", true);
    await show(<MachinesScreen />);
    // The machine row keeps its own words for it (#994).
    expect(container.textContent).toContain("Disconnected on your computer · tap to reconnect");
  });

  it("never shows what the connection log holds: paths, addresses, raw failures", async () => {
    mocks.app.connectionStage = "cant-connect";
    mocks.app.logs = [{ id: "1", at: 1, level: "error", message: "Relay path failed", detail: "wss://relay.example.test: Host is disconnected" }, { id: "2", at: 2, level: "warning", message: "Connection attempt failed", detail: "ws://192.0.2.4:6768: no answer 3 s after Relay failed" }];
    for (const screen of [<SessionsScreen key="s" />, <MachinesScreen key="m" />]) {
      await show(screen);
      for (const raw of ["Relay path failed", "Connection attempt failed", "relay.example.test", "192.0.2.4", "Host is disconnected", "no answer"]) expect(container.textContent).not.toContain(raw);
    }
  });

  it("names a machine that is not in use by when the phone last reached it", async () => {
    mocks.app.activeHost = null;
    mocks.app.hosts = [{ ...host, lastConnectedAt: Date.now() - 3 * 60_000 }];
    await show(<MachinesScreen />);
    expect(container.textContent).toContain("Last connected 3 minutes ago");
  });
});
