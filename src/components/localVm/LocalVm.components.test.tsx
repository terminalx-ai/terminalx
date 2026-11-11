import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import type { LocalVmState, LocalVmSubmission } from "@/types/localVm";
import { EnvironmentsTab } from "./EnvironmentsTab";
import { LocalVmTasks, type LocalVmTasksProps } from "./LocalVmTasks";
import { TaskCard } from "./TaskCard";
import { reconcileLocalVmState } from "./useLocalVmState";
import { environment, makeTask, parentSessionId, parentTabId } from "./testFixtures";
import { submissionStorageKey } from "./submission";

let state: LocalVmState;
let props: LocalVmTasksProps;
const calls = (method: string) => mocks.invoke.mock.calls.filter(([command, args]) => command === "local_vm_request" && args.method === method).map(([, args]) => args.params);

beforeEach(async () => {
  localStorage.clear();
  state = { environments: { [environment.id]: { ...environment } }, tasks: {} };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command !== "local_vm_request") throw new Error(`Unexpected command ${command}`);
    if (args.method === "state") return structuredClone(state);
    if (args.method === "enroll") return environment;
    if (args.method === "doctor") return { compatible: false, reason: "Virtualization unavailable", cuaVersion: "0.7.0" };
    if (args.method === "environment.awake") state.environments[args.params.environmentId].keepAwake = args.params.enabled;
    if (args.method === "task.submit") {
      const task = makeTask({ input: args.params.input, idempotencyKey: args.params.idempotencyKey });
      state.tasks[task.target.taskId] = task;
      return task;
    }
    return null;
  });
  await reconcileLocalVmState();
  props = { sessionId: parentSessionId, tab: { id: parentTabId, harness: "claude", model: "claude-opus-5-5", effort: "high", permissionMode: "acceptEdits" }, conversation: null, sourceRoot: "/work", draft: "Verify the guest app", active: true, canSubmit: true, onDispatched: vi.fn() };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function chooseVm() {
  fireEvent.click(screen.getByRole("button", { name: "Run this task in Local Cua" }));
  fireEvent.change(await screen.findByLabelText("Local environment"), { target: { value: environment.id } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand this VM/ }));
}

describe("explicit environment management", () => {
  it("reads on opening, runs diagnostics explicitly, and enrolls an existing VM only after opt-in", async () => {
    render(<EnvironmentsTab />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Enroll VM" })).toBeTruthy());
    expect(mocks.invoke.mock.calls.every(([, args]) => args.method === "state")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Run compatibility checks" }));
    expect((await screen.findByLabelText("Cua doctor output")).textContent).toContain("Virtualization unavailable");
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Pilot guest" } });
    fireEvent.change(screen.getByLabelText("Existing Cua VM reference"), { target: { value: "local:pilot" } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Enroll VM" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I have already created this guest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Enroll VM" }));
    await waitFor(() => expect(calls("enroll")).toEqual([{ name: "Pilot guest", sandbox: "local:pilot" }]));
    expect(calls("environment.start")).toEqual([]);
  });

  it("routes lifecycle and awake controls and requires the VM-wide stop confirmation", async () => {
    const task = makeTask({ status: "running" }); state.tasks[task.target.taskId] = task;
    await reconcileLocalVmState();
    render(<EnvironmentsTab />);
    const card = await screen.findByRole("article", { name: "Environment Pilot guest" });
    fireEvent.click(within(card).getByRole("button", { name: "Start VM" }));
    await waitFor(() => expect(calls("environment.start")).toEqual([{ environmentId: environment.id }]));
    await waitFor(() => expect(within(card).getByRole<HTMLButtonElement>("button", { name: "Open desktop" }).disabled).toBe(false));
    fireEvent.click(within(card).getByRole("button", { name: "Open desktop" }));
    await waitFor(() => expect(calls("environment.desktop")).toHaveLength(1));
    await waitFor(() => expect(within(card).getByRole<HTMLButtonElement>("button", { name: "Install guest runtime" }).disabled).toBe(true));
    await waitFor(() => expect(within(card).getByRole<HTMLButtonElement>("button", { name: "Start VM" }).disabled).toBe(false));
    fireEvent.change(within(card).getByLabelText("macOS arm64 guest runtime binary on this Mac"), { target: { value: "/build/terminalx-serve" } });
    fireEvent.click(within(card).getByRole("button", { name: "Install guest runtime" }));
    await waitFor(() => expect(calls("environment.install")).toEqual([{ environmentId: environment.id, runtimePath: "/build/terminalx-serve" }]));
    await waitFor(() => expect(within(card).getByRole<HTMLButtonElement>("switch").disabled).toBe(false));
    fireEvent.click(within(card).getByRole("switch"));
    await waitFor(() => expect(calls("environment.awake")).toEqual([{ environmentId: environment.id, enabled: true }]));
    await waitFor(() => expect(within(card).getByRole<HTMLButtonElement>("button", { name: "Stop VM…" }).disabled).toBe(false));
    fireEvent.click(within(card).getByRole("button", { name: "Stop VM…" }));
    expect(calls("environment.stop")).toEqual([]);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("including tasks from other conversations");
    expect(dialog.textContent).toContain("1 unfinished task");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop VM and its tasks" }));
    await waitFor(() => expect(calls("environment.stop")).toEqual([{ environmentId: environment.id, confirm: true }]));
  });
});

describe("selected task dispatch and reconnection", () => {
  it("transfers only the selected draft and explicit files with unchanged parent settings", async () => {
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "inspect_local_path") return { path: args.path === "." ? "/work" : "/work/src/example.ts", kind: args.path === "." ? "directory" : "file", text: true };
      if (command === "read_text_file") return { content: "hello", size: 5, binary: false, truncated: false };
      return normal(command, args);
    });
    render(<LocalVmTasks {...props} />);
    await chooseVm();
    fireEvent.change(screen.getByLabelText(/Context files/), { target: { value: "src/example.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "Send selected task to VM" }));
    await waitFor(() => expect(calls("task.submit")).toHaveLength(1));
    const submitted = calls("task.submit")[0];
    expect(submitted).toMatchObject({ sourceRoot: "/work", input: { parentSessionId, parentTabId, environmentId: environment.id, prompt: props.draft, harness: "claude", model: "claude-opus-5-5", effort: "high", permissionMode: "acceptEdits", files: [{ path: "src/example.ts", bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }], desktop: true } });
    expect(submitted.input.parentMessageId).toMatch(/^local-vm::/);
    expect(Object.keys(submitted)).toEqual(["idempotencyKey", "sourceRoot", "input"]);
    await waitFor(() => expect(props.onDispatched).toHaveBeenCalledWith(props.draft));
    expect(await screen.findByRole("article", { name: /Local VM task/ })).toBeTruthy();
    expect(calls("environment.start")).toEqual([]);
  });

  it("collapses duplicate submit clicks into one request", async () => {
    render(<LocalVmTasks {...props} />);
    await chooseVm();
    const button = screen.getByRole("button", { name: "Send selected task to VM" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(calls("task.submit")).toHaveLength(1));
  });

  it("reopens a task after a lost acknowledgement without resending the prompt", async () => {
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      const response = await normal(command, args);
      if (args.method === "task.submit") throw new Error("Acknowledgement lost");
      return response;
    });
    const view = render(<LocalVmTasks {...props} />);
    await chooseVm();
    fireEvent.click(screen.getByRole("button", { name: "Send selected task to VM" }));
    await screen.findByText("Acknowledgement lost");
    expect(localStorage.getItem(submissionStorageKey(parentSessionId, parentTabId, null))).not.toBeNull();
    view.unmount();
    render(<LocalVmTasks {...props} />);
    await waitFor(() => expect(screen.getByRole("article", { name: /Local VM task/ })).toBeTruthy());
    expect(calls("task.submit")).toHaveLength(1);
    expect(calls("task.cancel")).toEqual([]);
    await waitFor(() => expect(localStorage.getItem(submissionStorageKey(parentSessionId, parentTabId, null))).toBeNull());
  });

  it("retries an unacknowledged submission only on an explicit click with exactly the same input and key", async () => {
    const normal = mocks.invoke.getMockImplementation()!;
    let fail = true;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (args.method === "task.submit" && fail) { fail = false; throw new Error("Disconnected"); }
      return normal(command, args);
    });
    const view = render(<LocalVmTasks {...props} />);
    await chooseVm();
    fireEvent.click(screen.getByRole("button", { name: "Send selected task to VM" }));
    await screen.findByText("Disconnected");
    const original: LocalVmSubmission = structuredClone(calls("task.submit")[0]);
    view.rerender(<LocalVmTasks {...props} draft="A different unsent parent prompt" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry same submission" }));
    await waitFor(() => expect(calls("task.submit")).toHaveLength(2));
    expect(calls("task.submit")[1]).toEqual(original);
  });

  it("polls durable status without replaying prompts or lifecycle actions", async () => {
    vi.useFakeTimers();
    const task = makeTask({ status: "running" }); state.tasks[task.target.taskId] = task;
    render(<LocalVmTasks {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(9100); });
    expect(calls("state").length).toBeGreaterThan(2);
    expect(calls("task.submit")).toEqual([]);
    expect(calls("environment.start")).toEqual([]);
    expect(calls("task.cancel")).toEqual([]);
  });

  it("keeps old conversations read-only and rejects a removed environment timeline", async () => {
    const task = makeTask({ status: "waiting" }); state.tasks[task.target.taskId] = task;
    await reconcileLocalVmState();
    const view = render(<LocalVmTasks {...props} canSubmit={false} />);
    expect(screen.queryByRole("button", { name: "Run this task in Local Cua" })).toBeNull();
    expect(screen.getByRole("article", { name: /Local VM task/ })).toBeTruthy();
    view.rerender(<LocalVmTasks {...props} conversation="new-conversation" key="new-conversation" />);
    expect(screen.queryByRole("article", { name: /Local VM task/ })).toBeNull();
    cleanup();
    render(<TaskCard task={task} environment={{ ...environment, generation: "new-timeline" }} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Open desktop" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop task" }).disabled).toBe(true);
  });
});

it("routes approvals, follow-ups, cancellation and desktop opening to the immutable task target", async () => {
  const task = makeTask({ status: "waiting", events: [{ seq: 1, timestamp: "2026-10-24T10:00:00Z", payload: { type: "permission_requested", requestId: "approval-1", title: "Run command in guest?", input: { command: "pwd" }, options: [{ id: "allow-once", label: "Allow once" }] } }] });
  render(<TaskCard task={task} environment={environment} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(calls("task.permission")).toHaveLength(1));
  expect(calls("task.permission")[0]).toMatchObject({ target: task.target, requestId: "approval-1", optionId: "allow-once" });
  await screen.findByText("Decision sent; waiting for the guest.");
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Open desktop" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
  await waitFor(() => expect(calls("environment.desktop")).toEqual([{ environmentId: environment.id }]));
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox").disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Follow up with this guest task"), { target: { value: "Check the guest browser too" } });
  fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
  await waitFor(() => expect(calls("task.followup")).toHaveLength(1));
  expect(calls("task.followup")[0]).toMatchObject({ target: task.target, text: "Check the guest browser too" });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop task" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
  await waitFor(() => expect(calls("task.cancel")).toEqual([{ target: task.target }]));
});
