import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVmSetupAction, LocalVmSetupAuth, LocalVmSetupReport, LocalVmState } from "@/types/localVm";
import { environment, task } from "./localVm.testSupport";
import { setupReadiness, setupReport } from "./setup.testSupport";
import { deviceLoginUrl, loadPendingSetup, setupStorageKey } from "./setup";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), reconcile: vi.fn(), state: null as LocalVmState | null }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
vi.mock("./useLocalVmState", () => ({ useLocalVmState: () => ({ state: mocks.state, error: null, refreshing: false }), reconcileLocalVmState: mocks.reconcile, refreshLocalVmState: vi.fn() }));
import { EnvironmentsTab } from "./EnvironmentsTab";

const calls = (method: string) => mocks.invoke.mock.calls.filter(([, args]) => args.method === method);
const current = () => mocks.state!.environments.env;
function mount(report: LocalVmSetupReport | null = setupReport()) {
  mocks.state = { enabled: true, environments: { env: { ...environment, setup: report } }, tasks: {} };
  return render(<EnvironmentsTab />);
}
function confirm(action = "Verify desktop access") {
  fireEvent.click(screen.getByRole("button", { name: action }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByLabelText("I confirm this action in the displayed guest."));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm setup action" }));
}

beforeEach(() => { localStorage.clear(); mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue({ ready: true }); mocks.reconcile.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("guided local VM setup", () => {
  it("renders cached progress without guest probes or a manual runtime picker and rechecks only on request", async () => {
    mount();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "VM setup status" }).textContent).toBe("Setup needs your attention");
    expect(screen.getByRole("list", { name: "VM setup steps" }).textContent).toContain("Verify desktop access");
    expect(screen.getByRole("region", { name: "Guided VM setup" }).textContent).toContain("Not checked automatically");
    expect(screen.queryByLabelText("macOS arm64 guest runtime binary on this Mac")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install guest runtime" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh setup status" }));
    await waitFor(() => expect(calls("environment.setupReadiness")).toHaveLength(1));
    expect(calls("environment.setupReadiness")[0][1].params).toEqual({ environmentId: environment.id, generation: environment.generation, harness: "codex" });
    expect(mocks.invoke.mock.calls.map(([, args]) => args.method)).toEqual(["environment.setupReadiness"]);
    expect(screen.getByRole("status", { name: "VM setup status" }).textContent).toBe("Setup needs your attention");
  });

  it.each(["environmentId", "generation", "provider", "protocol", "runtime"])("fails closed on a cached report with changed %s binding", (field) => {
    const report = setupReport();
    if (field === "environmentId") report.environmentId = "other";
    if (field === "generation") report.generation = "other";
    if (field === "provider") report.readiness!.provider.harness = "claude";
    if (field === "protocol") Object.assign(report, { protocol: 2 });
    if (field === "runtime") report.readiness!.runtime.identity.generation = "other";
    mount(report);
    expect(screen.queryByRole("status", { name: "VM setup status" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify desktop access" })).toBeNull();
    expect((screen.getByRole("button", { name: "Set up this VM" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation and retains the exact request until a matching canonical action receipt", async () => {
    const report = setupReport();
    mocks.invoke.mockImplementation(async (_command, { params }) => ({ protocol: 1, ready: true, action: params.action, idempotencyKey: params.idempotencyKey, status: "complete" }));
    const view = mount(report);
    fireEvent.click(screen.getByRole("button", { name: "Verify desktop access" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Capture the guest desktop once");
    const send = within(dialog).getByRole("button", { name: "Confirm setup action" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByLabelText("I confirm this action in the displayed guest.")); fireEvent.click(send);
    await waitFor(() => expect(calls("environment.setupAction")).toHaveLength(1));
    const pending = loadPendingSetup(current())!;
    expect(calls("environment.setupAction")[0][1].params).toEqual(pending.params);
    expect(pending.params).toMatchObject({ environmentId: environment.id, generation: environment.generation, action: "desktop.verify", confirm: true });
    expect(loadPendingSetup(current())).toEqual(pending);
    expect(screen.getByRole("status", { name: "VM setup status" }).textContent).toBe("Setup needs your attention");
    current().setup = { ...report, action: { action: "desktop.verify", idempotencyKey: "other-key", status: "complete" } }; view.rerender(<EnvironmentsTab />);
    expect(loadPendingSetup(current())).toEqual(pending);
    current().setup = { ...report, action: { action: "driver.start", idempotencyKey: pending.params.idempotencyKey, status: "complete" } }; view.rerender(<EnvironmentsTab />);
    expect(loadPendingSetup(current())).toEqual(pending);
    current().setup = { ...report, action: { action: "desktop.verify", idempotencyKey: pending.params.idempotencyKey, status: "outcomeUnknown" } }; view.rerender(<EnvironmentsTab />);
    expect(loadPendingSetup(current())).toEqual(pending);
    current().setup = { ...report, action: { action: "desktop.verify", idempotencyKey: pending.params.idempotencyKey, status: "complete" } }; view.rerender(<EnvironmentsTab />);
    await waitFor(() => expect(localStorage.getItem(setupStorageKey(current()))).toBeNull());
  });

  it("does not replay on reload and retries identical action and key after a lost reply", async () => {
    mocks.invoke.mockRejectedValue(new Error("Setup reply lost"));
    const first = mount(); confirm();
    await screen.findByText(/Setup reply lost/);
    const saved = loadPendingSetup(current())!; first.unmount();
    mount();
    expect(calls("environment.setupAction")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Review saved setup request…" }));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByRole("button", { name: "Retry same setup request" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText("I confirm this action in the displayed guest.")); fireEvent.click(within(dialog).getByRole("button", { name: "Retry same setup request" }));
    await waitFor(() => expect(calls("environment.setupAction")).toHaveLength(2));
    expect(calls("environment.setupAction")[1][1].params).toEqual(saved.params);
    expect(mocks.reconcile).toHaveBeenCalled();
  });

  it("retains a pending action when the same environment changes provider settings", async () => {
    const first = mount(); confirm();
    await waitFor(() => expect(calls("environment.setupAction")).toHaveLength(1));
    const saved = loadPendingSetup(current())!; first.unmount();
    const report = setupReport({ harness: "claude", readiness: setupReadiness({ provider: { harness: "claude", state: "unknown", reasonCode: "provider_passive_auth_unsupported", actionCode: null, evidence: "notProbed" } }), action: { action: "desktop.verify", idempotencyKey: saved.params.idempotencyKey, status: "complete" } });
    mount(report);
    expect(loadPendingSetup(current())).toEqual(saved);
    expect((screen.getByRole("button", { name: "Review saved setup request…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.setupAction")).toHaveLength(1);
  });

  it.each(["working", "needsAttention", "ready"] as const)("does not derive desktop readiness from a running runtime while host status is %s", (status) => {
    mount(setupReport({ status }));
    expect(screen.getByRole("status", { name: "VM setup status" }).textContent).not.toBe("Setup ready");
    expect(screen.getByRole("region", { name: "Guided VM setup" }).textContent).toContain("Not checked automatically");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("persists before effects and refuses to send if storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Setup storage unavailable"); });
    mount(); confirm();
    await screen.findByText(/Setup storage unavailable/);
    expect(calls("environment.setupAction")).toHaveLength(0);
  });

  it.each(["manual", "tasks", "admission"])("offers no guest setup mutations while %s blocks admission", (condition) => {
    const readiness = setupReadiness();
    if (condition === "manual") readiness.manualControl = true;
    if (condition === "tasks") readiness.activeTaskTargets = [task().target];
    if (condition === "admission") readiness.actionAdmission.state = "unknown";
    mount(setupReport({ readiness }));
    expect(screen.queryByRole("button", { name: "Verify desktop access" })).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps verified permissions and authentication distinct from unknown passive evidence", () => {
    const report = setupReport({ steps: [{ id: "permissions", label: "Guest permissions", state: "complete", actionCode: "driver.requestPermissions" }, { id: "auth", label: "Guest sign-in", state: "complete", actionCode: "provider.codexDeviceLogin.start" }] });
    const view = mount(report);
    expect(screen.queryByRole("button", { name: "Review guest permissions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
    current().setup = { ...report, steps: report.steps.map((step) => step.id === "auth" ? { ...step, state: "waiting" } : step), readiness: setupReadiness({ provider: { state: "unknown", reasonCode: "provider_credential_store_requires_interaction", actionCode: "provider.codexDeviceLogin.start", harness: "codex", evidence: "notProbed" } }) };
    view.rerender(<EnvironmentsTab />);
    expect(screen.getByText(/This does not mean your guest is signed out/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review guest sign-in…" })).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalidates an action dialog on substantive report changes while allowing passive timestamp updates", () => {
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Verify desktop access" }));
    const dialog = screen.getByRole("dialog"); fireEvent.click(within(dialog).getByRole("checkbox"));
    current().setup = { ...current().setup!, lastCheckedAt: "2026-10-25T15:01:00Z" }; view.rerender(<EnvironmentsTab />);
    expect((within(dialog).getByRole("button", { name: "Confirm setup action" }) as HTMLButtonElement).disabled).toBe(false);
    current().setup = { ...current().setup!, readiness: setupReadiness({ manualControl: true }) }; view.rerender(<EnvironmentsTab />);
    expect((within(dialog).getByRole("button", { name: "Confirm setup action" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.setupAction")).toHaveLength(0);
  });

  it.each(["deleted", "generation"])("removes setup confirmation when the environment is %s", (change) => {
    const view = mount(); fireEvent.click(screen.getByRole("button", { name: "Verify desktop access" }));
    mocks.state!.environments.env = { ...current(), ...(change === "deleted" ? { deletedAt: "2026-10-25T15:01:00Z" } : { generation: "replacement" }) }; view.rerender(<EnvironmentsTab />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("environment.setupAction")).toHaveLength(0);
  });

  it("queues setup for an enrolled guest only after its provider and effects are confirmed", async () => {
    mount(null);
    const section = screen.getByRole("article", { name: "Environment Local guest" });
    fireEvent.change(within(section).getByLabelText("Guest AI provider"), { target: { value: "claude" } });
    confirm("Set up this VM");
    await waitFor(() => expect(calls("environment.setup")).toHaveLength(1));
    expect(calls("environment.setup")[0][1].params).toEqual({ environmentId: environment.id, generation: environment.generation, harness: "claude", idempotencyKey: expect.any(String), confirm: true });
    expect(calls("describe")).toHaveLength(0);
    expect(calls("environment.install")).toHaveLength(0);
  });

  it("reviews interrupted setup on the existing generation without replaying creation or guest prompts", async () => {
    mount(setupReport({ status: "outcomeUnknown" }));
    current().provision = { status: "outcomeUnknown", stages: [] };
    confirm("Review setup recovery…");
    await waitFor(() => expect(calls("environment.setup")).toHaveLength(1));
    expect(calls("environment.setup")[0][1].params).toMatchObject({ environmentId: environment.id, generation: environment.generation, confirm: true });
    expect(calls("environment.create")).toHaveLength(0);
    expect(calls("environment.setupAction")).toHaveLength(0);
  });
});

describe("guest-owned device sign-in observation", () => {
  const startKey = "owned-login-request";
  const loginReport = (action: LocalVmSetupAction = "provider.codexDeviceLogin.cancel") => setupReport({ steps: [{ id: "provider", label: "Guest sign-in", state: "waiting", actionCode: action }], action: { action: "provider.codexDeviceLogin.start", idempotencyKey: startKey, status: "needsAttention" } });
  function authReply(overrides: Partial<LocalVmSetupAuth> = {}): LocalVmSetupAuth {
    return { protocol: 1, environmentId: environment.id, generation: environment.generation, idempotencyKey: startKey, status: "none", ...overrides };
  }

  it("passively observes the same original key on reload and never restarts a missing actor", async () => {
    mocks.invoke.mockResolvedValue(authReply());
    const first = mount(loginReport());
    await waitFor(() => expect(calls("environment.setupAuth")).toHaveLength(1));
    expect(calls("environment.setupAuth")[0][1].params).toEqual({ environmentId: environment.id, generation: environment.generation, idempotencyKey: startKey });
    await screen.findByText(/original sign-in is unavailable or unresolved/);
    first.unmount(); mount(loginReport());
    await waitFor(() => expect(calls("environment.setupAuth")).toHaveLength(2));
    expect(calls("environment.setupAction")).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });

  it("rejects sign-in observations bound to another generation", async () => {
    mocks.invoke.mockResolvedValue(authReply({ generation: "replacement" }));
    mount(loginReport());
    await screen.findByText(/Sign-in status belongs to a changed guest or request/);
    expect((screen.getByRole("button", { name: "Cancel Codex sign-in" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.setupAction")).toHaveLength(0);
  });

  it("keeps the challenge in memory and cancels only its exact live actor with a new request key", async () => {
    // Synthetic fixture only. Real device challenges never enter source, journals, or test artifacts.
    const challenge = { loginId: "synthetic-actor", verificationUrl: "https://auth.openai.com/codex/device", userCode: "synthetic-only" };
    mocks.invoke.mockImplementation(async (_command, { method }) => method === "environment.setupAuth" ? authReply({ status: "awaitingUser", challenge }) : { accepted: true });
    // Unexpected fields are deliberately ignored by diagnostics, even on otherwise bound reports.
    mount(Object.assign(loginReport(), { challenge }));
    await screen.findByRole("link", { name: "Open Codex device sign-in" });
    expect(localStorage.length).toBe(0);
    confirm("Cancel Codex sign-in");
    await waitFor(() => expect(calls("environment.setupAction")).toHaveLength(1));
    const request = calls("environment.setupAction")[0][1].params;
    expect(request.action).toBe("provider.codexDeviceLogin.cancel");
    expect(request.idempotencyKey).not.toBe(startKey);
    expect(request.loginId).toBe(challenge.loginId);
    const saved = loadPendingSetup(current())!;
    expect(saved.kind === "action" && saved.loginRequestKey).toBe(startKey);
    const storage = localStorage.getItem(setupStorageKey(current()))!;
    for (const key of ["loginId", "userCode", "verificationUrl", "challenge"]) expect(storage.includes(key)).toBe(false);
    expect(storage.includes(challenge.userCode)).toBe(false);
    expect(screen.getByText("Setup diagnostics").closest("details")!.textContent).not.toContain(challenge.userCode);
  });

  it("allows only advertised same-actor cancellation through the setup helper admission hold", async () => {
    const report = loginReport();
    report.readiness!.actionAdmission = { state: "blocked", reasonCode: "guest_setup_helper_exit_unconfirmed", actionCode: "provider.codexDeviceLogin.cancel" };
    mocks.invoke.mockImplementation(async (_command, { method }) => method === "environment.setupAuth" ? authReply({ status: "awaitingUser", challenge: { loginId: "synthetic-live", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" } }) : {});
    mount(report);
    await screen.findByRole("link", { name: "Open Codex device sign-in" });
    expect(screen.queryByRole("button", { name: "Verify desktop access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
    confirm("Cancel Codex sign-in");
    await waitFor(() => expect(calls("environment.setupAction")).toHaveLength(1));
    expect(calls("environment.setupAction")[0][1].params).toMatchObject({ action: "provider.codexDeviceLogin.cancel", loginId: "synthetic-live" });
  });

  it("rejects sign-in links outside the exact supported HTTPS origin and device path", () => {
    for (const url of ["javascript:alert(1)", "file:///guest/code", "http://auth.openai.com/codex/device", "https://auth.openai.com:8443/codex/device", "https://auth.openai.com.evil.test/codex/device", "https://auth.openai.com/codex/device?code=value"]) expect(deviceLoginUrl(url)).toBeNull();
  });
});
