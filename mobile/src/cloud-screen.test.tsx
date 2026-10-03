// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudScreen from "../app/(tabs)/cloud";
import CloudWorkspaceScreen from "../app/cloud/[workspaceId]";
import CloudSharesScreen from "../app/cloud/shares";

const mocks = vi.hoisted(() => ({
  params: { workspaceId: "ws-1", orgId: "org-1" } as Record<string, string>,
  app: {} as any,
  catalog: null as any,
  push: vi.fn(),
  alert: vi.fn(),
  focus: [] as (() => void)[],
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: ({ options }: { options: { title: string } }) => <div data-testid="screen-title">{options.title}</div> },
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ push: mocks.push }),
  useFocusEffect: (run: () => void) => { mocks.focus.push(run); },
}));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: (catalog: any) => catalog?.getSnapshot() ?? { organizations: [], loading: false, error: null, refreshedAt: null } }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ChevronRight", "Send", "Square", "Terminal"].map((name) => [name, () => null])));
vi.mock("react-native", () => {
  const Box = ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => <div role={accessibilityRole === "alert" ? "alert" : undefined}>{children}</div>;
  return {
    View: Box, Text: Box, ScrollView: Box, KeyboardAvoidingView: Box, RefreshControl: () => null,
    Alert: { alert: mocks.alert },
    Switch: ({ value, onValueChange, disabled, accessibilityLabel }: any) => <input type="checkbox" aria-label={accessibilityLabel} checked={value} disabled={disabled} onChange={(event) => onValueChange(event.currentTarget.checked)} />,
    Platform: { OS: "web", select: ({ default: fallback }: any) => fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: any) => <button disabled={disabled} aria-label={accessibilityLabel} aria-pressed={accessibilityState?.selected} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    TextInput: ({ value, onChangeText, placeholder, editable, accessibilityLabel }: any) => <input type="text" aria-label={accessibilityLabel} value={value} disabled={editable === false} onInput={(event) => onChangeText(event.currentTarget.value)} placeholder={placeholder} />,
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: any) => <div>{ListHeaderComponent}{data.length ? data.map((item: unknown, index: number) => <div key={index}>{renderItem({ item })}</div>) : ListEmptyComponent}{ListFooterComponent}</div>,
    SectionList: ({ sections, renderItem, renderSectionHeader, renderSectionFooter, ListHeaderComponent, ListEmptyComponent }: any) => <div>{ListHeaderComponent}{sections.length ? sections.map((section: any) => <div key={section.key}>{renderSectionHeader({ section })}{section.data.map((item: any) => <div key={item.workspace.id}>{renderItem({ item })}</div>)}{renderSectionFooter({ section })}</div>) : ListEmptyComponent}</div>,
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

function world(options: { state?: string | null; role?: string | null; canApprove?: boolean; hasKey?: boolean; events?: unknown[]; outbox?: unknown[]; connection?: string; noKey?: boolean; tabs?: number; access?: string; problem?: unknown; collab?: Record<string, unknown> } = {}) {
  const state = options.state === undefined ? "ready" : options.state;
  const snapshot = {
    connection: { state: options.connection ?? (state === "ready" ? "connected" : "suspended") },
    problem: options.problem ?? null,
    collab: { available: false, userId: "u-me", participants: [], leases: {}, notes: {}, ...options.collab },
    role: options.role === undefined ? "driver" : options.role,
    canApprove: options.canApprove ?? false,
    hasKey: options.hasKey ?? true,
    tabs: Array.from({ length: options.tabs ?? 1 }, (_, index) => ({ tabId: index ? `t${index + 1}` : "t1", sessionId: "s1", title: index ? `Second ${index}` : "Fix login", status: "in_progress", source: "live", pendingPermissions: [], events: index ? [] : (options.events ?? [event(1, { type: "user_message", text: "run the tests", queued: false })]), truncated: false, noKey: options.noKey ?? false })),
    outbox: options.outbox ?? [],
    error: null,
  };
  const session = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    view: vi.fn(() => () => undefined),
    send: vi.fn(async () => ({})),
    stop: vi.fn(async () => ({})),
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
  const listed = state === null ? null : item("ws-1", { name: "fix-login", state }).workspace;
  const organizations = [{ organization: { orgId: "org-1", name: "Acme", role: "member" }, workspaces: listed ? [{ workspace: listed, latestOperation: null }] : [], error: null, loaded: true }];
  mocks.catalog = {
    getSnapshot: () => ({ organizations, loading: false, error: null, refreshedAt: 1 }),
    refresh: vi.fn(async () => undefined),
    workspace: () => listed,
    access: () => options.access ?? (listed ? (options.role === "none" ? "not-shared" : "ok") : "gone"),
    retain: vi.fn(() => release),
    opened: () => session,
    people: { subscribe: () => () => undefined, getVersion: () => 1, name: (userId: string | null | undefined) => NAMES[userId ?? ""] ?? "Someone", roster: vi.fn(async () => [{ userId: "u-me", email: "me@example.com", role: "admin" }, { userId: "u-alice", email: "alice@example.com", displayName: "Alice", role: "member" }, { userId: "u-bob", email: "bob@example.com", displayName: "Bob", role: "member" }]), remember: vi.fn() },
    api: { shares: vi.fn(), putShare: vi.fn(async () => ({})), revokeShare: vi.fn(async () => undefined) },
  };
  return { session, release };
}

const text = () => container.textContent ?? "";
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent === label || entry.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
};
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const type = async (value: string, placeholder?: string) => { await act(async () => { const field = (placeholder ? container.querySelector(`input[placeholder="${placeholder}"]`) : container.querySelector('input[type="text"]')) as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); };
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
  it("lists each organization's workspaces with their state, role and what waits, and only reads", async () => {
    world();
    mocks.catalog.getSnapshot = () => ({ loading: false, error: null, refreshedAt: 1, organizations: [
      { organization: { orgId: "org-1", name: "Acme", role: "member" }, error: null, loaded: true, workspaces: [
        item("fix-login", { runtimeActivity: { pendingApprovals: 2 }, repositories: [{ fullName: "acme/web", primary: true }], launch: { workBranch: "tx/fix-login" } }),
        item("old-work", { state: "suspended", you: { role: "viewer", canApprove: false }, sharedWith: 3 }),
      ] },
      { organization: { orgId: "org-2", name: "Beta", role: "admin" }, error: "cloud_provider_unavailable", loaded: true, workspaces: [] },
    ] });
    await show(<CloudScreen />);
    expect(text()).toContain("Acme");
    expect(button("fix-login, Running, 2 waiting for an answer, Can send").textContent).toContain("acme/web · tx/fix-login");
    expect(button("old-work, Stopped, View only, Shared with 3")).toBeTruthy();
    expect(text()).toContain("The cloud provider is not answering right now.");
    // Coming to the tab reads the list; nothing else is asked for.
    mocks.focus.at(-1)!();
    expect(mocks.catalog.refresh).toHaveBeenCalled();
    expect(mocks.catalog.retain).not.toHaveBeenCalled();
    await click("old-work, Stopped, View only, Shared with 3");
    expect(mocks.push).toHaveBeenCalledWith({ pathname: "/cloud/[workspaceId]", params: { workspaceId: "old-work", orgId: "org-1", title: "old-work" } });
  });

  it("says when there is nothing to see, and asks a signed-out person to sign in", async () => {
    world({ state: null });
    await show(<CloudScreen />);
    expect(text()).toContain("No cloud workspaces you can see.");
    mocks.app = { session: null, signIn: vi.fn() };
    await show(<CloudScreen />);
    await click("Sign in");
    expect(mocks.app.signIn).toHaveBeenCalled();
  });
});

describe("a cloud workspace screen", () => {
  it("shows a running workspace live and sends without asking", async () => {
    const { session, release } = world();
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Live · end-to-end encrypted");
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

  it("shows a stopped workspace's saved conversation and starts it only after the person confirms", async () => {
    const { session } = world({ state: "suspended" });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("Stopped. Showing the saved conversation; nothing is running.");
    expect(text()).toContain("run the tests");
    expect(container.querySelector("input")!.placeholder).toBe("Message (starts the workspace)");
    expect(session.send).not.toHaveBeenCalled();
    await type("continue");
    await click("Send");
    // Asked first; nothing sent yet.
    expect(session.send).not.toHaveBeenCalled();
    const [title, message, buttons] = mocks.alert.mock.calls[0];
    expect(title).toBe("Start this workspace?");
    expect(message).toContain("billed");
    expect(buttons.map((entry: { text: string }) => entry.text)).toEqual(["Cancel", "Start and send"]);
    expect(container.querySelector("input")!.getAttribute("aria-label")).toBe("Message for the agent. Sending starts the workspace.");
    // Cancel does nothing.
    buttons[0].onPress?.();
    expect(session.send).not.toHaveBeenCalled();
    await act(async () => buttons[1].onPress());
    expect(session.send).toHaveBeenCalledWith("t1", "continue", { allowWake: true });
  });

  it("gives a viewer the conversation and no way to send", async () => {
    world({ role: "viewer" });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("run the tests");
    expect(text()).toContain("View only");
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
    world({ state: "suspended", hasKey: false, noKey: true, events: [] });
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
