// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudScreen from "../app/(tabs)/cloud";
import { CloudApiError } from "@mobile/cloud/api";
import { workspaceRowActions } from "@mobile/cloud/setup/workspace/actions";

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
// The real row actions (25.06), watched: a long press offers them beside Pin project.
vi.mock("@mobile/cloud/setup/workspace/actions", async (actual) => {
  const real = await actual<typeof import("@mobile/cloud/setup/workspace/actions")>();
  return { ...real, workspaceRowActions: vi.fn(real.workspaceRowActions) };
});
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
    // 25.01 replaces "No cloud workspaces you can see.": a member of an organization with no compute is told why.
    Object.assign(mocks.catalog.api, { providers: vi.fn(async () => []), credentials: vi.fn(async () => []) });
    await show(<CloudScreen />);
    expect(text()).toContain("Acme has no compute yet");
    expect(text()).toContain("An organization owner or admin must connect compute. You can launch a workspace once they have.");
    // A member is not asked for the organization's agent logins.
    expect(mocks.catalog.api.credentials).not.toHaveBeenCalled();
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

describe("the first run on the Cloud tab (25.01)", () => {
  const personal = { orgId: "org-personal", name: "Personal (alex@example.com)", role: "owner", isPersonal: true };
  const northwind = { orgId: "org-northwind", name: "Northwind", role: "member" };
  const entry = (organization: object, workspaces: unknown[] = []) => ({ organization, workspaces, error: null, loaded: true });
  const descriptor = (keyed: boolean) => ({ credentialFields: keyed ? [{ name: "credential", kind: "secret", label: "API token" }] : [] });
  const boat = (availability: string) => ({ id: "box", displayName: "Boat", availability, canManage: true, descriptor: descriptor(true) });
  const login = (provider: string, state = "connected") => ({ id: `cred-${provider}`, provider, authKind: "api-key", fingerprint: "sha256:1", version: 1, updatedAt: 1, state, sharedUse: "organization", epoch: 1 });
  const unreachable = () => new CloudApiError("cloud_workspace_unavailable", null, "network");

  /** The account as the server answers it: its organizations, and each one's providers and agent logins. */
  function account(organizations: unknown[], answers: { providers?: () => Promise<unknown[]>; credentials?: () => Promise<unknown[]>; snapshot?: Record<string, unknown> } = {}) {
    world();
    mocks.catalog.getSnapshot = () => ({ loading: false, error: null, refreshedAt: 1, saved: false, titles: {}, deletesOrganizations: false, createsOrganizations: true, organizations, ...answers.snapshot });
    Object.assign(mocks.catalog.api, { providers: vi.fn(answers.providers ?? (async () => [])), credentials: vi.fn(answers.credentials ?? (async () => [])) });
  }
  const settle = () => act(async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); });
  const draw = async () => { await show(<CloudScreen />); await settle(); };
  /** The steps as they are said aloud, in order: a step that opens a page is a button. */
  const steps = () => [...container.querySelectorAll('[aria-label^="Step "]')].map((step) => step.getAttribute("aria-label"));
  const card = () => container.querySelector('[aria-label^="Step 1 of 4"]');

  it("signed out: as today, with no line about creating an account", async () => {
    mocks.app = { session: null, signIn: vi.fn() };
    await draw();
    expect(text()).toContain("Sign in for cloud workspaces");
    expect(text()).not.toContain("New to TerminalX?");
    expect(button("Sign in").disabled).toBe(false);
  });

  it("reading the list: the title and placeholder rows, nothing else", async () => {
    account([], { snapshot: { refreshedAt: null, loading: true } });
    await draw();
    expect(container.querySelector('[data-testid="cloud-placeholders"]')).not.toBeNull();
    expect(text()).not.toContain("Four steps set one up.");
  });

  it("signed in, nothing set up: the intro and four steps, step 1 next, and Start setup", async () => {
    account([entry(personal)]);
    await draw();
    expect(text()).toContain("A cloud workspace is a machine where your agents keep working while your phone is in your pocket. Four steps set one up.");
    expect(steps()).toEqual([
      "Step 1 of 4, next: Organization. Workspaces belong to an organization. Yours is Personal (alex@example.com).",
      "Step 2 of 4, not started: Connect compute. The provider account your workspaces run on.",
      "Step 3 of 4, not started: Sign your agents in. What Codex, Claude Code and Cursor sign in with there.",
      "Step 4 of 4, not started: Launch a workspace. Pick a size, see the price, start working.",
    ]);
    // Each list is read once, and reading starts nothing.
    expect(mocks.catalog.api.providers).toHaveBeenCalledWith("org-personal");
    expect(mocks.catalog.api.credentials).toHaveBeenCalledWith("org-personal");
    expect(mocks.catalog.start).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Launch a workspace"]')).toBeNull();
    await click("Start setup");
    expect(mocks.push).toHaveBeenCalledWith("/cloud/setup/organization?orgId=org-personal");
  });

  it("came back half-way: finished steps say what they hold, and the button names the next step", async () => {
    account([entry(personal)], { providers: async () => [boat("available")] });
    await draw();
    expect(text()).toContain("Personal (alex@example.com)Organization");
    expect(text()).not.toContain("Four steps set one up.");
    expect(steps()).toEqual([
      "Step 1 of 4, done: Organization. Personal (alex@example.com)",
      "Step 2 of 4, done: Connect compute. Boat · connected",
      "Step 3 of 4, next: Sign your agents in. What Codex, Claude Code and Cursor sign in with there.",
      "Step 4 of 4, not started: Launch a workspace. Pick a size, see the price, start working.",
    ]);
    await click("Step 2 of 4, done: Connect compute. Boat · connected");
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/compute?orgId=org-personal");
    await click("Continue: sign your agents in");
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/logins?orgId=org-personal");
  });

  it("ready to launch: + appears in the title, and both launch for the organization", async () => {
    account([entry(personal)], { providers: async () => [boat("available")], credentials: async () => [login("codex"), login("claude", "sign-in-required"), login("github")] });
    await draw();
    expect(steps()[2]).toBe("Step 3 of 4, done: Sign your agents in. Codex · connected");
    expect(steps()[3]).toBe("Step 4 of 4, next: Launch a workspace. Pick a size, see the price, start working.");
    const launches = [...container.querySelectorAll("button")].filter((entry) => entry.textContent === "Launch a workspace" || entry.getAttribute("aria-label") === "Launch a workspace");
    expect(launches).toHaveLength(2);
    for (const launch of launches) {
      await act(async () => { launch.click(); });
      expect(mocks.push).toHaveBeenLastCalledWith("/cloud/launch?orgId=org-personal");
    }
  });

  it("with workspaces: the list, an organization being set up folded to one row, + and the long press's Stop and Delete", async () => {
    const running = { ...item("ws-checkout", { orgId: "org-northwind", name: "Checkout redesign", you: { role: "manager", canApprove: true } }).workspace };
    account([entry(northwind, [{ workspace: running, latestOperation: null }]), entry(personal)], { providers: async () => [boat("available")] });
    await draw();
    expect(text()).toContain("Northwind");
    const fold = button("Set up cloud workspaces, 2 of 4 steps done");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(text()).toContain("Personal (alex@example.com)Set up cloud workspaces2 of 4 steps done");
    expect(card()).toBeNull();
    await click("Set up cloud workspaces, 2 of 4 steps done");
    expect(card()).not.toBeNull();
    // Only the organization without workspaces is read for its setup.
    expect(mocks.catalog.api.providers).toHaveBeenCalledTimes(1);
    await click("Launch a workspace");
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/launch?orgId=org-northwind");
    const offered = vi.mocked(workspaceRowActions).mock.results.at(-1)!.value as { label: string }[];
    expect(offered.map((action) => action.label)).toEqual(["Stop workspace", "Delete workspace…"]);
  });

  it("a member, not an admin: the console's sentence for an organization with no compute, and no chevron on an admin's steps", async () => {
    account([entry(northwind), entry({ ...personal })], { providers: async () => [] });
    await draw();
    expect(text()).toContain("NorthwindNorthwind has no compute yetAn organization owner or admin must connect compute. You can launch a workspace once they have.");
    // The personal organization is the one set up; the member's organization is read for its compute only.
    expect(mocks.catalog.api.credentials).not.toHaveBeenCalledWith("org-northwind");
    expect(mocks.catalog.api.providers).toHaveBeenCalledWith("org-northwind");
    expect(steps()[0]).toBe("Step 1 of 4, next: Organization. Workspaces belong to an organization. Yours is Personal (alex@example.com).");
  });

  it("a member's own organization: steps 2 and 3 are not buttons for them", async () => {
    account([entry(northwind)], { providers: async () => [{ ...boat("available"), canManage: false }] });
    await draw();
    expect(container.querySelector('button[aria-label^="Step 2 of 4"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Step 3 of 4"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Step 2 of 4, done: Connect compute. Boat · connected"]')).not.toBeNull();
    expect(text()).not.toContain("has no compute yet");
    await click("Launch a workspace");
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/launch?orgId=org-northwind");
  });

  it("a connected key stopped working: the step turns red and the button goes to the key", async () => {
    account([entry(personal)], { providers: async () => [boat("attention-required")], credentials: async () => [login("codex")] });
    await draw();
    expect(steps()).toEqual([
      "Step 1 of 4, done: Organization. Personal (alex@example.com)",
      "Step 2 of 4, needs attention: Connect compute. Boat rejected the stored key on its last check.",
      "Step 3 of 4, done: Sign your agents in. Codex · connected",
      "Step 4 of 4, not started: Launch a workspace. Waits for compute.",
    ]);
    expect(container.querySelector('[aria-label="Launch a workspace"]')).toBeNull();
    await click("Fix the provider key");
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/compute/box?orgId=org-personal");
  });

  it("no network: the warning line, the steps read before, and the button off", async () => {
    account([entry(personal)], { providers: async () => [boat("available")] });
    await draw();
    // The organization list could not be read again: what was read stays, and the steps with it.
    mocks.catalog.getSnapshot = () => ({ loading: false, error: "cloud_workspace_unavailable", refreshedAt: 1, saved: false, titles: {}, createsOrganizations: true, organizations: [entry(personal)] });
    mocks.catalog.api.providers.mockImplementation(async () => { throw unreachable(); });
    mocks.catalog.api.credentials.mockImplementation(async () => { throw unreachable(); });
    await show(<CloudScreen />);
    await settle();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("The service could not be reached. What is shown may be out of date.");
    expect(steps()[1]).toBe("Step 2 of 4, done: Connect compute. Boat · connected");
    expect(button("Continue: sign your agents in").disabled).toBe(true);
    expect(text()).toContain("Setup carries on when the phone is back online. Nothing you finished is lost.");
  });

  it("a step could not be read: no step is done or missing on a guess, and there is no button", async () => {
    account([entry(personal)], { providers: async () => { throw unreachable(); }, credentials: async () => { throw unreachable(); } });
    await draw();
    expect(steps()).toEqual([
      "Step 1 of 4, next: Organization. Workspaces belong to an organization. Yours is Personal (alex@example.com).",
      "Step 2 of 4, needs attention: Connect compute. Could not be read. Pull down to try again.",
      "Step 3 of 4, needs attention: Sign your agents in. Could not be read. Pull down to try again.",
      "Step 4 of 4, not started: Launch a workspace. Pick a size, see the price, start working.",
    ]);
    expect(text()).toContain("Pull down to read it again.");
    expect(container.querySelector("button[aria-label=\"Start setup\"]")).toBeNull();
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Start setup")).toBe(false);
  });

  it("an account with no organization: step 1 creates one where the server takes it, and otherwise says where", async () => {
    account([]);
    await draw();
    expect(steps()[0]).toBe("Step 1 of 4, next: Organization. Workspaces belong to an organization.");
    // Never a personal organization the server did not list.
    expect(text()).not.toContain("Personal");
    await click("Start setup");
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/setup/new-organization");

    account([], { snapshot: { createsOrganizations: false } });
    await draw();
    expect(text()).toContain("To create an organization, use the TerminalX desktop app or the web console. Your account service does not take it from the phone yet.");
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Start setup")).toBe(false);
    expect(container.querySelector('button[aria-label^="Step 1 of 4"]')).toBeNull();
  });
});
