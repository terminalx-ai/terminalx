import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { organizationCompute, type ComputePolicyView, type ComputeUsageReport } from "@/lib/organizationCompute";
import { OrganizationCompute } from "./OrganizationCompute";

vi.mock("@/lib/organizationCompute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizationCompute")>()),
  organizationCompute: {
    policy: vi.fn(),
    usage: vi.fn(),
    updatePolicy: vi.fn(),
    setProvisioningPaused: vi.fn(),
  },
}));

const api = vi.mocked(organizationCompute);

const view = (overrides: Partial<ComputePolicyView> = {}, policy: Partial<ComputePolicyView["policy"]> = {}): ComputePolicyView => ({
  policy: {
    version: 3,
    maxWorkspaces: 4,
    maxRunningWorkspaces: 2,
    maxIdleSuspendMinutes: 30,
    allowedMachineClasses: { hetzner: ["cx22", "cx32"] },
    allowedLocations: {},
    provisioningPaused: false,
    pausedReason: null,
    pausedAt: null,
    pausedBy: null,
    updatedBy: "admin-1",
    updatedAt: 1,
    ...policy,
  },
  canEdit: true,
  counts: { workspaces: 3, running: 2 },
  workspaceCeiling: 10,
  contextRevision: "rev-1",
  ...overrides,
});

const report = (overrides: Partial<ComputeUsageReport> = {}): ComputeUsageReport => ({
  generatedAt: Date.UTC(2026, 8, 28),
  period: { start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 8, 28) },
  counts: { workspaces: 3, running: 2 },
  providers: [
    {
      provider: "hetzner",
      currency: "EUR",
      measured: { source: "terminalx-lifecycle", runtimeSeconds: 18_000, observedAt: Date.UTC(2026, 8, 28) },
      estimate: {
        source: "quoted-provider-rate",
        computeMicros: 50_000,
        retainedStorageMonthlyMicros: 1_000_000,
        retainedStorageUnpricedCount: 0,
        pricingObservedAt: Date.UTC(2026, 8, 26),
      },
      providerReported: { status: "delayed", currency: "EUR", totalMicros: 42_000, providerReportedAt: Date.UTC(2026, 8, 25) },
    },
    {
      provider: "box",
      currency: "USD",
      measured: { source: "terminalx-lifecycle", runtimeSeconds: 0, observedAt: null },
      estimate: { source: "quoted-provider-rate", computeMicros: 0, retainedStorageMonthlyMicros: 0, retainedStorageUnpricedCount: 1, pricingObservedAt: null },
      providerReported: { status: "unavailable" },
    },
  ],
  workspaces: [],
  retained: [
    {
      workspaceId: "ws-1",
      name: "api-staging",
      provider: "hetzner",
      kind: "archived-disk",
      diskGiB: 40,
      currency: "EUR",
      estimatedMonthlyMicros: 1_000_000,
      deleteAfter: Date.UTC(2026, 9, 28),
    },
  ],
  alerts: [
    { code: "provider-usage-delayed", severity: "warning", provider: "hetzner" },
    { code: "running-limit-reached", severity: "warning" },
  ],
  contextRevision: "rev-1",
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  api.policy.mockResolvedValue(view());
  api.usage.mockResolvedValue(report());
});
afterEach(cleanup);

it("explains who bills compute and that limits are not a spending cap", async () => {
  render(<OrganizationCompute contextRevision="account-1" />);
  const notice = await screen.findByLabelText("Billing responsibility");
  expect(notice.textContent).toContain("provider bills the account directly");
  expect(notice.textContent).toContain("separately from agent usage and from any TerminalX plan");
  expect(notice.textContent).toContain("not a spending cap");
  expect(screen.getByLabelText("Compute status").textContent).toContain("Workspaces 3 of 4");
});

it("separates measured runtime, estimates and delayed provider billing, and lists retained storage", async () => {
  render(<OrganizationCompute contextRevision="account-1" />);
  const hetzner = await screen.findByLabelText("Hetzner usage");
  expect(hetzner.textContent).toContain("5.0 h");
  expect(hetzner.textContent).toContain("from TerminalX records");
  expect(hetzner.textContent).toContain("at quoted rates");
  expect(hetzner.textContent).toContain("(delayed)");
  expect(screen.getByLabelText("Box usage").textContent).toContain("Not reported to TerminalX");
  const alerts = screen.getByRole("list", { name: "Compute alerts" });
  expect(alerts.textContent).toContain("billing report is out of date");
  expect(alerts.textContent).toContain("running limit is reached");
  const retained = screen.getByRole("list", { name: "Retained storage" });
  expect(within(retained).getByRole("listitem", { name: "api-staging" }).textContent).toContain("Archived · 40 GiB");
});

it("saves limits with the policy version and account context revision", async () => {
  api.updatePolicy.mockResolvedValue(view({}, { version: 4, maxWorkspaces: 6 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  fireEvent.change(await screen.findByLabelText("Maximum workspaces"), { target: { value: "6" } });
  fireEvent.change(screen.getByLabelText("Maximum running workspaces"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Allowed regions for Hetzner"), { target: { value: "fsn1, nbg1, fsn1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
  await waitFor(() =>
    expect(api.updatePolicy).toHaveBeenCalledWith(
      {
        expectedVersion: 3,
        maxWorkspaces: 6,
        maxRunningWorkspaces: null,
        maxIdleSuspendMinutes: 30,
        allowedMachineClasses: { hetzner: ["cx22", "cx32"] },
        allowedLocations: { hetzner: ["fsn1", "nbg1"] },
      },
      "rev-1",
    ),
  );
});

it("blocks invalid limits before sending", async () => {
  render(<OrganizationCompute contextRevision="account-1" />);
  fireEvent.change(await screen.findByLabelText("Maximum running workspaces"), { target: { value: "9" } });
  expect(screen.getByText(/no larger than the workspace limit/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Maximum workspaces"), { target: { value: "11" } });
  expect(screen.getByText(/from 1 to 10, the most this TerminalX service allows/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save limits" }) as HTMLButtonElement).disabled).toBe(true);
});

it("pauses new workspaces with a reason and reloads after a version conflict", async () => {
  api.setProvisioningPaused.mockRejectedValueOnce({ code: "cloud_compute_policy_conflict", status: 409, retryAfterSeconds: null });
  render(<OrganizationCompute contextRevision="account-1" />);
  fireEvent.change(await screen.findByLabelText("Pause reason"), { target: { value: "Budget review" } });
  fireEvent.click(screen.getByRole("button", { name: "Pause new workspaces" }));
  await waitFor(() => expect(api.setProvisioningPaused).toHaveBeenCalledWith(3, true, "Budget review", "rev-1"));
  expect(await screen.findByText(/Another admin changed these limits/)).toBeTruthy();
  await waitFor(() => expect(api.policy).toHaveBeenCalledTimes(2));

  api.policy.mockResolvedValue(view({}, { version: 5, provisioningPaused: true, pausedReason: "Budget review" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh cloud compute" }));
  expect(await screen.findByText(/New workspaces are paused: Budget review/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Allow new workspaces" })).toBeTruthy();
});

it("shows members read-only limits without usage or edit controls", async () => {
  api.policy.mockResolvedValue(view({ canEdit: false }));
  render(<OrganizationCompute contextRevision="account-1" />);
  const limits = await screen.findByLabelText("Compute limits");
  expect(limits.textContent).toContain("Only owners and admins can change compute limits.");
  expect(limits.textContent).toContain("Hetzner: sizes cx22, cx32; regions any");
  expect(screen.queryByRole("button", { name: "Save limits" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Pause new workspaces" })).toBeNull();
  expect(api.usage).not.toHaveBeenCalled();
});

it("drops results that land after the account context changed", async () => {
  let resolve: (value: ComputePolicyView) => void = () => {};
  api.policy.mockReturnValueOnce(new Promise((next) => (resolve = next)));
  api.policy.mockResolvedValueOnce(view({}, { maxWorkspaces: 9 }));
  const { rerender } = render(<OrganizationCompute contextRevision="account-1" />);
  rerender(<OrganizationCompute contextRevision="account-2" />);
  await screen.findByText("Workspaces 3 of 9");
  resolve(view({}, { maxWorkspaces: 1 }));
  await Promise.resolve();
  expect(screen.getByLabelText("Compute status").textContent).toContain("of 9");
});

it("keeps unsaved limit edits and the pause reason when a pause fails", async () => {
  api.setProvisioningPaused.mockRejectedValueOnce({ code: "organization_compute_unavailable", status: 503, retryAfterSeconds: null });
  render(<OrganizationCompute contextRevision="account-1" />);
  fireEvent.change(await screen.findByLabelText("Maximum workspaces"), { target: { value: "7" } });
  fireEvent.change(screen.getByLabelText("Pause reason"), { target: { value: "Budget review" } });
  fireEvent.click(screen.getByRole("button", { name: "Pause new workspaces" }));
  await screen.findByText(/could not reach the account service/);
  await waitFor(() => expect(api.policy).toHaveBeenCalledTimes(2));
  expect((screen.getByLabelText("Maximum workspaces") as HTMLInputElement).value).toBe("7");
  expect((screen.getByLabelText("Pause reason") as HTMLInputElement).value).toBe("Budget review");
});

it("keeps allow lists for providers this build does not edit and shows the pause once", async () => {
  api.policy.mockResolvedValue(
    view({}, { provisioningPaused: true, allowedLocations: { "local-docker": ["local"] } }),
  );
  api.usage.mockResolvedValue(report({ alerts: [{ code: "provisioning-paused", severity: "info" }] }));
  api.updatePolicy.mockResolvedValue(view());
  render(<OrganizationCompute contextRevision="account-1" />);
  expect(await screen.findAllByText(/New workspaces are paused/)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
  await waitFor(() =>
    expect(api.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({ allowedLocations: { "local-docker": ["local"] } }), "rev-1"),
  );
});
