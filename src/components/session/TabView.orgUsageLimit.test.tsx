import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ loginPanes: [] as { id: string; exited: boolean }[], invoke: vi.fn(), openTerminal: vi.fn(), enterTerminalView: vi.fn(), answerPermission: (_request: string, _option: string): void => {}, views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {}, waiting: {} } , readiness: [] as string[], logins: vi.fn(), runtimeAgents: [] as { id: string }[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => true, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), forgetClosedTabViews: vi.fn(), leaveTerminalView: vi.fn(),
  enterTerminalView: mocks.enterTerminalView,
}));
vi.mock("@/lib/terminal", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/terminal")>();
  return { ...original, openTerminal: mocks.openTerminal,
    getTerminalState: () => ({ ...original.getTerminalState(), panes: mocks.loginPanes }),
  };
});
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => <div>Terminal output</div> }));
vi.mock("@/components/chat/Chat", async importOriginal => {
  const { Chat } = await importOriginal<typeof import("@/components/chat/Chat")>();
  return { Chat: (props: React.ComponentProps<typeof Chat>) => {
    mocks.answerPermission = props.onAnswerPermission;
    return <Chat {...props} />;
  } };
});
vi.mock("@/components/chat/Composer", () => ({ Composer: ({ draft }: { draft: string }) => <textarea aria-label="Unsent prompt" value={draft} readOnly /> }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: ({ onClose, onDelivered }: {
  onClose: () => void; onDelivered: (to: { sessionId: string; tabId: string }) => void;
}) => <div role="dialog" aria-label="Continue dialog">
  <button onClick={onClose}>Dismiss continuation</button>
  <button onClick={() => { onDelivered({ sessionId: "destination", tabId: "destination-tab" }); onClose(); }}>Deliver continuation</button>
</div> }));

vi.mock("./RemoteHandoffDialog", () => ({ RemoteHandoffDialog: ({ agent, purpose }: { agent: string; purpose: { kind: string } }) =>
  <div role="dialog" aria-label="Hand off on the runtime">{`${agent} ${purpose.kind}`}</div> }));
vi.mock("@/lib/cloudModels", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/cloudModels")>();
  return { ...original, useRuntimeModels: (client: unknown) => client ? { agents: mocks.runtimeAgents, models: [] } : null,
    usePickerModels: () => ({ models: [], refresh: async () => undefined, loaded: true, foreign: false }) };
});
vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-in", identity: { name: null, email: "member@example.com", organization: "Acme", organizationId: "org-1" }, expiresAt: null, lastError: null,
    get phase2Readiness() { return { "org-1": mocks.readiness }; }, organizations: [{ id: "org-1", name: "Acme Robotics", cloud: { enabled: true, flags: {} }, role: "member" }] } };
  return { useAccount: () => account, getAccount: () => account, subscribeAccount: () => () => undefined, refreshAccount: vi.fn() };
});
vi.mock("@/lib/api", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, api: { ...original.api, cloudAgentLogins: mocks.logins } };
});

import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyEvent } from "@/lib/agentEvents";
import { getSessionStore, removeSessions, upsertSession, useSessionStore, selectSession } from "@/lib/sessions";
import { localSessionBackend, type SessionBackend } from "@/lib/sessionBackend";

let seq = 0;
let session: SessionEntry;
const event = (payload: Payload): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: session.id, tabId: session.tabs[0].id, harness: "codex", ts: new Date().toISOString(), payload });
const emit = (payload: Payload) => act(() => applyEvent(event(payload)));

/**
 * A cloud tab's backend, as far as the card reads it: the workspace key, a cloud backend's caps (no recovery card
 * of its own), the runtime's handoff and model reading, and which login the runtime says the tab started with.
 */
function cloudBackend(login: "organization" | "route" | null): SessionBackend {
  const local = localSessionBackend(session.id);
  return { ...local, key: "cloud:org-1:ws-1", caps: { ...local.caps, local: false, recovery: false }, agentLogin: () => login,
    handoff: {} as NonNullable<SessionBackend["handoff"]>, modelClient: {} as NonNullable<SessionBackend["modelClient"]> };
}
function Harness({ backend }: { backend: SessionBackend }) {
  const store = useSessionStore();
  const current = store.sessions.find(s => s.id === session.id)!;
  return <TooltipProvider><TabView session={current} tab={current.tabs[0]} active backend={backend} /></TooltipProvider>;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  session = { id: `session${++seq}`, projectPath: "/workspace", cwd: "/workspace", title: "Usage limit test", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `tab${seq}`, harness: "codex", model: "original", permissionMode: "default", status: "in_progress", created: "", modified: "" }] };
  mocks.views.views = { [session.tabs[0].id]: "chat" };
  mocks.readiness = ["cloud.agent-logins.usage-limit-card.v1"];
  mocks.runtimeAgents = [{ id: "codex" }, { id: "claude" }];
  mocks.logins.mockReset().mockRejectedValue({ code: "organization_admin_required" });
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "load_tab_events" || command === "list_workspaces") return [];
    if (command === "check_agent_readiness") return { state: "ready", checkedAt: null, version: null };
    if (command === "list_models") return [];
    return null;
  });
  upsertSession(session);
  selectSession(session.id);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  removeSessions(getSessionStore().sessions.map(s => s.id));
});

const hitLimit = () => {
  emit({ type: "rate_limited", status: "rejected", window: "five_hour", resetsAt: Date.now() + 3_600_000 });
  emit({ type: "recovery", kind: "usage_limit" });
};

describe("the organization's usage-limit card in a cloud tab (PRO-200)", () => {
  it("shows when the tab runs on the organization's login, and keeps the card's recovery", async () => {
    render(<Harness backend={cloudBackend("organization")} />);
    hitLimit();
    expect(screen.getByText("Codex usage limit reached")).toBeTruthy();
    expect(screen.getByTestId("org-usage-limit").textContent).toContain("The Codex login Acme Robotics set for cloud workspaces is out of usage until");
    expect(screen.getByTestId("usage-limit-copy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop session" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Choose another model" })).toBeTruthy();
    await waitFor(() => expect(mocks.logins).toHaveBeenCalledWith("org-1"));
  });

  it("switches to the other agent, and continues in a new session, on the runtime", () => {
    render(<Harness backend={cloudBackend("organization")} />);
    hitLimit();
    act(() => screen.getByTestId("usage-limit-switch").click());
    expect(screen.getByRole("dialog", { name: "Hand off on the runtime" }).textContent).toBe("claude continue");
    cleanup();
    render(<Harness backend={cloudBackend("organization")} />);
    hitLimit();
    act(() => screen.getByRole("button", { name: "Continue in new session" }).click());
    expect(screen.getByRole("dialog", { name: "Hand off on the runtime" }).textContent).toBe("codex continue");
  });

  it("offers no Switch, nor a new session, where the runtime cannot open the tab", () => {
    mocks.runtimeAgents = [];
    render(<Harness backend={cloudBackend("organization")} />);
    hitLimit();
    expect(screen.getByTestId("usage-limit-copy")).toBeTruthy();
    expect(screen.queryByTestId("usage-limit-switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue in new session" })).toBeNull();
  });

  // A cloud backend draws no recovery card of its own: only the organization's login gets one.
  it.each([["route", "route"], ["a runtime that does not say", null]] as const)("draws no card on %s", (_, login) => {
    render(<Harness backend={cloudBackend(login)} />);
    hitLimit();
    expect(screen.queryByText("Usage limit reached")).toBeNull();
    expect(screen.queryByTestId("org-usage-limit")).toBeNull();
    expect(mocks.logins).not.toHaveBeenCalled();
  });

  it("draws no card while the readiness key is off", () => {
    mocks.readiness = [];
    render(<Harness backend={cloudBackend("organization")} />);
    hitLimit();
    expect(screen.queryByText("Usage limit reached")).toBeNull();
    expect(screen.queryByTestId("org-usage-limit")).toBeNull();
  });
});
