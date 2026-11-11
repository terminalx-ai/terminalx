import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {}, errors: {}, info: {}, switching: {} }), isPtyFirst: () => false, startTabAgent: vi.fn(), clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn() }));
vi.mock("@/components/chat/Chat", () => ({ Chat: ({ footer }: { footer: ReactNode }) => <div>{footer}</div> }));
vi.mock("@/components/chat/Composer", () => ({ Composer: ({ draft, onDraftChange, onSend }: { draft: string; onDraftChange: (value: string) => void; onSend: (text: string, images: []) => void }) => <div><label>Parent composer<textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} /></label><button onClick={() => onSend(draft, [])}>Send to parent</button></div> }));
vi.mock("@/components/session/RecoveryBanner", () => ({ RecoveryBanner: () => null }));
vi.mock("@/components/session/ContinuationDialog", () => ({ ContinuationDialog: () => null }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
import { TabView } from "@/components/session/TabView";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { localSessionBackend } from "@/lib/sessionBackend";
import { getDraft, setDraft } from "@/lib/drafts";
import { bootSessions } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";
import type { LocalVmState } from "@/types/localVm";
import { reconcileLocalVmState } from "./useLocalVmState";
import { environment, makeTask, parentSessionId, parentTabId } from "./testFixtures";

let state: LocalVmState;
let session: SessionEntry;
beforeEach(async () => {
  localStorage.clear();
  setDraft(parentTabId, "");
  state = { environments: { [environment.id]: environment }, tasks: {} };
  session = { id: parentSessionId, projectPath: "/work", cwd: "/work", title: "Parent", created: "", modified: "", worktreeRemoved: false, archived: false, pinned: false, tabs: [{ id: parentTabId, harness: "codex", model: "gpt-6.1-sol", effort: "high", requestedModel: "unconfirmed-model", permissionMode: "manual", status: "idle", created: "", modified: "" }] };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "local_vm_request") {
      if (args.method === "state") return structuredClone(state);
      if (args.method === "task.submit") { const task = makeTask({ input: args.params.input, idempotencyKey: args.params.idempotencyKey }); state.tasks[task.target.taskId] = task; return task; }
      return null;
    }
    if (command === "list_projects") return { projects: [], lastSelected: null };
    if (command === "list_sessions") return [session];
    if (command === "list_harnesses") return [{ id: "codex", name: "Codex", available: true }];
    if (command === "send_message") return { events: [], queued: false };
    return [];
  });
  await bootSessions();
  await reconcileLocalVmState();
});
afterEach(cleanup);

it("dispatches the existing TabView composer draft to the guest without sending the parent agent", async () => {
  const parentSend = vi.fn(async () => ({ events: [], queued: false }));
  render(<TabView session={session} tab={session.tabs[0]} active backend={{ ...localSessionBackend(session.id), send: parentSend }} />);
  fireEvent.change(screen.getByLabelText("Parent composer"), { target: { value: "Check Safari inside the guest" } });
  fireEvent.click(await screen.findByRole("button", { name: "Run this task in Local Cua" }));
  expect(screen.getByLabelText("Selected VM task prompt").textContent).toBe("Check Safari inside the guest");
  fireEvent.change(screen.getByLabelText("Local environment"), { target: { value: environment.id } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand this VM/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send selected task to VM" }));
  await waitFor(() => expect(getDraft(parentTabId)).toBe(""));
  const requests = mocks.invoke.mock.calls.filter(([command, args]) => command === "local_vm_request" && args.method === "task.submit");
  expect(requests).toHaveLength(1);
  expect(requests[0][1].params.input).toMatchObject({ prompt: "Check Safari inside the guest", model: "gpt-6.1-sol", effort: "high", permissionMode: "manual", harness: "codex", desktop: true });
  expect(parentSend).not.toHaveBeenCalled();
  // The parent composer stays usable while the guest task holds a desktop lease.
  fireEvent.change(screen.getByLabelText("Parent composer"), { target: { value: "Keep working here" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to parent" }));
  await waitFor(() => expect(parentSend).toHaveBeenCalledWith(parentTabId, "Keep working here", []));
});

it("opens Settings Environments without mutating a VM", async () => {
  render(<SettingsPage initialTab="environments" onBack={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Environments" }).getAttribute("aria-current")).toBe("page");
  await screen.findByRole("form", { name: "Enroll existing local VM" });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "local_vm_request").every(([, args]) => args.method === "state")).toBe(true);
});

it("preserves a newer parent draft while a VM submission is being acknowledged", async () => {
  let acknowledge: () => void = () => {};
  const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
  const normal = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "local_vm_request" && args.method === "task.submit") await gate;
    return normal(command, args);
  });
  const parentSend = vi.fn(async () => ({ events: [], queued: false }));
  render(<TabView session={session} tab={session.tabs[0]} active backend={{ ...localSessionBackend(session.id), send: parentSend }} />);
  fireEvent.change(screen.getByLabelText("Parent composer"), { target: { value: "Run in guest" } });
  fireEvent.click(await screen.findByRole("button", { name: "Run this task in Local Cua" }));
  fireEvent.change(screen.getByLabelText("Local environment"), { target: { value: environment.id } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand this VM/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send selected task to VM" }));
  await waitFor(() => expect(mocks.invoke.mock.calls.some(([command, args]) => command === "local_vm_request" && args.method === "task.submit")).toBe(true));
  fireEvent.change(screen.getByLabelText("Parent composer"), { target: { value: "My next parent task" } });
  acknowledge();
  await screen.findByRole("article", { name: /Local VM task/ });
  expect(getDraft(parentTabId)).toBe("My next parent task");
  expect(parentSend).not.toHaveBeenCalled();
});
