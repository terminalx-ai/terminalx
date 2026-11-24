// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudWorkspaceScreen from "../app/cloud/[workspaceId]";
import CloudSharesScreen from "../app/cloud/shares";
import DeleteWorkspaceScreen from "../app/cloud/delete";
import { CloudApiError } from "./cloud/api";
import { ResumeUnconfirmed } from "./cloud/resume";

const mocks = vi.hoisted(() => ({
  params: { workspaceId: "ws-1", orgId: "org-1" } as Record<string, string>,
  app: {} as any,
  catalog: null as any,
  listProps: {} as any,
  push: vi.fn(),
  back: vi.fn(),
  dismissTo: vi.fn(),
  alert: vi.fn(),
  focus: [] as (() => void | (() => void))[],
}));
vi.mock("expo-router", () => ({
  // The header as the stack draws it: its title, or the screen's own title view, and what is on its right.
  Stack: { Screen: ({ options }: { options: { title: string; headerTitle?: () => ReactNode; headerRight?: () => ReactNode } }) => <div data-testid="screen-header"><div data-testid="screen-title">{options.title}</div>{options.headerTitle ? <div data-testid="header-title">{options.headerTitle()}</div> : null}{options.headerRight ? <div data-testid="header-right">{options.headerRight()}</div> : null}</div> },
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ push: mocks.push, back: mocks.back, dismissTo: mocks.dismissTo }),
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
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
    Switch: ({ value, onValueChange, disabled, accessibilityLabel }: any) => <input type="checkbox" aria-label={accessibilityLabel} checked={value} disabled={disabled} onChange={(event) => onValueChange(event.currentTarget.checked)} />,
    Platform: { OS: "web", select: ({ default: fallback }: any) => fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState, style, hitSlop }: any) => <button disabled={disabled} aria-label={accessibilityLabel} data-hitslop={hitSlop} aria-pressed={accessibilityState?.selected} aria-expanded={accessibilityState?.expanded} data-style={JSON.stringify([typeof style === "function" ? style({ pressed: false }) : style].flat(3).filter(Boolean).reduce((all: object, entry: object) => ({ ...all, ...entry }), {}))} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    TextInput: ({ value, onChangeText, placeholder, editable, accessibilityLabel }: any) => <input type="text" aria-label={accessibilityLabel} value={value} disabled={editable === false} onInput={(event) => onChangeText(event.currentTarget.value)} placeholder={placeholder} />,
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...rest }: any) => (mocks.listProps = { data, ...rest }) && <div>{ListHeaderComponent}{data.length ? data.map((item: unknown, index: number) => <div key={index}>{renderItem({ item })}</div>) : ListEmptyComponent}{ListFooterComponent}</div>,
    SectionList: ({ sections, renderItem, renderSectionHeader, renderSectionFooter, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, contentContainerStyle }: any) => (mocks.listProps = { sections, contentContainerStyle }) && <div>{ListHeaderComponent}{sections.length ? sections.map((section: any) => <div key={section.key} data-testid="cloud-section">{renderSectionHeader({ section })}{section.data.map((item: any, index: number) => <div key={item.workspace.id}>{renderItem({ item, index, section })}</div>)}{renderSectionFooter?.({ section })}</div>) : ListEmptyComponent}{ListFooterComponent}</div>,
  };
});
vi.mock("@mobile/ui/Spinner", () => ({ Spinner: () => null }));
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
/** A provider as the server describes it (placeholder words, as the boards' example). */
const BOAT = { id: "box", displayName: "Boat", availability: "available", canManage: false, descriptor: { id: "box", label: "Boat", icon: "box", order: 1, description: "", billing: "Per second, billed by Boat.", billedByProvider: true, listed: true, credentialSource: "organization", credentialFields: [], capabilities: { pauseResumeWithMemory: true, stopStart: true, snapshots: true, exec: true, computeRunsUntilStopped: true }, offering: { locations: "", sources: "", machineClasses: "", pricingSource: "", suspendedBilling: "" }, allowedIdleSuspendMinutes: [], allowedRetentionDays: [] } };

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
    fresh: vi.fn(async () => true),
    api: {
      shares: vi.fn(), putShare: vi.fn(async () => ({})), revokeShare: vi.fn(async () => undefined),
      providers: vi.fn(async () => [BOAT]),
      operation: vi.fn(async () => { throw new CloudApiError("cloud_workspace_operation_not_found", 404); }),
      cancelOperation: vi.fn(async () => { throw new CloudApiError("cloud_workspace_operation_not_found", 404); }),
      suspend: vi.fn(async () => { throw new CloudApiError("cloud_workspace_unavailable", 503); }),
      deleteWorkspace: vi.fn(async () => { throw new CloudApiError("cloud_workspace_unavailable", 503); }),
    },
  };
  return { session, release, snapshot };
}

const text = () => container.textContent ?? "";
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent === label || entry.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
};
const stateLine = () => container.querySelector('[data-testid="workspace-state-line"]')!;
const startBar = () => container.querySelector('[data-testid="start-bar"]')!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const type = async (value: string, placeholder?: string) => { await act(async () => { const field = (placeholder ? container.querySelector(`input[placeholder="${placeholder}"]`) : container.querySelector('input[type="text"]')) as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); };
const show = async (node: ReactNode) => { await act(async () => { root.render(node); }); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // Drafts are kept per tab for the life of the app; each test gets its own workspace.
  mocks.params = { workspaceId: `ws-${++counter}`, orgId: "org-1" };
  mocks.app = { session: { user: { userId: "u-me" } }, signIn: vi.fn() };
  mocks.push.mockClear();
  mocks.back.mockClear();
  mocks.dismissTo.mockClear();
  mocks.alert.mockClear();
  mocks.focus.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("a cloud workspace screen", () => {
  it("interrupts with Stop, and ends the agent's process only when that went unanswered", async () => {
    const { session, snapshot } = world({ interrupts: true });
    await show(<CloudWorkspaceScreen />);
    await click("Stop the agent");
    expect(session.interrupt).toHaveBeenCalledWith("t1");
    expect(session.stop).not.toHaveBeenCalled();
    // The turn it was sent to is still running: the same button now ends the process, and says so.
    expect(() => button("Stop the agent")).toThrow();
    await click("Stop the session");
    expect(session.stop).toHaveBeenCalledWith("t1");
    expect(session.interrupt).toHaveBeenCalledTimes(1);

    // The agent answered and a later turn runs: Stop is an interrupt again.
    snapshot.tabs[0].events = [...snapshot.tabs[0].events, event(2, { type: "turn_completed", status: "aborted" }), event(3, { type: "user_message", text: "again", queued: false })];
    await show(<CloudWorkspaceScreen />);
    expect(() => button("Stop the session")).toThrow();
    await click("Stop the agent");
    expect(session.interrupt).toHaveBeenCalledTimes(2);
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps Stop as the stop that ends the process on a runtime that cannot take an interrupt", async () => {
    const { session } = world({ interrupts: false });
    await show(<CloudWorkspaceScreen />);
    await click("Stop the agent");
    expect(session.stop).toHaveBeenCalledWith("t1");
    expect(session.interrupt).not.toHaveBeenCalled();
  });

  it("shows a compaction as running only while the tab's live feed has caught up, and as compacted only once it ended (#644)", async () => {
    const scope = { sessionId: "s1", tabId: "t1", conversationId: null, provider: "claude", threadId: "thread", subagentId: null };
    const lifecycle = (seq: number, evidence: Record<string, unknown>) => event(seq, { type: "context_compaction_lifecycle", persisted: true, confirmedStart: true, evidence: { scope, generation: 1, ...evidence } });
    const started = [event(1, { type: "user_message", text: "/compact", queued: false }), lifecycle(2, { type: "connection_opened" }), lifecycle(3, { type: "item_started", turnId: "turn", itemId: "item" })];
    world({ events: started, continuous: true });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Compacting context…");
    expect(text()).not.toContain("Context compacted");
    // Not caught up (reconnecting, a checkpoint, not followed): how it ended may not have been heard.
    world({ events: started, continuous: false });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Compaction status unknown");
    expect(text()).not.toContain("Compacting context…");
    expect(text()).not.toContain("Context compacted");
    // It ended: compacted, caught up or not.
    world({ events: [...started, lifecycle(4, { type: "item_completed", turnId: "turn", itemId: "item" })], continuous: false });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Context compacted");
    expect(text()).not.toContain("Compacting context…");
  });

  it("shows a running workspace live and sends without asking", async () => {
    const { session, release } = world();
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Live · You can send");
    expect(stateLine().getAttribute("aria-label")).toBe("Live · end-to-end encrypted, You can send");
    expect(text()).toContain("run the tests");
    expect(container.querySelector('[data-testid="screen-title"]')!.textContent).toBe("fix-login");
    expect(session.view).toHaveBeenCalledWith("t1");
    await type("now the linter");
    await click("Send");
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(session.send).toHaveBeenCalledWith("t1", "now the linter");
    await click("Stop the agent");
    expect(session.stop).toHaveBeenCalledWith("t1");
    // Leaving the screen lets go of the connection.
    await show(null);
    expect(release).toHaveBeenCalled();
  });

  it("shows a stopped workspace's saved conversation with Start in place of the composer, and starts it only after a manager confirms (#988)", async () => {
    const { session } = world({ state: "suspended", role: "manager" });
    await show(<CloudWorkspaceScreen />);
    // The state and the role are one line of words under the title; nothing in it is a button.
    expect(stateLine().textContent).toBe("Stopped · Manager");
    expect(container.querySelector('[data-testid="header-title"] button')).toBeNull();
    expect(text()).toContain("run the tests");
    expect(text()).not.toMatch(/Nothing saved|Showing the saved conversation/);
    // No composer: the bar says why, with Start.
    expect(container.querySelector("input")).toBeNull();
    expect(startBar().textContent).toBe("This workspace is stoppedStart it to send a message.Start");
    await click("Start");
    // Asked first; nothing started yet.
    expect(mocks.catalog.start).not.toHaveBeenCalled();
    const [title, message, buttons] = mocks.alert.mock.calls[0];
    expect(title).toBe("Start this workspace?");
    expect(message).toContain("billed");
    expect(buttons.map((entry: { text: string }) => entry.text)).toEqual(["Cancel", "Start"]);
    buttons[0].onPress?.();
    expect(mocks.catalog.start).not.toHaveBeenCalled();
    await act(async () => buttons[1].onPress());
    expect(mocks.catalog.start).toHaveBeenCalledWith("org-1", mocks.params.workspaceId);
    // Nothing was sent to wake it: Start is its own request.
    expect(session.send).not.toHaveBeenCalled();
  });

  it("says no conversation was had in a stopped workspace with nothing saved, with the same Start, and nothing that contradicts it (#988)", async () => {
    world({ state: "suspended", role: "manager", tabs: 0 });
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Stopped · Manager");
    expect(text()).toContain("No conversation yet Nothing was said in this workspace before it stopped.");
    expect(text()).not.toMatch(/saved conversation|Nothing saved/);
    expect(startBar().textContent).toBe("This workspace is stoppedStart it to send a message.Start");
    await click("Start");
    await act(async () => mocks.alert.mock.calls[0][2][1].onPress());
    expect(mocks.catalog.start).toHaveBeenCalledTimes(1);
  });

  it("offers managers retry and tells others who can retry when setup failed", async () => {
    for (const role of ["manager", "driver", "viewer"]) {
      await show(null);
      world({ state: "attention-required", role });
      mocks.catalog.getSnapshot().organizations[0].workspaces[0].latestOperation = { state: "failed", action: "resume", errorCode: "cloud_workspace_runtime_bootstrap_failed" };
      await show(<CloudWorkspaceScreen />);
      expect(stateLine().textContent).toContain("Needs attention");
      expect(container.querySelector("input")).toBeNull();
      expect(startBar().textContent).toContain("runtime could not be set up");
      if (role === "manager") {
        await click("Retry resume");
        expect(mocks.alert.mock.calls.at(-1)![0]).toBe("Retry resume?");
        await act(async () => mocks.alert.mock.calls.at(-1)![2][1].onPress());
        expect(mocks.catalog.start).toHaveBeenCalled();
      } else {
        expect(startBar().textContent).toContain("can retry resume");
        expect(() => button("Retry resume")).toThrow();
      }
    }
  });

  it("allows a manager to retry a transient failed resume", async () => {
    world({ state: "attention-required", role: "manager" });
    mocks.catalog.getSnapshot().organizations[0].workspaces[0].latestOperation = { state: "failed", action: "resume", errorCode: "cloud_provider_unavailable" };
    await show(<CloudWorkspaceScreen />);
    expect(startBar().textContent).toContain("provider did not answer");
    await click("Retry resume");
  });

  it("keeps the composer for an online workspace needing attention", async () => {
    const { session } = world({ state: "attention-required", role: "manager", connection: "connected" });
    await show(<CloudWorkspaceScreen />);
    expect(container.querySelector('[data-testid="start-bar"]')).toBeNull();
    await type("continue");
    await click("Send");
    expect(session.send).toHaveBeenCalledWith("t1", "continue");
  });

  // A failed delete is 25.06's own page now (see "a failed delete" below).
  it.each([null, { state: "failed", action: "archive", errorCode: "cloud_provider_unavailable" }])("uses desktop recovery for other attention causes: %s", async (operation) => {
    world({ state: "attention-required", role: "manager" });
    mocks.catalog.getSnapshot().organizations[0].workspaces[0].latestOperation = operation;
    await show(<CloudWorkspaceScreen />);
    expect(startBar().textContent).toContain("desktop");
    expect(startBar().textContent).not.toContain("runtime could not be set up");
    expect(() => button("Retry resume")).toThrow();
    expect(container.querySelector("input")).toBeNull();
  });

  it("shows a running workspace's composer, with or without a conversation, and no Start (#988)", async () => {
    world({ role: "manager" });
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Live · Manager");
    expect(text()).toContain("run the tests");
    expect(container.querySelector('[data-testid="start-bar"]')).toBeNull();
    expect(container.querySelector("input")!.placeholder).toBe("Message the agent");

    world({ role: "manager", events: [] });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("No conversation yet This tab has not published any turns.");
    expect(container.querySelector('[data-testid="start-bar"]')).toBeNull();
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("tells a viewer of a stopped workspace who can start it, instead of the button (#988)", async () => {
    const { snapshot } = world({ state: "suspended", role: "viewer" });
    // Its creator is someone this phone knows by name.
    const listed = mocks.catalog.workspace();
    listed.createdBy = "u-alice";
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Stopped · You can view");
    expect(startBar().textContent).toBe("This workspace is stoppedAlice, its creator, or an organization owner or admin can start it. Anyone who can send to it starts it by sending a message.");
    expect(() => button("Start")).toThrow();
    expect(container.querySelector("input")).toBeNull();
    // A workspace whose creator is not known by name.
    listed.createdBy = null;
    snapshot.role = "viewer";
    await show(<CloudWorkspaceScreen />);
    expect(startBar().textContent).toBe("This workspace is stoppedIts creator or an organization owner or admin can start it. Anyone who can send to it starts it by sending a message.");
  });

  it("lets a driver start a stopped workspace by sending, only after they confirm, with no Start bar (contract §11.2)", async () => {
    const { session } = world({ state: "suspended", role: "driver" });
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Stopped · You can send");
    expect(text()).toContain("run the tests");
    // /resume is for managers: no Start and no "who can start it" for someone who can start it by sending.
    expect(container.querySelector('[data-testid="start-bar"]')).toBeNull();
    expect(() => button("Start")).toThrow();
    expect(text()).not.toContain("can start it");
    expect(container.querySelector("input")!.placeholder).toBe("Message (starts the workspace)");
    expect(container.querySelector("input")!.getAttribute("aria-label")).toBe("Message for the agent. Sending starts the workspace.");
    await type("continue");
    await click("Send");
    // Asked first; nothing sent yet.
    expect(session.send).not.toHaveBeenCalled();
    const [title, message, buttons] = mocks.alert.mock.calls[0];
    expect(title).toBe("Start this workspace?");
    expect(message).toContain("billed");
    expect(buttons.map((entry: { text: string }) => entry.text)).toEqual(["Cancel", "Start and send"]);
    buttons[0].onPress?.();
    expect(session.send).not.toHaveBeenCalled();
    await act(async () => buttons[1].onPress());
    expect(session.send).toHaveBeenCalledWith("t1", "continue", { allowWake: true });
  });

  it("says a workspace is starting once Start was pressed, and the server's word when it would not start it (#988)", async () => {
    world({ state: "suspended", role: "manager" });
    mocks.catalog.start.mockRejectedValueOnce(new CloudApiError("cloud_workspace_manager_required", 403));
    await show(<CloudWorkspaceScreen />);
    await click("Start");
    await act(async () => mocks.alert.mock.calls[0][2][1].onPress());
    expect(container.querySelector('[data-testid="start-bar"] [role="alert"]')!.textContent).toBe("Only this workspace's creator or an organization owner or admin can start it.");
    // Asking again cannot help: no button that would only be refused again.
    expect(() => button("Start")).toThrow();
    expect(() => button("Try again")).toThrow();

    // The list says it is starting: the bar says so, and the composer is not back yet.
    world({ state: "resuming", role: "manager", connection: "waitingForRuntime" });
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Starting… · Manager");
    expect(startBar().textContent).toBe("Starting the workspace…The composer appears when it is running.Starting…");
    expect(button("Starting…").disabled).toBe(true);
    expect(container.querySelector("input")).toBeNull();
  });

  it("says each way a resume fails in plain words, with Try again where asking again can help (#1290)", async () => {
    const failures: [unknown, string, boolean][] = [
      [new CloudApiError("cloud_workspace_unavailable", null, "network"), "This phone could not reach the service. Check its connection, then try again.", true],
      [new ResumeUnconfirmed(new CloudApiError("cloud_workspace_unavailable", null, "timeout"), true), "The service did not answer in time, and the list does not show the workspace starting. Try again.", true],
      [new ResumeUnconfirmed(new CloudApiError("cloud_workspace_unavailable", null, "timeout"), false), "The service did not answer in time, and the list could not be read to check whether the workspace is starting. If it stays stopped, try again.", true],
      [new CloudApiError("cloud_workspace_unavailable", 502, "unreadable"), "The service had a problem and did not start the workspace. Try again in a moment.", true],
      [new CloudApiError("cloud_workspace_invalid_response", 200), "The service answered in a way this version of the app cannot read. The workspace may be starting anyway; update the app to follow it here.", false],
      [new CloudApiError("cloud_brand_new_code", 409), "The service would not start this workspace. Try again; if it keeps failing, open it on the desktop to see why.", true],
      [new Error("no code at all"), "This phone could not send the request to start the workspace. Try again.", true],
    ];
    for (const [error, said, retry] of failures) {
      await show(null);
      mocks.alert.mockClear();
      world({ state: "suspended", role: "manager" });
      mocks.catalog.start.mockRejectedValueOnce(error);
      await show(<CloudWorkspaceScreen />);
      await click("Start");
      await act(async () => mocks.alert.mock.calls[0][2][1].onPress());
      expect(container.querySelector('[data-testid="start-bar"] [role="alert"]')!.textContent).toBe(said);
      expect(startBar().textContent).toContain("The workspace did not start");
      expect(startBar().textContent).not.toContain("That did not work");
      if (retry) {
        await click("Try again");
        expect(mocks.alert.mock.calls.at(-1)![0]).toBe("Try starting again?");
        await act(async () => mocks.alert.mock.calls.at(-1)![2][1].onPress());
        expect(mocks.catalog.start).toHaveBeenCalledTimes(2);
        mocks.catalog.start.mockClear();
      } else {
        expect(() => button("Try again")).toThrow();
        mocks.catalog.start.mockClear();
      }
    }
  });

  it("shows a resume that got no answer but is starting as under way, not as a failure (#1290)", async () => {
    world({ state: "suspended", role: "manager" });
    let finish!: (outcome: string) => void;
    mocks.catalog.start.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await show(<CloudWorkspaceScreen />);
    await click("Start");
    await act(async () => mocks.alert.mock.calls[0][2][1].onPress());
    // Asked once however often the button would be pressed meanwhile: it is disabled while asking.
    expect(button("Starting…").disabled).toBe(true);
    const start = mocks.catalog.start;
    await act(async () => finish("in-progress"));
    expect(start).toHaveBeenCalledTimes(1);
    // The list, read again, shows it resuming: said as starting, with no failure.
    mocks.catalog.getSnapshot().organizations[0].workspaces[0].workspace.state = "resuming";
    mocks.catalog.workspace().state = "resuming";
    await show(<CloudWorkspaceScreen />);
    expect(container.querySelector('[data-testid="start-bar"] [role="alert"]')).toBeNull();
    expect(startBar().textContent).toContain("Starting the workspace…The service has not confirmed yet, but the workspace is starting.");
  });

  it.each(["cloud_provider_state_conflict", "cloud_provider_credential_invalid", null, "cloud_brand_new_code"])("offers Retry resume after any failed resume, with what failed: %s (#1290)", async (errorCode) => {
    world({ state: "attention-required", role: "manager" });
    mocks.catalog.getSnapshot().organizations[0].workspaces[0].latestOperation = { state: "failed", action: "resume", errorCode };
    await show(<CloudWorkspaceScreen />);
    const said = startBar().textContent!;
    expect(said).toContain(errorCode === "cloud_provider_state_conflict" ? "does not allow resuming yet" : errorCode === "cloud_provider_credential_invalid" ? "An admin can repair it" : "The last resume did not finish.");
    expect(said).toContain("Retry resume, or open it on the desktop to see more.");
    expect(said).not.toContain("This workspace needs attention.This workspace needs attention.");
    await click("Retry resume");
    expect(mocks.alert.mock.calls.at(-1)![0]).toBe("Retry resume?");
  });

  it("says why the service refused to connect this phone to a running workspace, with Reconnect (#1290)", async () => {
    world({ role: "manager", connection: "stopped", problem: { kind: "api", code: "cloud_brand_new_code", unreachable: false } });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("The service would not connect this phone to the workspace.");
    expect(text()).not.toContain("Not connected.");
    expect(button("Reconnect")).toBeTruthy();
  });

  it("puts Sharing in the session's own bar as a glass icon button with a 44 pt target, and the role as plain text (#988, 22.06)", async () => {
    world({ role: "manager" });
    await show(<CloudWorkspaceScreen />);
    // The screen draws its own bar, as a session does: nothing is left to the navigator's.
    expect(container.querySelector('[data-testid="header-right"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Back"]')).not.toBeNull();
    const sharing = container.querySelector('button[aria-label="Sharing"]')!;
    expect(sharing.textContent).toBe("");
    // A 40 pt glass circle with 6 pt more to tap on each side: 52 pt.
    expect(Number(sharing.getAttribute("data-hitslop"))).toBeGreaterThanOrEqual(2);
    expect([...container.querySelectorAll("button")].some((entry) => /manager/i.test(entry.textContent ?? ""))).toBe(false);
  });

  it("gives a viewer the conversation and no way to send", async () => {
    world({ role: "viewer" });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("run the tests");
    expect(stateLine().textContent).toBe("Live · You can view");
    expect(text()).toContain("You can view this workspace but not send to it.");
    expect(container.querySelector("input")).toBeNull();
    expect(() => button("Send")).toThrow();
  });

  it("shows a permission request to everyone but lets only an approver answer it", async () => {
    const ask = [event(1, { type: "user_message", text: "deploy", queued: false }), event(2, { type: "permission_requested", requestId: "r1", toolUseId: "tool", toolName: "shell", input: {}, options: [{ id: "allow", label: "Allow", kind: "allow_once" }] })];
    world({ events: ask, canApprove: false });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Waiting for someone who can approve.");
    expect(() => button("Allow")).toThrow();

    const { session } = world({ events: ask, canApprove: true });
    await show(<CloudWorkspaceScreen />);
    await click("Allow");
    expect(session.decide).toHaveBeenCalledWith("t1", { requestId: "r1", optionId: "allow" });
  });

  it("shows an agent's question in a cloud tab, answered through the decision command by whoever may approve (#979)", async () => {
    const questions = [
      { question: "Which checks should run?", multiSelect: true, freeText: false, options: [{ label: "Lint, format", description: "Both" }, { label: "Tests" }] },
      { question: "Which branch?", multiSelect: false, freeText: true, options: [{ label: "main" }, { label: "next" }] },
    ];
    const ask = [event(1, { type: "user_message", text: "deploy", queued: false }), event(2, { type: "questions_asked", requestId: "q1", toolUseId: "", questions })];
    // Someone who may not approve reads the question and its options, and is told why there is nothing to press.
    world({ events: ask, canApprove: false });
    await show(<CloudWorkspaceScreen />);
    for (const shown of ["2 questions", "Which checks should run?", "Lint, format", "Both", "Tests", "Which branch?", "next"]) expect(text()).toContain(shown);
    expect(text()).toContain("Only someone allowed to approve can answer this question.");
    expect(text()).not.toContain("waiting for a permission");
    expect(() => button("Answer")).toThrow();

    const { session } = world({ events: ask, canApprove: true });
    await show(<CloudWorkspaceScreen />);
    await click("Tests"); await click("Lint, format. Both"); await click("next");
    await click("Answer");
    // What the desktop sends for a cloud tab: `session.decide` with the answers.
    expect(session.decide).toHaveBeenCalledWith("t1", { requestId: "q1", answers: { "Which checks should run?": "Tests, Lint, format", "Which branch?": "next" } });
    await click("Skip");
    expect(session.decide).toHaveBeenLastCalledWith("t1", { requestId: "q1", answers: {} });
    // A double tap sends one answer.
    session.decide.mockClear();
    await act(async () => { button("Answer").click(); button("Answer").click(); });
    expect(session.decide).toHaveBeenCalledTimes(1);

    // The runtime would not take this phone's answer: someone had answered first.
    const refused = { clientCommandId: "c1", tabId: "t1", kind: "permission-decision", text: null, requestId: "q1", state: "rejected", wake: null, category: "request-not-pending", receipt: null, createdAt: 1, updatedAt: 1, error: null };
    world({ events: ask, canApprove: true, outbox: [refused] });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("That request was already answered.");
  });

  it("says what became of a message: waiting, starting the workspace, not delivered, refused", async () => {
    const entry = (id: string, fields: Record<string, unknown>) => ({ clientCommandId: id, tabId: "t1", kind: "send", text: `message ${id}`, requestId: null, wake: null, category: null, receipt: null, createdAt: 1, updatedAt: 1, error: null, ...fields });
    const { session } = world({ outbox: [entry("a", { state: "applied" }), entry("b", { state: "unsent" }), entry("c", { state: "queued", wake: "queued" }), entry("d", { state: "rejected", category: "cloud_workspace_collaboration_forbidden" }), entry("e", { state: "queued", tabId: "t2" })] });
    await show(<CloudWorkspaceScreen />);
    expect(text()).not.toContain("message a");
    expect(text()).not.toContain("message e");
    expect(text()).toContain("Not delivered yet. It is sent when the phone is back online.");
    expect(text()).toContain("Starting the workspace…");
    expect(text()).toContain("Your role in this workspace does not allow that.");
    await click("Cancel the message: message b");
    expect(session.cancel).toHaveBeenCalledWith("b");
  });

  it("explains a phone that holds no key, a refusal, an archived workspace and one taken away", async () => {
    world({ hasKey: false, noKey: true, events: [], connection: "waitingForRuntime" });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Not readable on this phone yet");
    expect(button("Send").disabled).toBe(true);
    expect(container.querySelector("input")!.disabled).toBe(true);

    const refused = world();
    refused.session.send.mockRejectedValueOnce(Object.assign(new Error("read-only"), { code: "cloud_workspace_collaboration_forbidden" }));
    mocks.params = { workspaceId: `ws-${++counter}`, orgId: "org-1" };
    await show(<CloudWorkspaceScreen />);
    await type("hello");
    await click("Send");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Your role in this workspace does not allow that.");
    // The draft is kept when it was not sent.
    expect(container.querySelector("input")!.value).toBe("hello");

    world({ state: "archived" });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("This workspace is archived. Its conversation can be read.");
    expect(container.querySelector("input")).toBeNull();

  });

  it("says why a workspace cannot be shown, opens nothing for it, and clears the conversation when access ends while open", async () => {
    const first = world();
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("run the tests");
    // The list now says access was taken away: the same screen, re-rendered.
    mocks.catalog.access = () => "gone";
    mocks.catalog.opened = () => null;
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("This workspace is no longer shared with you");
    expect(text()).not.toContain("run the tests");
    expect(text()).not.toContain("Sign in");
    expect(container.querySelector("input")).toBeNull();
    expect(first.release).toHaveBeenCalled();

    for (const [access, words] of [["not-shared", "This workspace has not been shared with you"], ["deleted", "This workspace was deleted"], ["gone", "This workspace is no longer shared with you"]] as const) {
      world({ access });
      mocks.params = { workspaceId: `ws-${++counter}`, orgId: "org-1" };
      await show(<CloudWorkspaceScreen />);
      expect(text()).toContain(words);
      // Nothing is opened for a workspace this person may not open: no session, no connection.
      expect(mocks.catalog.retain).not.toHaveBeenCalled();
      expect(text()).not.toContain("Fix login");
    }

    world({ access: "unknown" });
    mocks.catalog.opened = () => null;
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Checking access…");
  });

  it("holds a message that never left the phone for a workspace that is stopped now, and sends it only after the person confirms", async () => {
    const entry = { clientCommandId: "a", tabId: "t1", kind: "send", text: "written offline", requestId: null, wake: null, category: null, receipt: null, createdAt: 1, updatedAt: 1, error: null, state: "unsent" };
    const { session } = world({ state: "suspended", outbox: [entry] });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("written offline");
    expect(text()).toContain("Not sent. This workspace is stopped, and sending starts it.");
    expect(session.deliverHeld).not.toHaveBeenCalled();
    await click("Send it and start the workspace");
    expect(session.deliverHeld).not.toHaveBeenCalled();
    const [title, message, buttons] = mocks.alert.mock.calls[0];
    expect(title).toBe("Start this workspace?");
    expect(message).toContain("billed");
    await act(async () => buttons[1].onPress());
    expect(session.deliverHeld).toHaveBeenCalledWith({ allowWake: true });
    // It can also just be dropped.
    await click("Cancel the message: written offline");
    expect(session.cancel).toHaveBeenCalledWith("a");
  });

  it("asks before starting when the workspace turns out to have stopped since the screen last heard", async () => {
    const { session } = world();
    session.send.mockRejectedValueOnce(Object.assign(new Error("would-wake"), { code: "would-wake" }));
    await show(<CloudWorkspaceScreen />);
    await type("still there?");
    await click("Send");
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenLastCalledWith("t1", "still there?");
    const [title, , buttons] = mocks.alert.mock.calls[0];
    expect(title).toBe("Start this workspace?");
    // The draft waits for the answer.
    expect(container.querySelector("input")!.value).toBe("still there?");
    await act(async () => buttons[1].onPress());
    expect(session.send).toHaveBeenLastCalledWith("t1", "still there?", { allowWake: true });
  });

  it("says a workspace is starting once it was asked to, offers Reconnect when the link stopped trying, and never shows a raw code", async () => {
    const entry = { clientCommandId: "a", tabId: "t1", kind: "send", text: "go", requestId: null, wake: "queued", category: null, receipt: null, createdAt: 1, updatedAt: 1, error: null, state: "queued" };
    world({ state: "suspended", outbox: [entry] });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Starting the workspace…");
    expect(text()).not.toContain("Stopped. Showing");

    const stuck = world({ connection: "stopped", problem: { kind: "gave-up" } });
    mocks.params = { workspaceId: `ws-${++counter}`, orgId: "org-1" };
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Could not connect to this workspace.");
    await click("Reconnect");
    expect(stuck.session.reconnect).toHaveBeenCalled();
    expect(mocks.catalog.refresh).toHaveBeenCalled();

    const odd = world({ outbox: [{ ...entry, state: "rejected", wake: null, category: "some_new_refusal_code" }], connection: "updateRequired" });
    mocks.params = { workspaceId: `ws-${++counter}`, orgId: "org-1" };
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Update the app to connect to this workspace.");
    expect(text()).toContain("That did not work. Try again in a moment.");
    expect(text()).not.toContain("some_new_refusal_code");
    expect(text()).not.toContain("some new refusal code");
    expect(odd.session.reconnect).not.toHaveBeenCalled();
  });

  it("switches between a workspace's agent tabs", async () => {
    const { session } = world({ tabs: 2 });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("run the tests");
    await click("Second 1");
    expect(session.view).toHaveBeenLastCalledWith("t2");
    expect(text()).not.toContain("run the tests");
  });
});

describe("a shared cloud workspace on the phone", () => {
  const alice = { userId: "u-alice", role: "driver", canApprove: false, surfaces: 1, tabId: "t1", activity: "typing", since: 1 };
  const lease = (holderId: string) => ({ tabId: "t1", holderId, acquiredAt: 0, expiresAt: Date.now() + 120_000 });

  it("shows who else is here and who drives, and keeps the composer off while someone else does", async () => {
    const { session } = world({ collab: { available: true, participants: [{ ...alice, userId: "u-me", activity: "viewing" }, alice], leases: { t1: lease("u-alice") } } });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Also here: Alice · typing · on Fix login");
    expect(text()).toContain("Driving: Alice");
    expect(text()).toContain("Alice is driving this tab. You can send when they release it.");
    expect((container.querySelector('input[placeholder="Message the agent"]') as HTMLInputElement).disabled).toBe(true);
    expect(button("Send").disabled).toBe(true);
    // A driver cannot take it from her, and cannot stop her turn.
    expect(() => button("Take over")).toThrow();
    expect(() => button("Take the wheel")).toThrow();
    expect(() => button("Stop the agent")).toThrow();
    expect(session.send).not.toHaveBeenCalled();
  });

  it("lets a manager take over, a driver take a free wheel, and the holder release it", async () => {
    const manager = world({ role: "manager", collab: { available: true, leases: { t1: lease("u-alice") } } });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Take over to send.");
    await click("Take over");
    expect(manager.session.takeOverWheel).toHaveBeenCalledWith("t1");
    expect(button("Stop the agent")).toBeTruthy();

    const free = world({ collab: { available: true } });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("No one is driving");
    await click("Take the wheel");
    expect(free.session.takeWheel).toHaveBeenCalledWith("t1");

    const mine = world({ collab: { available: true, leases: { t1: lease("u-me") } } });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("You are driving");
    expect(button("Send")).toBeTruthy();
    await click("Release");
    expect(mine.session.releaseWheel).toHaveBeenCalledWith("t1");

    // A viewer sees who drives and gets no wheel.
    world({ role: "viewer", collab: { available: true } });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("No one is driving");
    expect(() => button("Take the wheel")).toThrow();
  });

  it("keeps notes apart from the composer: a note goes to the people, never to the agent", async () => {
    const { session } = world({ collab: { available: true, userId: "u-me", notes: { t1: [{ id: "n1", tabId: "t1", authorId: "u-alice", text: "look at the auth test", createdAt: 1 }, { id: "n2", tabId: "t1", authorId: "u-me", text: "on it", createdAt: 2 }] } } });
    await show(<CloudWorkspaceScreen />);
    expect(text()).not.toContain("look at the auth test");
    await click("Notes (2)");
    expect(text()).toContain("Notes are for the people here. They are not sent to the agent.");
    expect(text()).toContain("Alice  look at the auth test");
    expect(text()).toContain("You  on it");
    await type("deploying at 5", "Add a note for people here");
    await click("Add note");
    expect(session.postNote).toHaveBeenCalledWith("t1", "deploying at 5");
    expect(session.send).not.toHaveBeenCalled();
    // The message draft is its own field.
    expect((container.querySelector('input[placeholder="Message the agent"]') as HTMLInputElement).value).toBe("");
    // Typing a message tells the others; typing a note does not.
    expect(session.typingIn).not.toHaveBeenCalled();
    await type("hello", "Message the agent");
    expect(session.typingIn).toHaveBeenCalledWith("t1");
  });

  it("hides presence, the wheel and notes on a runtime without sharing, and when not connected", async () => {
    world();
    await show(<CloudWorkspaceScreen />);
    expect(text()).not.toContain("driving");
    expect(() => button("Notes")).toThrow();
  });

  it("reads the list once more before telling someone a workspace is not shared with them (they may just have been added)", async () => {
    world({ role: "none", access: "not-shared" });
    let finish!: () => void;
    mocks.catalog.refresh = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Checking access…");
    expect(text()).not.toContain("has not been shared");
    // Nothing is opened, and no agent tab is named, for someone with no role.
    expect(mocks.catalog.retain).not.toHaveBeenCalled();
    expect(text()).not.toContain("Fix login");
    await act(async () => finish());
    expect(text()).toContain("This workspace has not been shared with you");
    expect(mocks.catalog.refresh).toHaveBeenCalledTimes(1);
  });

  it("reads the driver once to a screen reader, and says why the wheel was refused", async () => {
    const { session } = world({ collab: { available: true, leases: { t1: lease("u-alice") } }, role: "manager" });
    await show(<CloudWorkspaceScreen />);
    expect(container.innerHTML).not.toContain("Driver: Driving");
    const free = world({ collab: { available: true } });
    free.session.takeWheel.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "lease_cooldown" }));
    mocks.params = { workspaceId: `ws-${++counter}`, orgId: "org-1" };
    await show(<CloudWorkspaceScreen />);
    await click("Take the wheel");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("You drove this tab moments ago; others get the first chance. Try again in two minutes.");
    expect(session.takeWheel).not.toHaveBeenCalled();
  });

  it("shows nothing of the workspace when the runtime says there is no role while the list still says there is one", async () => {
    // The list has not caught up (or cannot be read): access is "ok" there, the session is open, and the runtime says none.
    const { session } = world({ role: "none", access: "ok", tabs: 2, collab: { available: true, participants: [alice], notes: {} } });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("This workspace has not been shared with you");
    // No agent tab titles, no presence, no conversation, no composer, no way into sharing.
    expect(text()).not.toContain("Fix login");
    expect(text()).not.toContain("Second 1");
    expect(text()).not.toContain("Also here");
    expect(text()).not.toContain("Alice");
    expect(text()).not.toContain("run the tests");
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(() => button("Sharing")).toThrow();
    expect(session.view).not.toHaveBeenCalled();
  });

  it("says a workspace has not been shared with this person instead of an empty conversation", async () => {
    world({ role: "none", collab: { available: true } });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("This workspace has not been shared with you");
    expect(text()).toContain("Ask an organization admin or its creator to share it.");
    expect(text()).not.toContain("run the tests");
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it("puts a message refused because of sharing in words, and tells a non-approver who must answer", async () => {
    const entry = (id: string, fields: Record<string, unknown>) => ({ clientCommandId: id, tabId: "t1", kind: "send", text: `message ${id}`, requestId: null, wake: null, receipt: null, createdAt: 1, updatedAt: 1, error: null, state: "rejected", ...fields });
    world({ outbox: [entry("a", { category: "lease-held", receipt: { outcome: "rejected", holderId: "u-alice" } }), entry("b", { category: "access-revoked" })], events: [event(1, { type: "permission_requested", requestId: "r1", toolUseId: "tool", toolName: "shell", input: {}, options: [{ id: "allow", label: "Allow", kind: "allow_once" }] })] });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Alice is driving. Your message was not sent.");
    expect(text()).toContain("Not sent: your access changed.");
    expect(text()).toContain("Waiting for someone who can approve.");
    expect(() => button("Allow")).toThrow();
  });

  it("opens the sharing screen from the workspace", async () => {
    world();
    await show(<CloudWorkspaceScreen />);
    await click("Sharing");
    expect(mocks.push).toHaveBeenCalledWith({ pathname: "/cloud/shares", params: { orgId: "org-1", workspaceId: mocks.params.workspaceId } });
  });

  it("has the list read now and then only while the workspace is in front, and keeps it open under another screen", async () => {
    const { release } = world();
    await show(<CloudWorkspaceScreen />);
    expect(mocks.catalog.retain).toHaveBeenCalledTimes(1);
    // In front: watching. Another screen pushed over it ends the watch; the workspace stays open.
    // (The screen's own focus effect is its first; the reads under it register theirs after.)
    const leave = mocks.focus[0]!();
    expect(mocks.catalog.watch).toHaveBeenCalledTimes(1);
    expect(leave).toBe(mocks.catalog.watch.mock.results[0].value);
    expect(release).not.toHaveBeenCalled();
  });
});

describe("the workspace conversation", () => {
  it("opens at the newest turn, not the oldest", async () => {
    world({ events: [event(1, { type: "user_message", text: "first ask", queued: false }), event(2, { type: "turn_completed", status: "completed" }), event(3, { type: "user_message", text: "newest ask", queued: false })] });
    await show(<CloudWorkspaceScreen />);
    // The native list is inverted: offset zero, where it opens, is its first item.
    expect(mocks.listProps.inverted).toBe(true);
    expect(JSON.stringify(mocks.listProps.data[0])).toContain("newest ask");
    expect(JSON.stringify(mocks.listProps.data.at(-1))).toContain("first ask");
  });

  it("goes back to the Cloud tab by name, not the route group", async () => {
    const layout = (await import("../app/_layout.tsx?raw")).default;
    expect(layout).toMatch(/name="cloud\/\[workspaceId\]" options=\{\{[^}]*headerBackTitle: "Cloud"/);
  });
});

describe("the sharing screen", () => {
  const share = (userId: string, fields: Record<string, unknown> = {}) => ({ userId, email: `${userId.slice(2)}@example.com`, name: NAMES[userId], role: "driver", canApprove: false, createdBy: "u-me", createdAt: 1, updatedAt: 1, ...fields });

  it("shows the list read-only to someone who may not manage it", async () => {
    world();
    mocks.catalog.api.shares.mockResolvedValue({ shares: [share("u-alice", { canApprove: true }), share("u-bob", { role: "viewer" })], you: { role: "driver", canApprove: false, canManageShares: false } });
    await show(<CloudSharesScreen />);
    expect(text()).toContain("Alice");
    expect(text()).toContain("Can send · can approve permissions");
    expect(text()).toContain("View only");
    expect(text()).toContain("Only managers and the workspace's creator can change who it is shared with.");
    expect(() => button("Remove")).toThrow();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    // The roster is not read for someone who cannot add anyone.
    expect(mocks.catalog.people.roster).not.toHaveBeenCalled();
  });

  it("lets a manager change a role, the right to approve, remove someone after confirming, and add a member", async () => {
    world();
    mocks.catalog.api.shares.mockResolvedValue({ shares: [share("u-alice")], you: { role: "manager", canApprove: true, canManageShares: true } });
    await show(<CloudSharesScreen />);
    // Bob is a member without access; the person themself is not offered.
    expect(text()).toContain("bob@example.com");
    expect(text()).not.toContain("me@example.com");

    await click("Alice: View only");
    expect(mocks.catalog.api.putShare).toHaveBeenLastCalledWith("org-1", mocks.params.workspaceId, "u-alice", { role: "viewer", canApprove: false });
    await act(async () => { (container.querySelector('input[aria-label="Alice: can approve permissions"]') as HTMLInputElement).click(); });
    expect(mocks.catalog.api.putShare).toHaveBeenLastCalledWith("org-1", mocks.params.workspaceId, "u-alice", { role: "driver", canApprove: true });
    // The server's list is read again after each change.
    expect(mocks.catalog.api.shares).toHaveBeenCalledTimes(3);

    await click("Remove");
    expect(mocks.catalog.api.revokeShare).not.toHaveBeenCalled();
    const [title, , buttons] = mocks.alert.mock.calls[0];
    expect(title).toBe("Remove Alice?");
    await act(async () => buttons[1].onPress());
    expect(mocks.catalog.api.revokeShare).toHaveBeenCalledWith("org-1", mocks.params.workspaceId, "u-alice");

    await click("Add Bob as view only");
    expect(mocks.catalog.api.putShare).toHaveBeenLastCalledWith("org-1", mocks.params.workspaceId, "u-bob", { role: "viewer", canApprove: false });
  });

  it("lets someone who only views approve, and keeps that right when their role is changed", async () => {
    world();
    mocks.catalog.api.shares.mockResolvedValue({ shares: [share("u-bob", { role: "viewer" }), share("u-alice", { canApprove: true })], you: { role: "manager", canApprove: true, canManageShares: true } });
    await show(<CloudSharesScreen />);
    const bob = container.querySelector('input[aria-label="Bob: can approve permissions"]') as HTMLInputElement;
    expect(bob.disabled).toBe(false);
    expect(text()).not.toContain("cannot approve");
    await act(async () => { bob.click(); });
    expect(mocks.catalog.api.putShare).toHaveBeenLastCalledWith("org-1", mocks.params.workspaceId, "u-bob", { role: "viewer", canApprove: true });
    // Making an approver view-only does not take the approval right away without being asked.
    await click("Alice: View only");
    expect(mocks.catalog.api.putShare).toHaveBeenLastCalledWith("org-1", mocks.params.workspaceId, "u-alice", { role: "viewer", canApprove: true });
  });

  it("says in words why a change was refused, naming the person, and never shows a code", async () => {
    world();
    mocks.catalog.api.shares.mockResolvedValue({ shares: [share("u-bob", { role: "viewer" })], you: { role: "manager", canApprove: true, canManageShares: true } });
    await show(<CloudSharesScreen />);
    const alert = () => container.querySelector('[role="alert"]')!.textContent;
    const refuse = (code: string) => mocks.catalog.api.putShare.mockRejectedValueOnce(Object.assign(new Error("x"), { code }));
    refuse("cloud_workspace_share_redundant");
    await click("Bob: Can send");
    expect(alert()).toBe("Bob already has access as owner, admin or creator.");
    refuse("organization_member_not_found");
    await click("Bob: Can send");
    expect(alert()).toBe("Bob is no longer a member of this organization.");
    refuse("cloud_workspace_share_limit");
    await click("Add Alice as view only");
    expect(alert()).toBe("This workspace is already shared with the maximum number of people (64). Remove someone first.");
    refuse("cloud_workspace_share_requires_organization_access");
    await click("Add Alice, can send");
    expect(alert()).toBe("Make the workspace visible to the organization first.");
    refuse("cloud_workspace_share_forbidden");
    await click("Bob: Can send");
    expect(alert()).toBe("Only organization admins and the workspace's creator can change who it is shared with.");
    refuse("something_new_entirely");
    await click("Bob: Can send");
    expect(alert()).toBe("That did not work. Try again in a moment.");
  });

  it("reads the organization's members afresh on opening, so someone removed since is not offered (#501)", async () => {
    world();
    mocks.catalog.api.shares.mockResolvedValue({ shares: [], you: { role: "manager", canApprove: true, canManageShares: true } });
    await show(<CloudSharesScreen />);
    expect(mocks.catalog.people.roster).toHaveBeenCalledWith("org-1", { fresh: true });
  });

  it("reads the share list and members again when the server says the person left the organization (#501)", async () => {
    world();
    mocks.catalog.api.shares.mockResolvedValue({ shares: [share("u-bob")], you: { role: "manager", canApprove: true, canManageShares: true } });
    await show(<CloudSharesScreen />);
    expect(button("Bob: Can send")).toBeTruthy();
    // Bob is removed from the organization while the screen is open: the server revoked his share with it.
    mocks.catalog.api.shares.mockResolvedValue({ shares: [], you: { role: "manager", canApprove: true, canManageShares: true } });
    mocks.catalog.people.roster.mockResolvedValue([{ userId: "u-me", email: "me@example.com", role: "admin" }, { userId: "u-alice", email: "alice@example.com", displayName: "Alice", role: "member" }]);
    mocks.catalog.api.putShare.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "organization_member_not_found" }));
    await click("Bob: View only");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Bob is no longer a member of this organization.");
    expect(() => button("Bob: View only")).toThrow();
    expect(() => button("Add Bob as view only")).toThrow();
    expect(text()).not.toContain("bob@example.com");
    expect(button("Add Alice as view only")).toBeTruthy();
  });

  it("does not offer owners, admins or the creator, who already have access", async () => {
    world();
    mocks.catalog.workspace = () => item("ws-1", { createdBy: "u-carol" }).workspace;
    mocks.catalog.people.roster.mockResolvedValue([
      { userId: "u-bob", email: "bob@example.com", displayName: "Bob", role: "member" },
      { userId: "u-erin", email: "erin@example.com", displayName: "Erin", role: "admin" },
      { userId: "u-olga", email: "olga@example.com", displayName: "Olga", role: "owner" },
      { userId: "u-carol", email: "carol@example.com", displayName: "Carol", role: "member" },
    ]);
    mocks.catalog.api.shares.mockResolvedValue({ shares: [], you: { role: "manager", canApprove: true, canManageShares: true } });
    await show(<CloudSharesScreen />);
    expect(text()).toContain("bob@example.com");
    for (const email of ["erin@example.com", "olga@example.com", "carol@example.com"]) expect(text()).not.toContain(email);
  });

  it("says why a driver share is refused while a managers-only agent login exists", async () => {
    world();
    mocks.catalog.api.shares.mockResolvedValue({ shares: [share("u-bob", { role: "viewer" })], you: { role: "manager", canApprove: true, canManageShares: true } });
    await show(<CloudSharesScreen />);
    mocks.catalog.api.putShare.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "cloud_workspace_share_credential_restricted" }));
    await click("Bob: Can send");
    const alert = container.querySelector('[role="alert"]')!.textContent;
    expect(alert).toMatch(/agent login that only owners and admins may use/);
    expect(alert).not.toMatch(/Try again in a moment/);
  });

  it("says when the list cannot be read and offers to try again", async () => {
    world();
    mocks.catalog.api.shares.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "cloud_workspace_forbidden" }));
    await show(<CloudSharesScreen />);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("You do not have access to this workspace.");
    mocks.catalog.api.shares.mockResolvedValue({ shares: [], you: { role: "viewer", canApprove: false, canManageShares: false } });
    await click("Try again");
    expect(text()).toContain("This workspace is not shared with anyone yet.");
  });
});

// ── Launch progress, Stop and Delete (25.05 rows 5 and 6, 25.06; PRO-530) ──

/** An operation as the lifecycle routes answer it (placeholder values). */
const operation = (fields: Record<string, unknown> = {}) => ({ id: "op-1", workspaceId: mocks.params.workspaceId, type: "create", state: "running", stage: "queued", cancelable: true, createdAt: 1, updatedAt: 2, ...fields });
const lifecycle = (op: Record<string, unknown>, workspace: Record<string, unknown> = {}) => ({ workspace: { ...item(mocks.params.workspaceId, { name: "fix-login", state: "provisioning", you: { role: "manager", canApprove: true } }).workspace, ...workspace }, operation: op });
const listedItem = () => mocks.catalog.getSnapshot().organizations[0].workspaces[0];
const lastAlert = () => mocks.alert.mock.calls.at(-1) as [string, string | undefined, { text: string; style?: string; onPress?: () => void }[]];
const pressInAlert = async (label: string) => { await act(async () => { lastAlert()[2].find((entry) => entry.text === label)!.onPress?.(); }); };
const stage = (index: number) => container.querySelector(`[data-testid="operation-stage-${index}"]`)!.getAttribute("aria-label");
/** Shows the page as everything registered for focus would on a real phone: in front, and active. */
const focusAll = async () => { await act(async () => { for (const run of [...mocks.focus]) run(); }); };

/** A workspace whose latest operation is its launch, as the list and the operation route answer it. */
function launching(op: Record<string, unknown>, workspace: Record<string, unknown> = {}, role = "manager") {
  const made = world({ state: (workspace.state as string | undefined) ?? "provisioning", role, connection: "waitingForRuntime" });
  Object.assign(listedItem().workspace, { you: { role, canApprove: true }, ...workspace });
  listedItem().latestOperation = { id: op.id, state: op.state, action: null, type: "create" };
  mocks.catalog.api.operation.mockImplementation(async () => lifecycle(op, { you: { role, canApprove: true }, ...workspace }));
  return made;
}

describe("a launch on the workspace page (25.05)", () => {
  it("Queued: the stages from the start, Cancel launch, and that the person may leave", async () => {
    launching(operation({ state: "queued", stage: "queued" }));
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Starting · You are a manager");
    expect(text()).toContain("Launching…");
    expect(stage(0)).toBe("Queued, in progress");
    expect(stage(1)).toBe("Checking the provider, not started");
    expect(text()).toContain("You can leave this page. The launch carries on, and the workspace shows in the Cloud tab.");
    expect(button("Cancel launch").disabled).toBe(false);
    expect(mocks.catalog.api.operation).toHaveBeenCalledWith("org-1", "op-1");
    // The launch page, not the conversation or a composer.
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it("Creating the machine: the stages passed are ticked", async () => {
    launching(operation({ stage: "creating-machine" }));
    await show(<CloudWorkspaceScreen />);
    expect(stage(1)).toBe("Checking the provider, done");
    expect(stage(2)).toBe("Creating the machine, in progress");
    expect(button("Cancel launch").disabled).toBe(false);
  });

  it("Installing the runtime: the operation's event under its stage, and Cancel off once it can no longer be canceled", async () => {
    launching(operation({ stage: "bootstrapping", cancelable: false, events: [{ code: "runtime-installation-started", occurredAt: 5 }, { code: "repository-cloning", occurredAt: 6 }] }));
    await show(<CloudWorkspaceScreen />);
    expect(stage(3)).toBe("Installing the runtime, in progress: Cloning the repository");
    expect(text()).toContain("It can no longer be canceled. Once it is running you can stop or delete it.");
    expect(button("Cancel launch").disabled).toBe(true);
  });

  it("Running: asks every 3 seconds only while shown, then says it is running, and opens the workspace page as it is", async () => {
    vi.useFakeTimers();
    try {
      launching(operation({ stage: "connecting-relay", cancelable: false }));
      await show(<CloudWorkspaceScreen />);
      expect(mocks.catalog.api.operation).toHaveBeenCalledTimes(1);
      // Not in front yet: nothing is asked.
      await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
      expect(mocks.catalog.api.operation).toHaveBeenCalledTimes(1);
      await focusAll();
      mocks.catalog.api.operation.mockImplementation(async () => lifecycle(operation({ state: "succeeded", stage: "ready", cancelable: false }), { state: "ready" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(text()).toContain("fix-login is running");
      expect(stateLine().textContent).toBe("Live · You are a manager");
      expect(stage(5)).toBe("Ready, done");
      expect(text()).toContain("Opening it in a moment…");
      expect(button("Open workspace").disabled).toBe(false);
      // Ended: the list is read again, and nothing more is asked.
      expect(mocks.catalog.refresh).toHaveBeenCalled();
      const asked = mocks.catalog.api.operation.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(mocks.catalog.api.operation.mock.calls.length).toBe(asked);
      // In a moment it opens by itself: today's workspace page, and no way to make an agent tab.
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(text()).not.toContain("fix-login is running");
      expect(text()).toContain("run the tests");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Open workspace opens the workspace page at once", async () => {
    vi.useFakeTimers();
    try {
      launching(operation({ stage: "connecting-relay", cancelable: false }));
      await show(<CloudWorkspaceScreen />);
      await focusAll();
      mocks.catalog.api.operation.mockImplementation(async () => lifecycle(operation({ state: "succeeded", stage: "ready", cancelable: false }), { state: "ready" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      await click("Open workspace");
      expect(text()).toContain("run the tests");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cancel asks first, in the owner's words with the provider's name, and only its Cancel launch cancels", async () => {
    launching(operation({ stage: "creating-machine" }));
    mocks.catalog.api.cancelOperation.mockImplementation(async () => lifecycle(operation({ state: "cancel-requested", stage: "cleanup", cancelable: false })));
    await show(<CloudWorkspaceScreen />);
    await click("Cancel launch");
    expect(lastAlert()[0]).toBe("Cancel this launch?");
    expect(lastAlert()[1]).toBe("The machine being created is removed. Boat may bill for the time it existed.");
    expect(lastAlert()[2].map((entry) => entry.text)).toEqual(["Keep launching", "Cancel launch"]);
    expect(mocks.catalog.api.cancelOperation).not.toHaveBeenCalled();
    await pressInAlert("Keep launching");
    expect(mocks.catalog.api.cancelOperation).not.toHaveBeenCalled();
    await click("Cancel launch");
    await pressInAlert("Cancel launch");
    expect(mocks.catalog.api.cancelOperation).toHaveBeenCalledWith("org-1", "op-1");
  });

  it("Canceling: cleaning up under the stage it had reached, and Cancel locked", async () => {
    launching(operation({ state: "cancel-requested", stage: "cleanup", cancelable: false, events: [{ code: "provider-preflight-started", occurredAt: 3 }, { code: "machine-allocation-started", occurredAt: 4 }, { code: "provider-cleanup-started", occurredAt: 5 }] }));
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Canceling…");
    expect(stage(2)).toBe("Creating the machine, in progress: Cleaning up");
    expect(text()).toContain("Removing what was created so far.");
    expect(button("Cancel launch").disabled).toBe(true);
  });

  it("Canceled: what was removed, from the cleanup report, with Launch again and Back to Cloud", async () => {
    launching(operation({ state: "canceled", stage: "cleanup", cancelable: false, events: [{ code: "machine-allocation-started", occurredAt: 4 }], cleanup: { complete: true, items: [{ kind: "provider-compute", state: "removed" }] } }), { state: "destroyed" });
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Unavailable");
    expect(text()).toContain("Launch canceled");
    expect(stage(2)).toBe("Creating the machine, failed: Canceled");
    expect(text()).toContain("The machine was removed. Launching again asks for a new price.");
    await click("Launch again");
    expect(mocks.push).toHaveBeenCalledWith("/cloud/launch?orgId=org-1");
    await click("Back to Cloud");
    expect(mocks.dismissTo).toHaveBeenCalledWith("/cloud");
  });

  it("Failed part-way, runtime: the machine exists and was stopped, Retry setup asks first, Delete opens its page", async () => {
    launching(operation({ state: "failed", stage: "bootstrapping", cancelable: false, errorCode: "cloud_workspace_runtime_bootstrap_failed", reason: "attention-stopped" }), { state: "attention-required" });
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Needs attention · You are a manager");
    expect(text()).toContain("The launch failed");
    expect(stage(3)).toBe("Installing the runtime, failed: Installing or starting the runtime on the machine failed.");
    expect(container.querySelector('[data-testid="launch-note"]')!.getAttribute("role")).toBe("alert");
    expect(text()).toContain("The machine exists and was stopped to avoid charges after a problem. Retry setup tries again on the same machine; delete it if you would rather start over.");
    await click("Retry setup");
    expect(mocks.catalog.start).not.toHaveBeenCalled();
    await pressInAlert("Retry setup");
    expect(mocks.catalog.start).toHaveBeenCalledWith("org-1", mocks.params.workspaceId);
    await click("Delete workspace…");
    expect(mocks.push).toHaveBeenCalledWith(`/cloud/delete?orgId=org-1&workspaceId=${mocks.params.workspaceId}`);
  });

  it("Failed at the provider, key: no machine was created, and Fix the provider key goes to the provider", async () => {
    launching(operation({ state: "failed", stage: "preflight", cancelable: false, errorCode: "cloud_provider_credential_invalid" }), { state: "attention-required" });
    await show(<CloudWorkspaceScreen />);
    expect(stage(1)).toBe("Checking the provider, failed: The provider rejected the API key.");
    expect(text()).toContain("No machine was created. Connect a working key, then launch again.");
    expect(container.querySelector('[data-testid="launch-note"]')!.getAttribute("role")).toBeNull();
    await click("Fix the provider key");
    expect(mocks.push).toHaveBeenCalledWith("/cloud/compute/box?orgId=org-1");
    expect(button("Delete workspace…").disabled).toBe(false);
  });

  it("Took too long: delete and launch again, and check the provider's dashboard", async () => {
    launching(operation({ state: "failed", stage: "creating-machine", cancelable: false, errorCode: "cloud_workspace_provisioning_timeout" }), { state: "attention-required" });
    await show(<CloudWorkspaceScreen />);
    expect(stage(2)).toBe("Creating the machine, failed: The workspace’s machine took too long to start.");
    expect(text()).toContain("Delete it and launch a new one. Check Boat’s dashboard if a machine is still listed there.");
    expect(button("Delete workspace…").disabled).toBe(false);
    await click("Back to Cloud");
    expect(mocks.dismissTo).toHaveBeenCalledWith("/cloud");
  });

  it("never shows a failure's code: one the app has no words for reads as the launch not finishing", async () => {
    launching(operation({ state: "failed", stage: "connecting-relay", cancelable: false, errorCode: "cloud_brand_new_failure" }), { state: "attention-required" });
    await show(<CloudWorkspaceScreen />);
    expect(stage(4)).toBe("Connecting to the relay, failed: The launch did not finish.");
    expect(text()).not.toContain("cloud_brand_new_failure");
  });

  it("Network lost while it launches: says so, keeps the stages, and Cancel waits for the network", async () => {
    vi.useFakeTimers();
    try {
      launching(operation({ stage: "creating-machine" }));
      await show(<CloudWorkspaceScreen />);
      await focusAll();
      mocks.catalog.api.operation.mockImplementation(async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "network"); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(stateLine().textContent).toBe("Offline");
      expect(text()).toContain("Offline. The launch carries on without the phone; this page catches up when it is back online.");
      expect(stage(2)).toBe("Creating the machine, in progress");
      expect(button("Cancel launch").disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says Offline, not Reading forever, when the launch was never read for want of a network", async () => {
    launching(operation({ stage: "creating-machine" }));
    mocks.catalog.api.operation.mockImplementation(async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "network"); });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Offline. The launch carries on without the phone; this page catches up when it is back online.");
    expect(text()).not.toContain("Reading the launch…");
  });

  it("gives someone who may not manage it no Cancel and no Delete", async () => {
    launching(operation({ state: "failed", stage: "creating-machine", cancelable: false, errorCode: "cloud_workspace_provisioning_timeout" }), { state: "attention-required" }, "driver");
    await show(<CloudWorkspaceScreen />);
    expect(() => button("Delete workspace…")).toThrow();
    expect(button("Back to Cloud").disabled).toBe(false);
  });
});

/** The sheet the ••• opens: the system's alert in this test, with its buttons. */
const sheet = async () => { await click("Workspace actions"); return lastAlert(); };

describe("stopping a workspace from the phone (25.06)", () => {
  it("gives a manager ••• beside Sharing with Stop workspace and Delete workspace…, and the role in one word", async () => {
    world({ role: "manager" });
    listedItem().workspace.you = { role: "manager", canApprove: true };
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Live · Manager");
    expect(button("Sharing")).toBeTruthy();
    const [title, , options] = await sheet();
    expect(title).toBe("fix-login");
    expect(options.map((entry) => entry.text)).toEqual(["Stop workspace", "Delete workspace…", "Cancel"]);
    expect(options.find((entry) => entry.text === "Delete workspace…")!.style).toBe("destructive");
  });

  it("offers Start workspace in the sheet of a stopped one, beside today's Start bar", async () => {
    world({ state: "suspended", role: "manager" });
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Stopped · Manager");
    expect(startBar().textContent).toContain("This workspace is stopped");
    const [, , options] = await sheet();
    expect(options.map((entry) => entry.text)).toEqual(["Start workspace", "Delete workspace…", "Cancel"]);
    await pressInAlert("Start workspace");
    expect(lastAlert()[0]).toBe("Start this workspace?");
    await pressInAlert("Start");
    expect(mocks.catalog.start).toHaveBeenCalledWith("org-1", mocks.params.workspaceId);
  });

  it("gives someone who may not manage it no ••• and keeps today's phrase", async () => {
    world({ role: "driver" });
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Live · You can send");
    expect(() => button("Workspace actions")).toThrow();
  });

  it("Stop asks first: what it does, then the provider's own billing line; Cancel stops nothing", async () => {
    const { snapshot } = world({ role: "manager" });
    snapshot.tabs[0].status = "idle";
    await show(<CloudWorkspaceScreen />);
    await sheet();
    await pressInAlert("Stop workspace");
    expect(lastAlert()[0]).toBe("Stop this workspace?");
    expect(lastAlert()[1]).toBe("Its agents stop until it is started again. Boat: per second, billed by Boat.");
    expect(lastAlert()[2].map((entry) => entry.text)).toEqual(["Cancel", "Stop"]);
    await pressInAlert("Cancel");
    expect(mocks.catalog.api.suspend).not.toHaveBeenCalled();
  });

  it("…while an agent is working: names it, and the button says Stop anyway", async () => {
    world({ role: "manager" });
    await show(<CloudWorkspaceScreen />);
    await sheet();
    await pressInAlert("Stop workspace");
    expect(lastAlert()[0]).toBe("Stop while an agent is working?");
    expect(lastAlert()[1]).toBe("Claude Code is in the middle of a turn. Stopping interrupts it; what it has not saved may be lost. Boat: per second, billed by Boat.");
    expect(lastAlert()[2].map((entry) => entry.text)).toEqual(["Cancel", "Stop anyway"]);
  });

  it("Stopping: the header line and the bar say so, and the composer is gone", async () => {
    const { snapshot } = world({ role: "manager" });
    snapshot.tabs[0].status = "idle";
    const stopping = lifecycle(operation({ id: "op-stop", action: "suspend", stage: null, cancelable: false }), { state: "ready" });
    mocks.catalog.api.suspend.mockImplementation(async () => stopping);
    mocks.catalog.api.operation.mockImplementation(async () => stopping);
    await show(<CloudWorkspaceScreen />);
    await sheet();
    await pressInAlert("Stop workspace");
    await pressInAlert("Stop");
    expect(mocks.catalog.api.suspend).toHaveBeenCalledWith("org-1", mocks.params.workspaceId);
    expect(stateLine().textContent).toBe("Stopping… · Manager");
    const bar = container.querySelector('[data-testid="stop-bar"]')!;
    expect(bar.textContent).toContain("Stopping the workspace…");
    expect(bar.textContent).toContain("Saving the workspace, then suspending the machine.");
    expect(button("Stopping…").disabled).toBe(true);
    expect(container.querySelector('input[type="text"]')).toBeNull();
    // Stop is not offered again while it stops.
    const [, , options] = await sheet();
    expect(options.map((entry) => entry.text)).toEqual(["Delete workspace…", "Cancel"]);
  });

  it("Stopping, as the list says it from elsewhere: the same bar", async () => {
    world({ state: "suspending", role: "manager", connection: "suspended" });
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Stopping… · Manager");
    expect(container.querySelector('[data-testid="stop-bar"]')!.textContent).toContain("Stopping the workspace…");
  });

  it("It did not stop: may still be billing, with Retry stop, which asks again", async () => {
    world({ state: "attention-required", role: "manager", connection: "connected" });
    listedItem().latestOperation = { id: "op-stop", state: "failed", action: "suspend", errorCode: "cloud_provider_unavailable" };
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Needs attention · Manager");
    expect(text()).toContain("This workspace needs attention.");
    const bar = container.querySelector('[data-testid="stop-bar"]')!;
    expect(bar.textContent).toContain("The workspace did not stop");
    expect(bar.textContent).toContain("The provider could not be reached. It may still be running, and billing.");
    expect(container.querySelector('input[type="text"]')).toBeNull();
    await click("Retry stop");
    expect(lastAlert()[0]).toMatch(/^Stop/);
    expect(mocks.catalog.api.suspend).not.toHaveBeenCalled();
  });

  it("Refused, something else is under way: Not right now, in words, and nothing changes", async () => {
    const { snapshot } = world({ role: "manager" });
    snapshot.tabs[0].status = "idle";
    mocks.catalog.api.suspend.mockImplementation(async () => { throw new CloudApiError("cloud_workspace_operation_in_progress", 409); });
    await show(<CloudWorkspaceScreen />);
    await sheet();
    await pressInAlert("Stop workspace");
    await pressInAlert("Stop");
    expect(lastAlert()[0]).toBe("Not right now");
    expect(lastAlert()[1]).toBe("Something else is still under way on this workspace. Try again when it has finished.");
    expect(lastAlert()[2].map((entry) => entry.text)).toEqual(["OK"]);
    expect(stateLine().textContent).toBe("Live · Manager");
    expect(container.querySelector('[data-testid="stop-bar"]')).toBeNull();
  });
});

describe("deleting a workspace (25.06)", () => {
  /** What a screen reader hears for each row of facts (FactRows reads each row whole). */
  const facts = () => [...container.querySelectorAll("[aria-label]")].map((row) => row.getAttribute("aria-label"));

  it("The confirmation: the console's facts with the provider's name, and Delete permanently off until the switch is on", async () => {
    world({ role: "manager" });
    await show(<DeleteWorkspaceScreen />);
    expect(container.querySelector('[data-testid="screen-title"]')!.textContent).toBe("Delete workspace");
    expect(text()).toContain("Delete fix-login permanently?");
    expect(facts()).toEqual(expect.arrayContaining(["Compute: The machine is removed.", "Data: Its disk, snapshots and saved conversations are removed once Boat confirms.", "Charges: Stop once Boat confirms the removal.", "Undo: Not possible."]));
    expect(text()).toContain("Push or copy out any work you want to keep before deleting.");
    expect(button("Delete permanently").disabled).toBe(true);
    await click("Delete permanently");
    expect(mocks.catalog.api.deleteWorkspace).not.toHaveBeenCalled();
    await click("Cancel");
    expect(mocks.back).toHaveBeenCalled();
  });

  const acknowledge = async () => {
    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.getAttribute("aria-label")).toBe("I understand this cannot be undone: the machine, its disk and snapshots, and the saved conversations are removed.");
    await act(async () => { toggle.click(); });
  };

  it("Acknowledged, then Sending: both buttons lock, and on the server's yes the phone goes back to the Cloud tab", async () => {
    world({ role: "manager" });
    let answer!: (value: unknown) => void;
    mocks.catalog.api.deleteWorkspace.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await show(<DeleteWorkspaceScreen />);
    await acknowledge();
    expect(button("Delete permanently").disabled).toBe(false);
    await click("Delete permanently");
    expect(mocks.catalog.api.deleteWorkspace).toHaveBeenCalledWith("org-1", mocks.params.workspaceId);
    expect(button("Deleting…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => { answer(lifecycle(operation({ action: "delete" }), { state: "deleting" })); });
    expect(mocks.dismissTo).toHaveBeenCalledWith("/cloud");
    expect(mocks.catalog.refresh).toHaveBeenCalled();
  });

  it.each([
    ["An agent is working", new CloudApiError("cloud_workspace_active_work", 409), "An agent is working here, or is waiting for an answer. Stop it or answer it, then delete."],
    ["Something else is under way", new CloudApiError("cloud_workspace_operation_in_progress", 409), "Something else is still under way on this workspace. Try again when it has finished."],
    ["No network", new CloudApiError("cloud_workspace_unavailable", null, "network"), "No connection. Nothing was deleted. Try again when the phone is back online."],
  ])("%s: the refusal above the buttons, in words, and nothing was deleted", async (_name, refusal, sentence) => {
    world({ role: "manager" });
    mocks.catalog.api.deleteWorkspace.mockImplementation(async () => { throw refusal; });
    await show(<DeleteWorkspaceScreen />);
    await acknowledge();
    await click("Delete permanently");
    expect(container.querySelector('[data-testid="delete-refusal"]')!.textContent).toBe(sentence);
    expect(mocks.dismissTo).not.toHaveBeenCalled();
    expect(button("Delete permanently").disabled).toBe(false);
  });

  it("No answer in time: the list says whether it is being deleted, and then it is done", async () => {
    world({ role: "manager" });
    mocks.catalog.api.deleteWorkspace.mockImplementation(async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "timeout"); });
    mocks.catalog.fresh.mockImplementation(async () => { listedItem().workspace.state = "deleting"; return true; });
    await show(<DeleteWorkspaceScreen />);
    await acknowledge();
    await click("Delete permanently");
    expect(mocks.catalog.fresh).toHaveBeenCalledWith("org-1");
    expect(mocks.dismissTo).toHaveBeenCalledWith("/cloud");
  });

  it("Opened from an old link: the app's page for a deleted workspace", async () => {
    world({ state: null, access: "deleted" });
    await show(<CloudWorkspaceScreen />);
    expect(container.querySelector('[data-testid="screen-title"]')!.textContent).toBe("Workspace");
    expect(text()).toContain("This workspace was deleted Nothing of it is kept on this phone.");
    await show(<DeleteWorkspaceScreen />);
    expect(text()).toContain("This workspace was deleted");
    expect(() => button("Delete permanently")).toThrow();
  });

  it("The provider refused: the console's sentence, the cleanup report in plain words, and Delete again opens the page", async () => {
    world({ state: "attention-required", role: "manager" });
    listedItem().workspace.you = { role: "manager", canApprove: true };
    listedItem().latestOperation = { id: "op-delete", state: "failed", action: "delete", errorCode: "cloud_provider_permission_denied" };
    mocks.catalog.api.operation.mockImplementation(async () => lifecycle(operation({ id: "op-delete", action: "delete", state: "failed", stage: "cleanup", cancelable: false, errorCode: "cloud_provider_permission_denied", providerErrorCode: "403", cleanup: { complete: false, items: [
      { kind: "runtime-credentials", state: "removed" }, { kind: "client-attachments", state: "removed" }, { kind: "provider-compute", state: "unconfirmed" }, { kind: "provider-storage", state: "unconfirmed" }, { kind: "workspace-content", state: "pending" },
    ] } }), { state: "attention-required" }));
    await show(<CloudWorkspaceScreen />);
    expect(stateLine().textContent).toBe("Needs attention · Manager");
    expect(container.querySelector('[data-testid="delete-refused"]')!.textContent).toBe("Boat refused to delete this machine (403). Check it in your Boat dashboard; if it is still there, delete it there, then press Delete again to clear it here.");
    const report = [...container.querySelectorAll("[aria-label]")].map((row) => row.getAttribute("aria-label")).filter((label) => /^(Runtime credentials|Phones and desktops|Machine|Disk and snapshots|Saved conversations):/.test(label ?? ""));
    expect(report).toEqual(["Runtime credentials: Removed", "Phones and desktops: Disconnected", "Machine: Not confirmed", "Disk and snapshots: Not confirmed", "Saved conversations: Pending"]);
    expect(text()).toContain("Until Boat confirms, the machine may still be billed.");
    expect(button("Workspace actions")).toBeTruthy();
    await click("Delete again");
    expect(mocks.push).toHaveBeenCalledWith(`/cloud/delete?orgId=org-1&workspaceId=${mocks.params.workspaceId}`);
    expect(mocks.catalog.api.deleteWorkspace).not.toHaveBeenCalled();
  });
});
