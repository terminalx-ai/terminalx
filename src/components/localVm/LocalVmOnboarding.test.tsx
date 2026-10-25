import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVmEnvironment } from "@/types/localVm";
import { environment } from "./localVm.testSupport";
import { setupReport } from "./setup.testSupport";
import { loadPendingSetup, setupStorageKey } from "./setup";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), reconcile: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
vi.mock("./useLocalVmState", () => ({ reconcileLocalVmState: mocks.reconcile }));
import { LocalVmOnboarding } from "./LocalVmOnboarding";

const calls = (method: string) => mocks.invoke.mock.calls.filter(([, args]) => args.method === method);
const mount = (environments: LocalVmEnvironment[] = []) => render(<LocalVmOnboarding enabled environments={environments} />);
function choose() {
  fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "My selected VM" } });
  fireEvent.change(screen.getByLabelText("New local VM name"), { target: { value: "selected-mac" } });
  fireEvent.change(screen.getByLabelText("Guest AI provider"), { target: { value: "claude" } });
  fireEvent.click(screen.getByLabelText(/I confirm creation and setup/));
}

beforeEach(() => { localStorage.clear(); mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue({ ready: true }); mocks.reconcile.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("one confirmed local VM onboarding", () => {
  it("discloses pinned image, resource and tool costs before one creation that automatically queues setup", async () => {
    mount();
    expect(mocks.invoke).not.toHaveBeenCalled();
    const profile = screen.getByRole("region", { name: "Local VM creation profile" });
    for (const text of ["24,212,741,210 bytes", "150 GiB sparse disk", "4 CPU", "8 GiB", "Cua CLI 0.7.0", "Lume 0.6.1", "Cua Driver 0.28.0", "provider’s usage and plan costs", "additional disk space"]) expect(profile.textContent).toContain(text);
    choose(); fireEvent.click(screen.getByRole("button", { name: "Create and set up VM" }));
    await waitFor(() => expect(calls("environment.create")).toHaveLength(1));
    const pending = loadPendingSetup()!;
    expect(calls("environment.create")[0][1].params).toEqual(pending.params);
    expect(pending.params).toMatchObject({ name: "My selected VM", vmName: "selected-mac", harness: "claude", confirm: true });
    expect(mocks.invoke.mock.calls.map(([, args]) => args.method)).toEqual(["environment.create"]);
    expect(screen.queryByText("Setup ready")).toBeNull();
  });

  it("retains the exact request across a lost reply and reload and never replays it on mount", async () => {
    mocks.invoke.mockRejectedValue(new Error("Create acknowledgment lost"));
    const first = mount(); choose(); fireEvent.click(screen.getByRole("button", { name: "Create and set up VM" }));
    await screen.findByText(/Create acknowledgment lost/);
    const saved = loadPendingSetup()!; first.unmount(); mount();
    expect(calls("environment.create")).toHaveLength(1);
    expect((screen.getByLabelText("Environment name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Guest AI provider") as HTMLSelectElement).value).toBe("claude");
    const retry = screen.getByRole("button", { name: "Retry same VM setup request" });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I confirm creation and setup/)); fireEvent.click(retry);
    await waitFor(() => expect(calls("environment.create")).toHaveLength(2));
    expect(calls("environment.create")[1][1].params).toEqual(saved.params);
    expect(mocks.reconcile).toHaveBeenCalled();
  });

  it("clears saved creation only for the exact canonical environment and setup queue receipt", async () => {
    const view = mount(); choose(); fireEvent.click(screen.getByRole("button", { name: "Create and set up VM" }));
    await waitFor(() => expect(calls("environment.create")).toHaveLength(1));
    const pending = loadPendingSetup()!;
    const report = setupReport({ harness: "claude", readiness: null, idempotencyKey: pending.params.idempotencyKey, status: "queued" });
    const enrolled = { ...environment, name: "My selected VM", sandbox: "local:selected-mac", setup: report };
    view.rerender(<LocalVmOnboarding enabled environments={[{ ...enrolled, setup: { ...report, idempotencyKey: "other-key" } }]} />);
    expect(loadPendingSetup()).toEqual(pending);
    view.rerender(<LocalVmOnboarding enabled environments={[{ ...enrolled, sandbox: "local:other" }]} />);
    expect(loadPendingSetup()).toEqual(pending);
    view.rerender(<LocalVmOnboarding enabled environments={[enrolled]} />);
    await waitFor(() => expect(localStorage.getItem(setupStorageKey())).toBeNull());
    expect((screen.getByLabelText("Environment name") as HTMLInputElement).value).toBe("");
  });

  it("does not create when the durable request cannot be saved or is unreadable", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Setup storage full"); });
    const first = mount(); choose(); fireEvent.click(screen.getByRole("button", { name: "Create and set up VM" }));
    await screen.findByText(/Setup storage full/);
    expect(mocks.invoke).not.toHaveBeenCalled();
    first.unmount(); storage.mockRestore(); localStorage.setItem(setupStorageKey(), "{broken"); mount();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create and set up VM" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("recognizes a retained creation receipt even when the created environment was subsequently deleted", async () => {
    const view = mount(); choose(); fireEvent.click(screen.getByRole("button", { name: "Create and set up VM" }));
    await waitFor(() => expect(calls("environment.create")).toHaveLength(1));
    const pending = loadPendingSetup()!;
    const deleted = { ...environment, name: "My selected VM", sandbox: "local:selected-mac", deletedAt: "2026-10-25T15:00:00Z", setup: setupReport({ harness: "claude", readiness: null, idempotencyKey: pending.params.idempotencyKey }) };
    view.rerender(<LocalVmOnboarding enabled environments={[deleted]} />);
    await waitFor(() => expect(localStorage.getItem(setupStorageKey())).toBeNull());
    expect(calls("environment.create")).toHaveLength(1);
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
