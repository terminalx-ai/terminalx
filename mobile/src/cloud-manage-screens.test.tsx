// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudScreen from "../app/(tabs)/cloud";
import CloudWorkspaceScreen from "../app/cloud/[workspaceId]";
import { account } from "./cloud/testing/account";
import { operation, workspace } from "./cloud/testing/server";

// PRO-530: where launch, stop and delete are reached from the screens that were already there (25.05, 25.06).
const mocks = vi.hoisted(() => ({
  params: { workspaceId: "ws-9", orgId: "org-1" } as Record<string, string>,
  app: {} as any,
  catalog: null as any,
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  alert: vi.fn(),
  sheet: vi.fn(),
}));
vi.mock("expo-router", () => ({ Stack: { Screen: ({ options }: { options: { headerTitle?: () => ReactNode } }) => <div data-testid="screen-header">{options.headerTitle?.()}</div> }, useLocalSearchParams: () => mocks.params, useRouter: () => mocks.router, useFocusEffect: () => undefined, useSitemap: () => null }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("@mobile/cloud/CloudProvider", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: (catalog: any) => useSyncExternalStore(catalog.subscribe, catalog.getSnapshot) };
});
vi.mock("react-native", () => {
  const Box = ({ children, accessibilityLabel, testID }: { children?: ReactNode; accessibilityLabel?: string; testID?: string }) => <div aria-label={accessibilityLabel} data-testid={testID}>{children}</div>;
  const list = ({ sections, renderItem, renderSectionHeader, ListHeaderComponent }: any) => <div>{ListHeaderComponent}{sections.map((section: any) => <div key={section.key}>{renderSectionHeader?.({ section })}{section.data.map((entry: any, index: number) => <div key={index}>{renderItem({ item: entry, section, index })}</div>)}</div>)}</div>;
  return {
    View: Box, Text: Box, ScrollView: Box, KeyboardAvoidingView: Box, RefreshControl: () => null, ActivityIndicator: () => null, Keyboard: { addListener: () => ({ remove: () => undefined }), isVisible: () => false, dismiss: () => undefined },
    Animated: { View: Box, Value: class { constructor(public value: number) {} setValue() {} interpolate() { return "0deg"; } }, timing: () => ({ start: () => undefined, stop: () => undefined }), loop: () => ({ start: () => undefined, stop: () => undefined }) },
    Easing: { linear: (value: number) => value }, AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove: () => undefined }) }, Settings: { get: () => undefined, set: () => undefined },
    Alert: { alert: mocks.alert }, ActionSheetIOS: { showActionSheetWithOptions: mocks.sheet },
    Platform: { OS: "ios", select: ({ ios, default: fallback }: any) => ios ?? fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, onLongPress, disabled, accessibilityLabel, testID }: any) => <button disabled={disabled} aria-label={accessibilityLabel} data-testid={testID} onClick={onPress} onContextMenu={onLongPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    TextInput: ({ value, placeholder }: any) => <input type="text" readOnly value={value} placeholder={placeholder} />,
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent }: any) => <div>{ListHeaderComponent}{data.length ? data.map((entry: unknown, index: number) => <div key={index}>{renderItem({ item: entry })}</div>) : ListEmptyComponent}</div>,
    SectionList: list,
  };
});

let root: Root;
let container: HTMLDivElement;
let service: ReturnType<typeof account>;
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const button = (label: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent === label || entry.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
const show = async (node: ReactNode) => { await act(async () => { root.render(node); }); await pass(); };
const pass = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/**
 * The account as the server holds it, with one workspace, behind the real
 * client and catalog. The workspace's live connection is not what is under
 * test here: the page is handed a conversation with nothing in it.
 */
async function world(ws: Record<string, unknown>, op: Record<string, unknown> | null = null) {
  service = account({ workspaces: [{ workspace: workspace({ state: "ready", ...ws }), latestOperation: op ? operation(op) : null }] });
  await service.catalog.refresh();
  const snapshot = { connection: { state: ws.state === "suspended" ? "suspended" : "connected" }, problem: null, collab: { available: false, userId: "u-me", participants: [], leases: {}, notes: {} }, role: "manager", canApprove: true, hasKey: true, interrupts: false, tabs: [], outbox: [], error: null };
  const session = { subscribe: () => () => undefined, getSnapshot: () => snapshot, view: () => () => undefined, reconnect: () => undefined, typingIn: () => undefined, outbox: { isDeciding: () => false } };
  mocks.catalog = Object.assign(service.catalog, { retain: () => () => undefined, watch: () => () => undefined, opened: () => session });
  return service;
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  mocks.params = { workspaceId: "ws-9", orgId: "org-1" };
  mocks.app = { session: { user: { userId: "u-me" } }, signIn: vi.fn() };
  for (const spy of [mocks.router.push, mocks.router.replace, mocks.router.back, mocks.alert, mocks.sheet]) spy.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); service.catalog.close(); vi.useRealTimers(); });

describe("the workspace's page", () => {
  it("shows the launch it was opened on until the workspace runs, then the workspace itself", async () => {
    await world({ state: "provisioning" }, { state: "running", stage: "creating-machine" });
    mocks.params = { workspaceId: "ws-9", orgId: "org-1", operationId: "op-9", title: "Checkout redesign" };
    await show(<CloudWorkspaceScreen />);
    expect(byId("launch-head")!.textContent).toBe("Launching…");
    expect(byId("workspace-state-line")).toBeNull();
    service.advance("op-9", { state: "succeeded", stage: "ready", cancelable: false }, { state: "ready" });
    await pass(3_000);
    expect(byId("launch-head")!.textContent).toBe("Checkout redesign is running");
    await pass(1_200);
    // Straight into the workspace: the launch view is gone, with no tap.
    expect(byId("launch-head")).toBeNull();
    expect(byId("workspace-state-line")).not.toBeNull();
  });

  it("shows a launch the list says is under way, without being told which operation", async () => {
    await world({ state: "provisioning" }, { state: "running", stage: "bootstrapping", cancelable: false });
    await show(<CloudWorkspaceScreen />);
    expect(byId("launch-head")!.textContent).toBe("Launching…");
    expect(byId("operation-stage-3")!.getAttribute("aria-label")).toBe("Installing the runtime, in progress");
  });

  it("shows a launch that failed part-way with what can be done, and opens the delete page from it", async () => {
    await world({ state: "attention-required" }, { state: "failed", stage: "bootstrapping", cancelable: false, errorCode: "bootstrap_failed" });
    await show(<CloudWorkspaceScreen />);
    expect(byId("launch-head")!.textContent).toBe("The launch failed");
    await act(async () => { button("Delete workspace…")!.click(); });
    expect(mocks.router.push).toHaveBeenCalledWith({ pathname: "/cloud/delete", params: { orgId: "org-1", workspaceId: "ws-9" } });
  });

  it("does not take a workspace that needs attention for another reason as a launch", async () => {
    await world({ state: "attention-required" }, { type: "lifecycle", action: "resume", state: "failed", cancelable: false, errorCode: "cloud_provider_unavailable" });
    await show(<CloudWorkspaceScreen />);
    expect(byId("launch-head")).toBeNull();
    expect(byId("workspace-state-line")).not.toBeNull();
  });

  it("puts Stop and Delete behind one more button for a manager, with the role in one word beside the two buttons", async () => {
    await world({});
    await show(<CloudWorkspaceScreen />);
    expect(button("Sharing")).toBeDefined();
    expect(byId("workspace-state-line")!.textContent).toMatch(/ · Manager$/);
    await act(async () => { button("Workspace actions")!.click(); });
    const [sheet, choose] = mocks.sheet.mock.calls[0];
    expect(sheet.options).toEqual(["Stop workspace", "Delete workspace…", "Cancel"]);
    expect(sheet.destructiveButtonIndex).toEqual([1]);
    await act(async () => { choose(1); });
    expect(mocks.router.push).toHaveBeenCalledWith({ pathname: "/cloud/delete", params: { orgId: "org-1", workspaceId: "ws-9" } });
  });

  it("offers no such button to someone who does not manage the workspace", async () => {
    await world({ you: { role: "driver", canApprove: true, canManageShares: false } });
    await show(<CloudWorkspaceScreen />);
    expect(button("Workspace actions")).toBeUndefined();
  });

  it("says the workspace is stopping where the composer was", async () => {
    await world({}, { type: "lifecycle", action: "suspend", state: "running", cancelable: false });
    await show(<CloudWorkspaceScreen />);
    expect(byId("stop-bar")!.textContent).toBe("Stopping the workspace…Saving the workspace, then suspending the machine.Stopping…");
    expect(button("Stopping…")!.disabled).toBe(true);
    expect(container.querySelector("input")).toBeNull();
  });

  it("says a stop did not happen, that it may still bill, and retries it", async () => {
    await world({ state: "attention-required" }, { type: "lifecycle", action: "suspend", state: "failed", cancelable: false, errorCode: "cloud_provider_unavailable" });
    await show(<CloudWorkspaceScreen />);
    expect(byId("stop-bar")!.textContent).toBe("It did not stopThe provider could not be reached. It may be down or blocking requests. It may still be running, and billing.Retry stop");
    await act(async () => { button("Retry stop")!.click(); });
    await pass();
    expect(service.sent("POST", "/cloud-workspaces/ws-9/suspend")).toHaveLength(1);
    expect(byId("stop-bar")!.textContent).toContain("Stopping the workspace…");
  });
});

describe("the Cloud tab", () => {
  it("launches from + beside the title", async () => {
    await world({});
    await show(<CloudScreen />);
    await act(async () => { button("New workspace")!.click(); });
    expect(mocks.router.push).toHaveBeenCalledWith("/cloud/new");
  });
});
