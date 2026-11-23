// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudScreen from "../app/(tabs)/cloud";

const mocks = vi.hoisted(() => ({
  params: { workspaceId: "ws-1", orgId: "org-1" } as Record<string, string>,
  app: {} as any,
  catalog: null as any,
  listProps: {} as any,
  push: vi.fn(),
  alert: vi.fn(),
  focus: [] as (() => void | (() => void))[],
}));
vi.mock("expo-router", () => ({
  // The header as the stack draws it: its title, or the screen's own title view, and what is on its right.
  Stack: { Screen: ({ options }: { options: { title: string; headerTitle?: () => ReactNode; headerRight?: () => ReactNode } }) => <div data-testid="screen-header"><div data-testid="screen-title">{options.title}</div>{options.headerTitle ? <div data-testid="header-title">{options.headerTitle()}</div> : null}{options.headerRight ? <div data-testid="header-right">{options.headerRight()}</div> : null}</div> },
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ push: mocks.push }),
  useFocusEffect: (run: () => void | (() => void)) => { mocks.focus.push(run); },
}));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: (catalog: any) => catalog?.getSnapshot() ?? { organizations: [], loading: false, error: null, refreshedAt: null, saved: false, titles: {} } }));
vi.mock("react-native", () => {
  const Box = ({ children, accessibilityRole, accessibilityLabel, testID }: { children?: ReactNode; accessibilityRole?: string; accessibilityLabel?: string; testID?: string }) => <div role={accessibilityRole === "alert" ? "alert" : accessibilityRole === "progressbar" ? "progressbar" : undefined} aria-label={accessibilityLabel} data-testid={testID}>{children}</div>;
  return {
    View: Box, Text: Box, ScrollView: Box, KeyboardAvoidingView: Box, RefreshControl: () => null, Keyboard: { addListener: () => ({ remove: () => undefined }), isVisible: () => false, dismiss: () => undefined },
    Animated: { View: Box, Value: class { constructor(public value: number) {} }, timing: () => ({ start: () => undefined, stop: () => undefined }) },
    Alert: { alert: mocks.alert },
    Switch: ({ value, onValueChange, disabled, accessibilityLabel }: any) => <input type="checkbox" aria-label={accessibilityLabel} checked={value} disabled={disabled} onChange={(event) => onValueChange(event.currentTarget.checked)} />,
    Platform: { OS: "web", select: ({ default: fallback }: any) => fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState, style, hitSlop }: any) => <button disabled={disabled} aria-label={accessibilityLabel} data-hitslop={hitSlop} aria-pressed={accessibilityState?.selected} aria-expanded={accessibilityState?.expanded} data-style={JSON.stringify([typeof style === "function" ? style({ pressed: false }) : style].flat(3).filter(Boolean).reduce((all: object, entry: object) => ({ ...all, ...entry }), {}))} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    TextInput: ({ value, onChangeText, placeholder, editable, accessibilityLabel }: any) => <input type="text" aria-label={accessibilityLabel} value={value} disabled={editable === false} onInput={(event) => onChangeText(event.currentTarget.value)} placeholder={placeholder} />,
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...rest }: any) => (mocks.listProps = { data, ...rest }) && <div>{ListHeaderComponent}{data.length ? data.map((item: unknown, index: number) => <div key={index}>{renderItem({ item })}</div>) : ListEmptyComponent}{ListFooterComponent}</div>,
    SectionList: ({ sections, renderItem, renderSectionHeader, renderSectionFooter, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, contentContainerStyle }: any) => (mocks.listProps = { sections, contentContainerStyle }) && <div>{ListHeaderComponent}{sections.length ? sections.map((section: any) => <div key={section.key} data-testid="cloud-section">{renderSectionHeader({ section })}{section.data.map((item: any, index: number) => <div key={item.workspace.id}>{renderItem({ item, index, section })}</div>)}{renderSectionFooter?.({ section })}</div>) : ListEmptyComponent}{ListFooterComponent}</div>,
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled, accessibilityLabel }: any) => <button disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  EmptyState: ({ title, detail }: any) => <div>{title} {detail}</div>, StatusDot: () => null,
  Screen: ({ children }: any) => <div>{children}</div>, SectionTitle: ({ children }: any) => <h2>{children}</h2>,
}));

let root: Root;
let container: HTMLDivElement;
let counter = 0;

const event = (seq: number, payload: Record<string, unknown>) => ({ id: `e${seq}`, sessionId: "s1", tabId: "t1", harness: "claude", seq, ts: "2026-10-03T00:00:00Z", payload });
const item = (id: string, fields: Record<string, unknown> = {}) => ({ workspace: { id, orgId: "org-1", name: id, provider: "box", state: "ready", you: { role: "driver", canApprove: false }, ...fields }, latestOperation: null });

const NAMES: Record<string, string> = { "u-alice": "Alice", "u-bob": "Bob" };

function world(options: { state?: string | null; role?: string | null; canApprove?: boolean; hasKey?: boolean; events?: unknown[]; outbox?: unknown[]; connection?: string; noKey?: boolean; continuous?: boolean; tabs?: number; access?: string; problem?: unknown; collab?: Record<string, unknown>; interrupts?: boolean } = {}) {
  const state = options.state === undefined ? "ready" : options.state;
  const snapshot = {
    connection: { state: options.connection ?? (state === "ready" ? "connected" : "suspended") },
    problem: options.problem ?? null,
    collab: { available: false, userId: "u-me", participants: [], leases: {}, notes: {}, ...options.collab },
    role: options.role === undefined ? "driver" : options.role,
    canApprove: options.canApprove ?? false,
    hasKey: options.hasKey ?? true,
    interrupts: options.interrupts ?? false,
    tabs: Array.from({ length: options.tabs ?? 1 }, (_, index) => ({ tabId: index ? `t${index + 1}` : "t1", sessionId: "s1", title: index ? `Second ${index}` : "Fix login", status: "in_progress", source: "live", pendingPermissions: [], events: index ? [] : (options.events ?? [event(1, { type: "user_message", text: "run the tests", queued: false })]), truncated: false, noKey: options.noKey ?? false, continuous: options.continuous ?? false })),
    outbox: options.outbox ?? [],
    error: null,
  };
  const session = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    view: vi.fn(() => () => undefined),
    send: vi.fn(async () => ({})),
    stop: vi.fn(async () => ({})),
    interrupt: vi.fn(async () => true),
    decide: vi.fn(async () => ({})),
    cancel: vi.fn(async () => undefined),
    typingIn: vi.fn(),
    postNote: vi.fn(async () => ({})),
    takeWheel: vi.fn(async () => undefined),
    releaseWheel: vi.fn(async () => undefined),
    takeOverWheel: vi.fn(async () => undefined),
    deliverHeld: vi.fn(async () => undefined),
    reconnect: vi.fn(),
    outbox: { isDeciding: () => false },
  };
  const release = vi.fn();
  const unwatch = vi.fn();
  const listed = state === null ? null : item(mocks.params.workspaceId, { name: "fix-login", state }).workspace;
  const organizations = [{ organization: { orgId: "org-1", name: "Acme", role: "member" }, workspaces: listed ? [{ workspace: listed, latestOperation: null }] : [], error: null, loaded: true }];
  mocks.catalog = {
    getSnapshot: () => ({ organizations, loading: false, error: null, refreshedAt: 1, saved: false, titles: {} }),
    start: vi.fn(async () => "started"),
    refresh: vi.fn(async () => undefined),
    watch: vi.fn(() => unwatch),
    workspace: () => listed,
    access: () => options.access ?? (listed ? (options.role === "none" ? "not-shared" : "ok") : "gone"),
    retain: vi.fn(() => release),
    opened: () => session,
    people: { subscribe: () => () => undefined, getVersion: () => 1, name: (userId: string | null | undefined) => NAMES[userId ?? ""] ?? "Someone", roster: vi.fn(async () => [{ userId: "u-me", email: "me@example.com", role: "admin" }, { userId: "u-alice", email: "alice@example.com", displayName: "Alice", role: "member" }, { userId: "u-bob", email: "bob@example.com", displayName: "Bob", role: "member" }]), remember: vi.fn() },
    api: { shares: vi.fn(), putShare: vi.fn(async () => ({})), revokeShare: vi.fn(async () => undefined) },
  };
  return { session, release, snapshot };
}

const text = () => container.textContent ?? "";
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent === label || entry.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
};
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const show = async (node: ReactNode) => { await act(async () => { root.render(node); }); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // Drafts are kept per tab for the life of the app; each test gets its own workspace.
  mocks.params = { workspaceId: `ws-${++counter}`, orgId: "org-1" };
  mocks.app = { session: { user: { userId: "u-me" } }, signIn: vi.fn() };
  mocks.push.mockClear();
  mocks.alert.mockClear();
  mocks.focus.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("the Cloud tab", () => {
  const listing = (organizations: unknown[], fields: Record<string, unknown> = {}) => { mocks.catalog.getSnapshot = () => ({ loading: false, error: null, refreshedAt: 1, saved: false, titles: {}, organizations, ...fields }); };
  const organization = (orgId: string, name: string, workspaces: unknown[], error: string | null = null) => ({ organization: { orgId, name, role: "member" }, error, loaded: true, workspaces });

  it("lists each workspace with its status, provider, repository and branch, and only reads", async () => {
    world();
    const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
    listing([
      organization("org-1", "Acme", [
        item("fix-login", { provider: "new-compute", providerDescriptor: { label: "New Compute" }, runtimeActivity: { pendingApprovals: 1 }, lastActivityAt: minutesAgo(6), repositories: [{ fullName: "acme/web", primary: true }], launch: { workBranch: "tx/fix-login" } }),
        item("old-work", { provider: "unlabelled-compute", providerDescriptor: { label: 42 }, state: "suspended", you: { role: "viewer", canApprove: false }, sharedWith: 3 }),
        item("warm-up", { state: "suspended", lastActivityAt: minutesAgo(2 * 24 * 60 + 5) }),
      ]),
      organization("org-2", "Beta", [], "cloud_provider_unavailable"),
    ]);
    await show(<CloudScreen />);
    expect(text()).toContain("Acme");
    const row = button("fix-login, Needs your answer, Can send, New Compute");
    expect(row.textContent).toBe("fix-loginNeeds your answer · 6mNew Compute · acme/web · tx/fix-login");
    expect(button("old-work, Stopped, View only, Shared with 3, unlabelled-compute").textContent).toBe("old-workStoppedunlabelled-compute");
    // Days, where the status has room for them, as 22.06 says them.
    expect(button("warm-up, Stopped, Can send, box").textContent).toBe("warm-upStopped · 2 days agobox");
    expect(text()).toContain("The cloud provider is not answering right now.");
    // Coming to the tab reads the list, and keeps reading it now and then until the tab is left; nothing else is asked for.
    const leave = mocks.focus.at(-1)!();
    expect(mocks.catalog.refresh).toHaveBeenCalled();
    expect(mocks.catalog.watch).toHaveBeenCalledTimes(1);
    expect(leave).toBe(mocks.catalog.watch.mock.results[0].value);
    expect(mocks.catalog.retain).not.toHaveBeenCalled();
    expect(mocks.catalog.start).not.toHaveBeenCalled();
    await click("old-work, Stopped, View only, Shared with 3, unlabelled-compute");
    expect(mocks.push).toHaveBeenCalledWith({ pathname: "/cloud/[workspaceId]", params: { workspaceId: "old-work", orgId: "org-1", title: "old-work" } });
  });

  it("puts organizations with workspaces first and folds the empty ones into one row that opens their names (#988)", async () => {
    world();
    listing([
      organization("personal", "Personal", []),
      organization("org-1", "Acme", [item("a1")]),
      organization("e1", "E2E Box", []),
      organization("org-2", "Northwind", [item("n1", { orgId: "org-2" })]),
      organization("e2", "E2E Video", []),
      organization("e3", "E2E Isolated", []),
      organization("e4", "Sandbox", []),
    ]);
    await show(<CloudScreen />);
    const sections = [...container.querySelectorAll('[data-testid="cloud-section"]')].map((section) => section.textContent!.split(/a1|n1/)[0]);
    expect(sections).toEqual(["Acme", "Northwind"]);
    expect(text()).not.toContain("No cloud workspaces you can see.");
    expect(text()).not.toContain("E2E Box");
    const folded = button("5 organizations with no workspaces");
    expect(folded.getAttribute("aria-expanded")).toBe("false");
    // One row in total for the five, at the end of the list (the top bar, #984, is drawn after it).
    const list = container.querySelector('[data-testid="top-bar"]')!.previousElementSibling!;
    expect(list.textContent!.endsWith("5 organizations with no workspaces")).toBe(true);
    await click("5 organizations with no workspaces");
    expect(button("5 organizations with no workspaces").getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("PersonalE2E BoxE2E VideoE2E IsolatedSandbox");
  });

  it("never shows a blank page: placeholder rows under the title on a first load, the kept list on a later one (#988)", async () => {
    world();
    // Nothing read yet and nothing kept on the phone.
    listing([], { loading: true, refreshedAt: null });
    await show(<CloudScreen />);
    expect(text().startsWith("Cloud")).toBe(true);
    const placeholders = container.querySelector('[data-testid="cloud-placeholders"]')!;
    expect(placeholders.getAttribute("aria-label")).toBe("Loading cloud workspaces");
    // A heading bar, then a card of three rows in the list's shape.
    expect(placeholders.children).toHaveLength(2);
    expect(placeholders.children[1].children).toHaveLength(3);
    // The title is placed under the status bar by the list itself, not by a later inset adjustment.
    expect(mocks.listProps.contentContainerStyle).toContainEqual(expect.objectContaining({ paddingTop: 47 + 6 }));

    // Before the catalog exists (just signed in): the same placeholders, not a blank page.
    mocks.catalog = null;
    await show(<CloudScreen />);
    expect(container.querySelector('[data-testid="cloud-placeholders"]')).not.toBeNull();

    // A list kept from before is shown while it is read again, with the titles learned for it.
    world();
    listing([organization("org-1", "Acme", [item("ws-9", { state: "suspended" })])], { loading: true, refreshedAt: null, saved: true, titles: { "org-1/ws-9": "Checkout redesign" } });
    await show(<CloudScreen />);
    expect(container.querySelector('[data-testid="cloud-placeholders"]')).toBeNull();
    expect(button("Checkout redesign, Stopped, Can send, box")).toBeTruthy();
    expect(text()).not.toContain("ws-9");
    await click("Checkout redesign, Stopped, Can send, box");
    expect(mocks.push).toHaveBeenCalledWith({ pathname: "/cloud/[workspaceId]", params: { workspaceId: "ws-9", orgId: "org-1", title: "Checkout redesign" } });
  });

  it("says when there is nothing to see, and asks a signed-out person to sign in", async () => {
    world({ state: null });
    await show(<CloudScreen />);
    expect(text()).toContain("No cloud workspaces you can see.");
    expect(text()).toContain("1 organization with no workspaces");
    mocks.app = { session: null, signIn: vi.fn() };
    await show(<CloudScreen />);
    await click("Sign in");
    expect(mocks.app.signIn).toHaveBeenCalled();
  });

  it("says why sign-in failed, under the button", async () => {
    mocks.app = { session: null, signIn: vi.fn(), error: "The sign-in page could not open: error 2." };
    await show(<CloudScreen />);
    expect(text()).toContain("The sign-in page could not open: error 2.");
  });
});
