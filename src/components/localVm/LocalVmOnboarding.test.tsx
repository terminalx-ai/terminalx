import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVmCreationCapability, LocalVmEnvironment } from "@/types/localVm";
import { environment } from "./localVm.testSupport";
import { setupReport } from "./setup.testSupport";
import { loadPendingSetup, setupStorageKey } from "./setup";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), reconcile: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
vi.mock("./useLocalVmState", () => ({ reconcileLocalVmState: mocks.reconcile }));
import { LocalVmOnboarding } from "./LocalVmOnboarding";

const calls = (method: string) => mocks.invoke.mock.calls.filter(([, args]) => args.method === method);
const unavailable: LocalVmCreationCapability = { protocol: 1, profileId: "macos-local-v1", available: false, firstAccountPersonalization: false, accountBoundTransport: false, reasonCode: "secureGuestBootstrapUnavailable" };
const mount = (environments: LocalVmEnvironment[] = []) => render(<LocalVmOnboarding enabled environments={environments} creation={unavailable} />);
function retainedCreation() {
  localStorage.setItem(setupStorageKey(), JSON.stringify({ kind: "create", params: { name: "My selected VM", vmName: "selected-mac", harness: "codex", idempotencyKey: "retained-creation", confirm: true } }));
  return loadPendingSetup()!;
}
function choose() {
  fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "My selected VM" } });
  fireEvent.change(screen.getByLabelText("New local VM name"), { target: { value: "selected-mac" } });
  fireEvent.change(screen.getByLabelText("Guest AI provider"), { target: { value: "codex" } });
  fireEvent.click(screen.getByLabelText(/I confirm creation and setup/));
}

beforeEach(() => { localStorage.clear(); mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue({ ready: true }); mocks.reconcile.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("one confirmed local VM onboarding", () => {
  it("does not offer fresh creation when the current profile cannot provision a secure guest account", () => {
    mount(); choose(); fireEvent.click(screen.getByRole("button", { name: "Create and set up VM" }));
    expect(calls("environment.create")).toHaveLength(0);
    expect(screen.getByText(/Secure guest account setup is unavailable/)).toBeTruthy();
  });
  it("discloses the candidate costs without treating a healthy host or partial capability as secure creation", () => {
    const view = mount();
    const profile = screen.getByRole("region", { name: "Local VM creation profile" });
    for (const text of ["creation unavailable", "24,212,741,210 bytes", "150 GiB sparse disk", "4 CPU", "8 GiB", "Cua CLI 0.7.0", "Lume 0.6.1"]) expect(profile.textContent).toContain(text);
    for (const creation of [undefined, { ...unavailable, available: true }, { ...unavailable, available: true, firstAccountPersonalization: true }, { ...unavailable, available: true, firstAccountPersonalization: true, accountBoundTransport: true, profileId: "unrecognized" }]) {
      view.rerender(<LocalVmOnboarding enabled environments={[]} creation={creation} />);
      choose(); fireEvent.submit(screen.getByRole("form", { name: "Create and set up local VM" }));
      expect(calls("environment.create")).toHaveLength(0);
      expect(localStorage.getItem(setupStorageKey())).toBeNull();
    }
    expect(screen.queryByText("Setup ready")).toBeNull();
  });

  it("retains an old lost-acknowledgment request across reload and rechecks without replaying creation", async () => {
    const saved = retainedCreation();
    const first = mount(); first.unmount(); mount();
    expect(loadPendingSetup()).toEqual(saved);
    expect((screen.getByLabelText("Environment name") as HTMLInputElement).disabled).toBe(true);
    const retry = screen.getByRole("button", { name: "Retry same VM setup request" });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole("button", { name: "Check retained creation" }));
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledTimes(1));
    expect(calls("environment.create")).toHaveLength(0);
    expect(loadPendingSetup()).toEqual(saved);
  });

  it("clears saved creation only for the exact canonical environment and setup queue receipt", async () => {
    const pending = retainedCreation();
    const view = mount();
    const report = setupReport({ harness: "codex", readiness: null, idempotencyKey: pending.params.idempotencyKey, status: "queued" });
    const enrolled = { ...environment, name: "My selected VM", sandbox: "local:selected-mac", setup: report };
    view.rerender(<LocalVmOnboarding enabled environments={[{ ...enrolled, setup: { ...report, idempotencyKey: "other-key" } }]} />);
    expect(loadPendingSetup()).toEqual(pending);
    view.rerender(<LocalVmOnboarding enabled environments={[{ ...enrolled, sandbox: "local:other" }]} />);
    expect(loadPendingSetup()).toEqual(pending);
    view.rerender(<LocalVmOnboarding enabled environments={[enrolled]} />);
    await waitFor(() => expect(localStorage.getItem(setupStorageKey())).toBeNull());
    expect((screen.getByLabelText("Environment name") as HTMLInputElement).value).toBe("");
  });

  it("recognizes the original creation queue after a later setup recovery replaced the current request", async () => {
    const pending = retainedCreation();
    const first = mount(); first.unmount();
    const prior = setupReport({ idempotencyKey: pending.params.idempotencyKey, status: "outcomeUnknown", readiness: null });
    const enrolled = { ...environment, name: "My selected VM", sandbox: "local:selected-mac", setup: setupReport({ idempotencyKey: "newer-recovery", history: [prior] }) };
    mount([enrolled]);
    await waitFor(() => expect(loadPendingSetup()).toBeNull());
    expect(calls("environment.create")).toHaveLength(0);
  });

  it("retains unreadable saved intent and reports acknowledgment-storage failure without sending another request", async () => {
    const pending = retainedCreation();
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Setup storage locked"); });
    const enrolled = { ...environment, name: "My selected VM", sandbox: "local:selected-mac", setup: setupReport({ idempotencyKey: pending.params.idempotencyKey }) };
    const first = mount([enrolled]);
    await screen.findByText(/Setup storage locked/);
    expect(loadPendingSetup()).toEqual(pending);
    expect(mocks.invoke).not.toHaveBeenCalled();
    first.unmount(); remove.mockRestore(); localStorage.setItem(setupStorageKey(), "{broken"); mount();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect((screen.getByLabelText("Use an existing VM instead") as HTMLInputElement).disabled).toBe(true);
  });

  it("recognizes a retained creation receipt even when the created environment was subsequently deleted", async () => {
    const pending = retainedCreation();
    const view = mount();
    const deleted = { ...environment, name: "My selected VM", sandbox: "local:selected-mac", deletedAt: "2026-10-25T15:00:00Z", setup: setupReport({ harness: "codex", readiness: null, idempotencyKey: pending.params.idempotencyKey }) };
    view.rerender(<LocalVmOnboarding enabled environments={[deleted]} />);
    await waitFor(() => expect(localStorage.getItem(setupStorageKey())).toBeNull());
    expect(calls("environment.create")).toHaveLength(0);
  });

  it("enrolls an existing guest without starting setup, querying models or copying credentials", async () => {
    mount(); fireEvent.click(screen.getByLabelText("Use an existing VM instead"));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Existing" } });
    fireEvent.change(screen.getByLabelText("Existing Cua VM reference"), { target: { value: "local:existing" } });
    const form = screen.getByRole("form", { name: "Enroll existing local VM" });
    fireEvent.click(within(form).getByLabelText(/I have already created this guest VM/));
    fireEvent.click(screen.getByRole("button", { name: "Enroll VM" }));
    await waitFor(() => expect(calls("enroll")).toHaveLength(1));
    expect(calls("enroll")[0][1].params).toEqual({ name: "Existing", sandbox: "local:existing" });
    expect(mocks.invoke.mock.calls.map(([, args]) => args.method)).toEqual(["enroll"]);
  });
});
