import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { task } from "./localVm.testSupport";
import type { LocalVmJson, LocalVmTask } from "@/types/localVm";
import { loadRecovery, recoveryAcknowledged, recoveryStorageKey, type PendingLocalVmRecovery } from "./recovery";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), reconcile: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
vi.mock("./useLocalVmState", () => ({ reconcileLocalVmState: mocks.reconcile }));
import { LocalVmTaskCard } from "./LocalVmTaskCard";

const interrupted = (): LocalVmTask => task({ status: "outcomeUnknown", lastEventSeq: 4, providerConversationId: "retained-provider-conversation" });
const recoverCalls = () => mocks.invoke.mock.calls.filter(([, args]) => args.method === "task.recover");
const mount = (record = interrupted()) => render(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} />);
const newInstructions = "Inspect the created files and continue from the last verified change. Do not repeat earlier external actions.";

function confirmRecovery() {
  fireEvent.click(screen.getByRole("button", { name: "Resolve interrupted task…" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("New recovery instructions"), { target: { value: newInstructions } });
  fireEvent.click(within(dialog).getByLabelText(/I inspected the previous effects/));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm recovery instructions" }));
  return dialog;
}

beforeEach(() => { localStorage.clear(); mocks.invoke.mockReset(); mocks.reconcile.mockReset(); mocks.invoke.mockResolvedValue({ status: "running" }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("explicit interrupted task recovery", () => {
  it("requires new instructions and inspection confirmation and never treats the response as a resume acknowledgment", async () => {
    mocks.invoke.mockImplementation(async (_command, { params }) => ({ status: "running", events: [{ seq: 5, timestamp: "", payload: { type: "taskRecovered", idempotencyKey: params.idempotencyKey } }] }));
    const record = interrupted(); mount(record);
    fireEvent.click(screen.getByRole("button", { name: "Resolve interrupted task…" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Recovery never replays the original prompt");
    expect(dialog.textContent).toContain("guest OS must restart first");
    expect(dialog.textContent).toContain("retained-provider-conversation");
    expect(dialog.textContent).toContain("codex · gpt-6 · high · bypassPermissions");
    const instructions = within(dialog).getByLabelText("New recovery instructions") as HTMLTextAreaElement;
    expect(instructions.value).toBe("");
    fireEvent.change(instructions, { target: { value: newInstructions } });
    const confirm = within(dialog).getByRole("button", { name: "Confirm recovery instructions" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByLabelText(/I inspected the previous effects/));
    fireEvent.click(confirm);
    await waitFor(() => expect(recoverCalls()).toHaveLength(1));
    const saved = loadRecovery(record.target)!;
    expect(saved.afterSeq).toBe(4);
    expect(recoverCalls()[0][1].params).toEqual({ target: record.target, text: newInstructions, idempotencyKey: saved.request.idempotencyKey, confirm: true });
    expect(mocks.invoke.mock.calls.map(([, args]) => args.method)).toEqual(["task.recover"]);
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce());
    expect(loadRecovery(record.target)).toEqual(saved);
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    expect(screen.getByRole("article").textContent).toContain("Local VM · Outcome unknown");
    expect(screen.getByText(/Recovery acknowledgment pending/)).toBeTruthy();
    expect(record.input.prompt).toBe("Selected task");
  });

  it("retains the exact recovery text and key across a lost acknowledgment and reload until a matching journal checkpoint", async () => {
    const record = interrupted();
    mocks.invoke.mockRejectedValueOnce(new Error("recovery acknowledgment lost"));
    const first = mount(record); confirmRecovery();
    await screen.findByText(/recovery acknowledgment lost/);
    const saved = loadRecovery(record.target)!;
    first.unmount();
    const next = mount(record);
    expect(recoverCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Review saved recovery request…" }));
    const dialog = screen.getByRole("dialog");
    const instructions = within(dialog).getByLabelText("New recovery instructions") as HTMLTextAreaElement;
    expect(instructions.value).toBe(newInstructions);
    expect(instructions.disabled).toBe(true);
    const retry = within(dialog).getByRole("button", { name: "Retry same recovery request" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText(/I inspected the previous effects/));
    fireEvent.click(retry);
    await waitFor(() => expect(recoverCalls()).toHaveLength(2));
    expect(recoverCalls()[1][1].params).toEqual(saved.request);
    expect(loadRecovery(record.target)).toEqual(saved);
    // A running status alone, or a different operation's checkpoint, must not clear this retry.
    next.rerender(<LocalVmTaskCard task={{ ...record, status: "running", events: [{ seq: 5, timestamp: "", payload: { type: "taskRecovered", idempotencyKey: "other-request" } }] }} destinationRoot="/project" readOnly={false} />);
    expect(loadRecovery(record.target)).toEqual(saved);
    expect(screen.getByText(/Recovery acknowledgment pending/)).toBeTruthy();
    next.rerender(<LocalVmTaskCard task={{ ...record, status: "running", events: [{ seq: 5, timestamp: "", payload: { type: "taskRecovered", idempotencyKey: saved.request.idempotencyKey } }] }} destinationRoot="/project" readOnly={false} />);
    await waitFor(() => expect(localStorage.getItem(recoveryStorageKey(record.target))).toBeNull());
    expect(screen.queryByText(/Recovery acknowledgment pending/)).toBeNull();
  });

  it("keeps same-boot rejection explicit without replaying the original prompt or clearing the saved recovery", async () => {
    const record = interrupted();
    mocks.invoke.mockRejectedValue(new Error("Restart the guest OS; recovery on the same boot is refused"));
    mount(record); const dialog = confirmRecovery();
    await screen.findByText(/recovery on the same boot is refused/);
    expect(loadRecovery(record.target)?.request.text).toBe(newInstructions);
    expect(recoverCalls()[0][1].params.text).not.toBe(record.input.prompt);
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    expect(screen.getByRole("article").textContent).toContain("Local VM · Outcome unknown");
    expect(mocks.invoke.mock.calls.map(([, args]) => args.method)).toEqual(["task.recover"]);
  });

  it("does not send recovery if its retry record cannot be persisted", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage quota exceeded"); });
    mount(); confirmRecovery();
    await screen.findByText(/storage quota exceeded/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("refuses the original prompt or oversized text before saving or sending a recovery", () => {
    const record = interrupted(); mount(record);
    fireEvent.click(screen.getByRole("button", { name: "Resolve interrupted task…" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText(/I inspected the previous effects/));
    const instructions = within(dialog).getByLabelText("New recovery instructions");
    fireEvent.change(instructions, { target: { value: record.input.prompt } });
    expect(within(dialog).getByRole("alert").textContent).toContain("Recovery cannot replay the original prompt");
    expect((within(dialog).getByRole("button", { name: "Confirm recovery instructions" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(instructions, { target: { value: "x".repeat(256 * 1024 + 1) } });
    expect(within(dialog).getByRole("alert").textContent).toContain("256 KiB");
    expect((within(dialog).getByRole("button", { name: "Confirm recovery instructions" }) as HTMLButtonElement).disabled).toBe(true);
    expect(loadRecovery(record.target)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("never invents a provider conversation and refuses to replace unreadable saved recovery input", () => {
    const record = interrupted();
    const first = mount({ ...record, providerConversationId: null });
    fireEvent.click(screen.getByRole("button", { name: "Resolve interrupted task…" }));
    expect(screen.getByText(/Not retained; recovery is unavailable/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm recovery instructions" }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount();
    localStorage.setItem(recoveryStorageKey(record.target), "{broken");
    mount(record);
    expect(screen.getByRole("alert").textContent).toBeTruthy();
    expect((screen.getByRole("button", { name: "Resolve interrupted task…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("binds retry storage and acknowledgments to the full task target and later matching event sequence", () => {
    const record = interrupted();
    const saved: PendingLocalVmRecovery = { afterSeq: 4, request: { target: record.target, text: newInstructions, idempotencyKey: "recover-key", confirm: true } };
    localStorage.setItem(recoveryStorageKey(record.target), JSON.stringify(saved));
    const checkpoint = { seq: 5, timestamp: "", payload: { type: "taskRecovered", idempotencyKey: "recover-key" } };
    expect(recoveryAcknowledged({ ...record, events: [checkpoint] }, saved)).toBe(true);
    expect(recoveryAcknowledged({ ...record, events: [{ ...checkpoint, seq: 4 }] }, saved)).toBe(false);
    const rejectedPayloads: LocalVmJson[] = [null, [], { type: "taskRecovered" }, { type: "taskRecovered", idempotencyKey: "other-key" }, { payload: checkpoint.payload }];
    for (const payload of rejectedPayloads) {
      expect(recoveryAcknowledged({ ...record, events: [{ ...checkpoint, payload }] }, saved)).toBe(false);
    }
    for (const field of ["environmentId", "generation", "workspaceId", "taskId"] as const) {
      const replaced = { ...record.target, [field]: "replacement" };
      expect(loadRecovery(replaced)).toBeNull();
      expect(recoveryAcknowledged({ ...record, target: replaced, events: [checkpoint] }, saved)).toBe(false);
      localStorage.setItem(recoveryStorageKey(replaced), JSON.stringify(saved));
      expect(() => loadRecovery(replaced)).toThrow(/saved recovery request cannot be read/);
    }
  });
});
