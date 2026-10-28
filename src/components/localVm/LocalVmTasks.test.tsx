import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVmState, LocalVmSubmission, LocalVmTask } from "@/types/localVm";
import { description, environment, session, tab, task } from "./localVm.testSupport";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), state: null as LocalVmState | null, reconcile: vi.fn(), listeners: new Set<() => void>() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
vi.mock("./useLocalVmState", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; };
  return {
    useLocalVmState: () => ({ state: useSyncExternalStore(subscribe, () => mocks.state), error: null, refreshing: false }),
    reconcileLocalVmState: mocks.reconcile,
    acknowledgeLocalVmTask: (task: LocalVmTask) => {
      mocks.state = { ...mocks.state!, tasks: { ...mocks.state!.tasks, [task.target.taskId]: task } };
      for (const listener of mocks.listeners) listener();
    },
  };
});
import { LocalVmTasks } from "./LocalVmTasks";
import { computerKey } from "@/types/computer";
import { submissionStorageKey } from "./submission";

const mount = (conversation: string | null = null, parent = session, parentTab = tab) => {
  const view = render(<LocalVmTasks session={parent} tab={parentTab} conversation={conversation} active readOnly={false} selectedPrompt="Only the selected composer task" />);
  const details = view.container.querySelector("details");
  if (details && !details.open) fireEvent.click(details.querySelector("summary")!);
  return view;
};
const calls = (method: string) => mocks.invoke.mock.calls.filter(([, args]) => args.method === method);

beforeEach(() => {
  localStorage.clear(); mocks.invoke.mockReset(); mocks.reconcile.mockReset();
  mocks.state = { enabled: true, environments: { env: environment }, tasks: {} };
  mocks.invoke.mockImplementation(async (_command, { method, params }) => {
    if (method === "computer.inventory") return { entries: [{ target: { kind: "macosGuest", environmentId: environment.id, generation: environment.generation }, name: "macOS · Local guest", capabilities: ["guestTask"], state: "requiresCapabilityCheck" }], notices: [] };
    if (method === "describe") return description;
    if (method === "task.submit") return task({ input: params.input, idempotencyKey: params.idempotencyKey });
    return null;
  });
});
afterEach(cleanup);

async function selectTask() {
  await screen.findByRole("option", { name: "macOS · Local guest" });
  fireEvent.change(screen.getByLabelText("Environment"), { target: { value: computerKey({ kind: "macosGuest", environmentId: environment.id, generation: environment.generation }) } });
  expect((screen.getByRole("button", { name: "Submit selected task" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check guest capabilities" }));
  await screen.findByText("Guest reports support for these inherited task settings.");
  fireEvent.click(screen.getByRole("button", { name: "Use current composer text" }));
}

describe("selected local VM tasks", () => {
  it("invalidates a checked generation after journal refresh without selecting its replacement", async () => {
    const view = mount(); await selectTask();
    expect(calls("describe")[0][1].params).toEqual({ environmentId: environment.id, generation: environment.generation });
    mocks.state = { ...mocks.state!, environments: { env: { ...environment, generation: "replacement" } } };
    view.rerender(<LocalVmTasks session={session} tab={tab} conversation={null} active readOnly={false} selectedPrompt="Only the selected composer task" />);
    expect((screen.getByRole("button", { name: "Submit selected task" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("task.submit")).toHaveLength(0);
  });

  it("retains a retry when an acknowledgment names another generation", async () => {
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (args.method === "task.submit") return task({ input: args.params.input, idempotencyKey: args.params.idempotencyKey, target: { ...task().target, generation: "replacement" } });
      return normal(command, args);
    });
    mount(); await selectTask();
    fireEvent.click(screen.getByRole("button", { name: "Submit selected task" }));
    await screen.findByText(/acknowledgment did not match/);
    const saved = JSON.parse(localStorage.getItem(submissionStorageKey(session.id, tab.id, null))!) as LocalVmSubmission;
    expect(saved.target).toEqual({ kind: "macosGuest", environmentId: environment.id, generation: environment.generation });
    expect(screen.getByRole("button", { name: "Retry same submission" })).toBeTruthy();
  });

  it.each([true, false])("binds the retained manual hold to the task environment generation (matching=%s)", (matching) => {
    mocks.state = { enabled: false, environments: { env: { ...environment, generation: matching ? environment.generation : "replacement-generation", manualControl: true } }, tasks: { task: task({ status: "canceled" }) } };
    mount();
    expect(!!screen.queryByRole("button", { name: "Return control to queued tasks" })).toBe(matching);
    expect(!!screen.queryByRole("status", { name: "Manual desktop control" })).toBe(matching);
    expect(mocks.invoke.mock.calls.filter(([, args]) => args.method !== "computer.inventory")).toHaveLength(0);
  });

  it("shows disconnected supervisor detail without opening task details or inferring a task outcome", () => {
    const retained = task();
    mocks.state = { enabled: true, environments: { env: environment }, tasks: { task: retained }, supervisor: { connected: false, lastSeenAt: "2026-10-24T00:00:00Z", detail: "Last heartbeat is stale" } };
    render(<LocalVmTasks session={session} tab={tab} conversation={null} active readOnly={false} selectedPrompt="" />);
    const banner = screen.getByRole("status", { name: "Local environment supervisor disconnected" });
    expect(banner.textContent).toContain("Local environment supervisor disconnected; these are last retained task states, reopen Settings to reconnect.");
    expect(banner.textContent).toContain("Last heartbeat is stale");
    expect(banner.closest("details")).toBeNull();
    expect(screen.getByRole("article", { name: "Local VM task task" }).textContent).toContain("Local VM · Running");
    expect(mocks.state.tasks.task.status).toBe("running");
    expect(mocks.invoke.mock.calls.filter(([, args]) => args.method !== "computer.inventory")).toHaveLength(0);
  });

  it.each(["absent", "connected", "disabled"])("does not show a disconnection banner when supervisor is %s", (condition) => {
    mocks.state = { enabled: condition !== "disabled", environments: {}, tasks: { task: task() }, ...(condition === "absent" ? {} : { supervisor: { connected: condition === "connected", lastSeenAt: null, detail: null } }) };
    render(<LocalVmTasks session={session} tab={tab} conversation={null} active readOnly={false} selectedPrompt="" />);
    expect(screen.queryByRole("status", { name: "Local environment supervisor disconnected" })).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([, args]) => args.method !== "computer.inventory")).toHaveLength(0);
  });

  it.each([null, "high"])("preserves provider-default model intent and inherited effort %s in the actual submission", async (effort) => {
    const parentTab = { ...tab, model: "", effort };
    mocks.invoke.mockImplementation(async (_command, { method, params }) => {
      if (method === "computer.inventory") return { entries: [{ target: { kind: "macosGuest", environmentId: environment.id, generation: environment.generation }, name: "macOS · Local guest", capabilities: ["guestTask"], state: "requiresCapabilityCheck" }], notices: [] };
    if (method === "describe") return { ...description, harnesses: [{ ...description.harnesses[0], models: [{ id: "", efforts: ["high"] }] }] };
      if (method === "task.submit") return task({ input: params.input, idempotencyKey: params.idempotencyKey });
      return null;
    });
    mount(null, { ...session, tabs: [parentTab] }, parentTab);
    expect(screen.getByText(/Inherited from this parent:/).textContent).toContain("Provider default");
    await selectTask();
    fireEvent.click(screen.getByRole("button", { name: "Submit selected task" }));
    await screen.findByRole("article", { name: "Local VM task task" });
    expect(calls("task.submit")[0][1].params.input).toMatchObject({ harness: "codex", model: "", effort, permissionMode: "bypassPermissions" });
    expect(screen.getByRole("article", { name: "Local VM task task" }).textContent).toContain("Provider default");
  });

  it.each([undefined, "github", "linear"])("submits an explicitly selected prompt with inherited settings for a %s parent", async (provider) => {
    const parent = { ...session, issue: provider ? { provider, id: "issue", identifier: "PRO-114", title: "Issue parent", url: "https://example.com/issue" } : null };
    mount(null, parent);
    expect(calls("describe")).toHaveLength(0);
    expect((screen.getByLabelText("Selected task prompt") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText(/Selected project context files/) as HTMLTextAreaElement).value).toBe("");
    await selectTask();
    fireEvent.click(screen.getByRole("button", { name: "Submit selected task" }));
    await waitFor(() => expect(calls("task.submit")).toHaveLength(1));
    const [command, { params }] = calls("task.submit")[0];
    expect(command).toBe("local_vm_request");
    expect(params).toEqual({ target: { kind: "macosGuest", environmentId: environment.id, generation: environment.generation }, idempotencyKey: expect.any(String), sourceRoot: session.cwd, input: {
      parentSessionId: session.id, parentTabId: tab.id, parentMessageId: expect.stringMatching(/^local-vm::/), environmentId: "env", prompt: "Only the selected composer task",
      harness: "codex", model: "gpt-6", effort: "high", permissionMode: "bypassPermissions", files: [], desktop: true,
    } });
    await screen.findByRole("article", { name: "Local VM task task" });
    expect(localStorage.getItem(submissionStorageKey(session.id, tab.id, null))).toBeNull();
  });

  it("retains the exact submission across a lost acknowledgment and reload, then retries it once", async () => {
    mocks.invoke.mockImplementation(async (_command, { method, params }) => {
      if (method === "computer.inventory") return { entries: [{ target: { kind: "macosGuest", environmentId: environment.id, generation: environment.generation }, name: "macOS · Local guest", capabilities: ["guestTask"], state: "requiresCapabilityCheck" }], notices: [] };
    if (method === "describe") return description;
      if (method === "task.submit") {
        if (calls("task.submit").length === 1) throw new Error("acknowledgment lost");
        return task({ input: params.input, idempotencyKey: params.idempotencyKey });
      }
      return null;
    });
    const first = mount(); await selectTask();
    fireEvent.click(screen.getByRole("button", { name: "Submit selected task" }));
    await screen.findByText(/acknowledgment lost/);
    const saved = JSON.parse(localStorage.getItem(submissionStorageKey(session.id, tab.id, null))!) as LocalVmSubmission;
    expect(saved).toEqual(calls("task.submit")[0][1].params);
    first.unmount(); mount();
    expect(screen.getByText("Submission awaiting acknowledgment")).toBeTruthy();
    expect(calls("task.submit")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry same submission" }));
    await waitFor(() => expect(calls("task.submit")).toHaveLength(2));
    expect(calls("task.submit")[1][1].params).toEqual(saved);
    await screen.findByRole("article", { name: "Local VM task task" });
  });

  it("blocks submission when the guest reports unavailable or a different inherited model", async () => {
    mocks.invoke.mockImplementation(async (_command, { method }) => method === "computer.inventory" ? { entries: [{ target: { kind: "macosGuest", environmentId: environment.id, generation: environment.generation }, name: "macOS · Local guest", capabilities: ["guestTask"], state: "requiresCapabilityCheck" }], notices: [] } : { ...description, available: false, reason: "Desktop adapter unavailable" });
    const view = mount();
    await screen.findByRole("option", { name: "macOS · Local guest" });
  fireEvent.change(screen.getByLabelText("Environment"), { target: { value: computerKey({ kind: "macosGuest", environmentId: environment.id, generation: environment.generation }) } });
    fireEvent.click(screen.getByRole("button", { name: "Check guest capabilities" }));
    await screen.findByText("Desktop adapter unavailable");
    expect((screen.getByRole("button", { name: "Submit selected task" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("task.submit")).toHaveLength(0);
    mocks.invoke.mockResolvedValue({ ...description, harnesses: [{ ...description.harnesses[0], models: [] }] });
    fireEvent.click(screen.getByRole("button", { name: "Check guest capabilities" }));
    await screen.findByText("The inherited model gpt-6 is unavailable in the guest.");
    view.unmount();
  });

  it("keeps retained cards within their exact parent session, tab and conversation even after opt-out", () => {
    const current = task({ status: "completed", outcome: "Recorded guest result" });
    const otherConversation = task({ target: { ...current.target, taskId: "other-conversation" }, input: { ...current.input, parentMessageId: "local-vm:other:message" } });
    const otherTab = task({ target: { ...current.target, taskId: "other-tab" }, input: { ...current.input, parentTabId: "other-tab" } });
    const otherSession = task({ target: { ...current.target, taskId: "other-session" }, input: { ...current.input, parentSessionId: "other-session" } });
    mocks.state = { enabled: false, environments: {}, tasks: Object.fromEntries([current, otherConversation, otherTab, otherSession].map((item) => [item.target.taskId, item])) };
    mount();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Recorded guest result")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Submit selected task to local VM" })).toBeNull();
  });

  it("does not replace an unreadable saved submission with new work", () => {
    localStorage.setItem(submissionStorageKey(session.id, tab.id, null), "{broken");
    mount();
    expect(screen.getByRole("alert").textContent).toContain("Check retained task history");
    expect(screen.queryByRole("button", { name: "Submit selected task" })).toBeNull();
    expect(calls("task.submit")).toHaveLength(0);
  });
});
