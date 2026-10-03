// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudScreen from "../app/(tabs)/cloud";
import CloudWorkspaceScreen from "../app/cloud/[workspaceId]";

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
    Platform: { OS: "web", select: ({ default: fallback }: any) => fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: any) => <button disabled={disabled} aria-label={accessibilityLabel} aria-pressed={accessibilityState?.selected} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
    TextInput: ({ value, onChangeText, placeholder, editable }: any) => <input value={value} disabled={editable === false} onInput={(event) => onChangeText(event.currentTarget.value)} placeholder={placeholder} />,
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: any) => <div>{ListHeaderComponent}{data.length ? data.map((item: unknown, index: number) => <div key={index}>{renderItem({ item })}</div>) : ListEmptyComponent}{ListFooterComponent}</div>,
    SectionList: ({ sections, renderItem, renderSectionHeader, renderSectionFooter, ListHeaderComponent, ListEmptyComponent }: any) => <div>{ListHeaderComponent}{sections.length ? sections.map((section: any) => <div key={section.key}>{renderSectionHeader({ section })}{section.data.map((item: any) => <div key={item.workspace.id}>{renderItem({ item })}</div>)}{renderSectionFooter({ section })}</div>) : ListEmptyComponent}</div>,
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  EmptyState: ({ title, detail }: any) => <div>{title} {detail}</div>, StatusDot: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let counter = 0;

const event = (seq: number, payload: Record<string, unknown>) => ({ id: `e${seq}`, sessionId: "s1", tabId: "t1", harness: "claude", seq, ts: "2026-10-03T00:00:00Z", payload });
const item = (id: string, fields: Record<string, unknown> = {}) => ({ workspace: { id, orgId: "org-1", name: id, provider: "box", state: "ready", you: { role: "driver", canApprove: false }, ...fields }, latestOperation: null });

function world(options: { state?: string | null; role?: string | null; canApprove?: boolean; hasKey?: boolean; events?: unknown[]; outbox?: unknown[]; connection?: string; noKey?: boolean; tabs?: number } = {}) {
  const state = options.state === undefined ? "ready" : options.state;
  const snapshot = {
    connection: { state: options.connection ?? (state === "ready" ? "connected" : "suspended") },
    problem: null,
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
    outbox: { isDeciding: () => false },
  };
  const release = vi.fn();
  const listed = state === null ? null : item("ws-1", { name: "fix-login", state }).workspace;
  const organizations = [{ organization: { orgId: "org-1", name: "Acme", role: "member" }, workspaces: listed ? [{ workspace: listed, latestOperation: null }] : [], error: null, loaded: true }];
  mocks.catalog = {
    getSnapshot: () => ({ organizations, loading: false, error: null, refreshedAt: 1 }),
    refresh: vi.fn(async () => undefined),
    workspace: () => listed,
    retain: vi.fn(() => release),
    opened: () => session,
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
const type = async (value: string) => { await act(async () => { const field = container.querySelector("input")!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); };
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
    expect(text()).toContain("Only someone allowed to approve can answer this request.");
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
    await act(async () => { [...container.querySelectorAll("button")].find((found) => found.textContent === "Cancel")!.click(); });
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

    world({ state: null, connection: "stopped" });
    await show(<CloudWorkspaceScreen />);
    expect(text()).toContain("This workspace is no longer available to you.");
    expect(container.querySelector("input")).toBeNull();
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
