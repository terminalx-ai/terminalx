import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { organizationCompute, type ComputePolicyView, type ComputeUsageReport } from "@/lib/organizationCompute";
import { OrganizationCompute } from "./OrganizationCompute";
import { rememberCloudProviders } from "@/lib/cloudProviders";
import type { CloudProviderSummary } from "@/lib/api";
import { describedAs } from "@/test/cloudProviderDescriptors";

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
  noLimitAware: false,
  runningWorkspaceCeiling: null,
  createBudgetDefaults: null,
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
  // The rows and names come from the providers the server describes
  // (PRO-415); Machine0 is described as hidden, as the server does while it
  // keeps Machine0 off.
  rememberCloudProviders(
    [describedAs("box"), describedAs("hetzner"), describedAs("machine0", { listed: false })].map((descriptor) => ({ id: descriptor.id, descriptor }) as CloudProviderSummary),
  );
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
  const hetzner = await screen.findByLabelText("Hetzner Cloud usage");
  expect(hetzner.textContent).toContain("5.0 h");
  expect(hetzner.textContent).toContain("from TerminalX records");
  expect(hetzner.textContent).toContain("at quoted rates");
  expect(hetzner.textContent).toContain("(delayed)");
  expect(screen.getByLabelText("Boat usage").textContent).toContain("Not reported to TerminalX");
  const alerts = screen.getByRole("list", { name: "Compute alerts" });
  expect(alerts.textContent).toContain("billing report is out of date");
  expect(alerts.textContent).toContain("running limit is reached");
  const retained = screen.getByRole("list", { name: "Retained storage" });
  expect(within(retained).getByRole("listitem", { name: "api-staging" }).textContent).toContain("Archived · 40 GiB");
  // No provider TerminalX itself provides is described here, so nothing is said of one.
  expect(screen.queryByTestId("compute-platform-billing")).toBeNull();
});

// PRO-452: a provider TerminalX itself provides has no account or console of the organization's.
it("says a platform provider has no provider account to connect and no provider invoice, and limits it like any other", async () => {
  rememberCloudProviders(
    [describedAs("terminalx-cloud"), describedAs("box"), describedAs("hetzner")].map((descriptor) => ({ id: descriptor.id, descriptor }) as CloudProviderSummary),
  );
  const usage = report();
  const unreported = usage.providers[1]!;
  api.usage.mockResolvedValue({ ...usage, providers: [{ ...unreported, provider: "terminalx-cloud" }, unreported] });
  render(<OrganizationCompute contextRevision="account-1" />);
  const platform = await screen.findByLabelText("TerminalX Cloud usage");
  expect(platform.textContent).toContain("Billed by TerminalX. There is no provider invoice for it.");
  expect(platform.textContent).not.toContain("provider's console");
  // An organization's provider reads as before.
  expect(screen.getByLabelText("Boat usage").textContent).toContain("Not reported to TerminalX. Check the provider's console for the invoice.");
  const notice = screen.getByLabelText("Billing responsibility");
  expect(notice.textContent).toContain("provider bills the account directly");
  expect(screen.getByTestId("compute-platform-billing").textContent).toContain("TerminalX Cloud is provided by TerminalX, with no provider account to connect: Billed by TerminalX.");
  expect(screen.getByLabelText("Allowed sizes for TerminalX Cloud")).toBeTruthy();
  expect(screen.getByLabelText("Allowed regions for TerminalX Cloud")).toBeTruthy();
});

it("saves limits with the policy version and account context revision", async () => {
  api.updatePolicy.mockResolvedValue(view({}, { version: 4, maxWorkspaces: 6 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  fireEvent.change(await screen.findByLabelText("Maximum workspaces"), { target: { value: "6" } });
  fireEvent.change(screen.getByLabelText("Maximum running workspaces"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Allowed regions for Hetzner Cloud"), { target: { value: "fsn1, nbg1, fsn1" } });
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
  expect(limits.textContent).toContain("Hetzner Cloud: sizes cx22, cx32; regions any");
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


it("shows the running limit in force, never \"no running limit\" (saas PRO-76)", async () => {
  // A newer server: blank means the operator ceiling, capped by the workspace limit.
  api.policy.mockResolvedValue(view({ workspaceCeiling: 50, runningWorkspaceCeiling: 3 }, { maxWorkspaces: 20, maxRunningWorkspaces: null }));
  render(<OrganizationCompute contextRevision="account-1" />);
  const status = await screen.findByLabelText("Compute status");
  expect(status.textContent).toContain("Running 2 of 3");
  expect(status.textContent).not.toContain("no running limit");
  const field = screen.getByLabelText("Maximum running workspaces") as HTMLInputElement;
  expect(field.value).toBe("");
  expect(field.placeholder).toBe("3 (default)");
  fireEvent.change(field, { target: { value: "5" } });
  expect(screen.getByText("Running at once must be no larger than 3, the most this TerminalX service allows.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save limits" }) as HTMLButtonElement).disabled).toBe(true);
});

it("on an older server, a blank running limit means the workspace limit", async () => {
  api.policy.mockResolvedValue(view({}, { maxWorkspaces: 4, maxRunningWorkspaces: null }));
  render(<OrganizationCompute contextRevision="account-1" />);
  expect((await screen.findByLabelText("Compute status")).textContent).toContain("Running 2 of 4");
  expect((screen.getByLabelText("Maximum running workspaces") as HTMLInputElement).placeholder).toBe("4 (default)");
});

it("sets, clears and validates the running cap per person, where the server has it (PRO-73)", async () => {
  api.policy.mockResolvedValue(view({}, { maxRunningWorkspacesPerMember: null }));
  api.updatePolicy.mockResolvedValue(view({}, { version: 4, maxRunningWorkspacesPerMember: 1 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  const field = (await screen.findByLabelText("Maximum running workspaces per person")) as HTMLInputElement;
  // No limit by default: the organization's limit is the only one.
  expect(field.value).toBe("");
  expect(field.placeholder).toBe("No limit");
  // More than the organization keeps in total is refused before sending.
  fireEvent.change(field, { target: { value: "9" } });
  expect((screen.getByRole("button", { name: "Save limits" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(field, { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
  await waitFor(() => expect(api.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({ maxRunningWorkspacesPerMember: 1, maxWorkspaces: 4, maxRunningWorkspaces: 2 }), "rev-1"));
  // Blank again clears it: null, not left out.
  await waitFor(() => expect((screen.getByLabelText("Maximum running workspaces per person") as HTMLInputElement).value).toBe("1"));
  fireEvent.change(screen.getByLabelText("Maximum running workspaces per person"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
  await waitFor(() => expect(api.updatePolicy).toHaveBeenLastCalledWith(expect.objectContaining({ maxRunningWorkspacesPerMember: null }), "rev-1"));
});

it("neither shows nor sends the cap per person to a server that does not have it", async () => {
  api.updatePolicy.mockResolvedValue(view({}, { version: 4 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  expect(screen.queryByLabelText("Maximum running workspaces per person")).toBeNull();
  fireEvent.change(screen.getByLabelText("Maximum workspaces"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
  await waitFor(() => expect(api.updatePolicy).toHaveBeenCalled());
  expect(api.updatePolicy.mock.calls[0][0]).not.toHaveProperty("maxRunningWorkspacesPerMember");
});

it("tells a member what the cap per person is", async () => {
  api.policy.mockResolvedValue(view({ canEdit: false }, { maxRunningWorkspacesPerMember: 1 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  expect((await screen.findByLabelText("Compute limits")).textContent).toContain("Each person can have 1 of their own workspace running at once.");
});

it("sets and validates how many workspaces one person may create per hour and per day (PRO-73)", async () => {
  api.policy.mockResolvedValue(view({ createBudgetDefaults: { perHour: 10, perDay: 20 } }, { maxCreatesPerMemberPerHour: null, maxCreatesPerMemberPerDay: null }));
  api.updatePolicy.mockResolvedValue(view({ createBudgetDefaults: { perHour: 10, perDay: 20 } }, { version: 4, maxCreatesPerMemberPerHour: 5, maxCreatesPerMemberPerDay: 40 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  const perHour = (await screen.findByLabelText("Maximum workspaces one person may create per hour")) as HTMLInputElement;
  const perDay = screen.getByLabelText("Maximum workspaces one person may create per day") as HTMLInputElement;
  // Blank is the service's default, which the field names.
  expect([perHour.value, perHour.placeholder, perDay.value, perDay.placeholder]).toEqual(["", "10 (default)", "", "20 (default)"]);
  const save = () => screen.getByRole("button", { name: "Save limits" }) as HTMLButtonElement;
  // A day cannot allow fewer than one of its hours; nor is zero or text a number.
  fireEvent.change(perHour, { target: { value: "30" } });
  fireEvent.change(perDay, { target: { value: "20" } });
  expect(save().disabled).toBe(true);
  fireEvent.change(perHour, { target: { value: "0" } });
  expect(save().disabled).toBe(true);
  fireEvent.change(perHour, { target: { value: "5" } });
  fireEvent.change(perDay, { target: { value: "40" } });
  expect(save().disabled).toBe(false);
  fireEvent.click(save());
  await waitFor(() => expect(api.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({ maxCreatesPerMemberPerHour: 5, maxCreatesPerMemberPerDay: 40 }), "rev-1"));
});

it("neither shows nor sends the create budget to a server that does not have it, and tells a member what it is where it does", async () => {
  api.updatePolicy.mockResolvedValue(view({}, { version: 4 }));
  const { unmount } = render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  expect(screen.queryByLabelText("Maximum workspaces one person may create per hour")).toBeNull();
  fireEvent.change(screen.getByLabelText("Maximum workspaces"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
  await waitFor(() => expect(api.updatePolicy).toHaveBeenCalled());
  expect(api.updatePolicy.mock.calls[0][0]).not.toHaveProperty("maxCreatesPerMemberPerHour");
  expect(api.updatePolicy.mock.calls[0][0]).not.toHaveProperty("maxCreatesPerMemberPerDay");
  unmount();

  api.policy.mockResolvedValue(view({ canEdit: false, createBudgetDefaults: { perHour: 10, perDay: 20 } }, { maxCreatesPerMemberPerHour: 3, maxCreatesPerMemberPerDay: null }));
  render(<OrganizationCompute contextRevision="account-1" />);
  expect((await screen.findByLabelText("Compute limits")).textContent).toContain("Each person can create 3 workspaces an hour and 20 a day.");
});

it("shows no Machine0 limits row while the server hides Machine0, unless the policy already limits it", async () => {
  api.policy.mockResolvedValue(view());
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Allowed sizes for Boat");
  expect(screen.queryByLabelText("Allowed sizes for Machine0")).toBeNull();
  cleanup();

  api.policy.mockResolvedValue(view({}, { allowedMachineClasses: { machine0: ["small"] } }));
  render(<OrganizationCompute contextRevision="account-1" />);
  expect(((await screen.findByLabelText("Allowed sizes for Machine0")) as HTMLInputElement).value).toBe("small");
});

// What a server since PRO-371 sends for an organization that set nothing:
// every limit null, no ceilings, and no operator create budgets.
const unlimited = (overrides: Partial<ComputePolicyView> = {}, policy: Partial<ComputePolicyView["policy"]> = {}) =>
  view(
    { workspaceCeiling: null, noLimitAware: true, runningWorkspaceCeiling: null, createBudgetDefaults: { perHour: null, perDay: null }, counts: { workspaces: 60, running: 3 }, ...overrides },
    {
      maxWorkspaces: null,
      maxRunningWorkspaces: null,
      maxRunningWorkspacesPerMember: null,
      maxCreatesPerMemberPerHour: null,
      maxCreatesPerMemberPerDay: null,
      maxIdleSuspendMinutes: null,
      allowedMachineClasses: {},
      ...policy,
    },
  );

const LIMIT_FIELDS = [
  "Maximum workspaces",
  "Maximum running workspaces",
  "Maximum running workspaces per person",
  "Maximum workspaces one person may create per hour",
  "Maximum workspaces one person may create per day",
];
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const saveButton = () => screen.getByRole("button", { name: "Save limits" }) as HTMLButtonElement;

it("shows every limit of a new organization as \"No limit\" and saves an empty field as none (PRO-371)", async () => {
  api.policy.mockResolvedValue(unlimited());
  api.updatePolicy.mockResolvedValue(unlimited({}, { version: 4 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  for (const label of LIMIT_FIELDS) expect([label, field(label).value, field(label).placeholder]).toEqual([label, "", "No limit"]);
  // Past the old 50 and 2, and said without a limit.
  const status = screen.getByLabelText("Compute status").textContent;
  expect(status).toContain("Workspaces 60, no limit");
  expect(status).toContain("Running 3, no limit");
  expect(status).not.toContain(" of ");
  // Idle suspend is as it was.
  expect((screen.getByLabelText("Maximum idle suspend") as HTMLSelectElement).selectedOptions[0].textContent).toBe("No limit");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(api.updatePolicy).toHaveBeenCalledWith(
      {
        expectedVersion: 3,
        maxWorkspaces: null,
        maxRunningWorkspaces: null,
        maxRunningWorkspacesPerMember: null,
        maxCreatesPerMemberPerHour: null,
        maxCreatesPerMemberPerDay: null,
        maxIdleSuspendMinutes: null,
        allowedMachineClasses: {},
        allowedLocations: {},
        noLimitAware: true,
      },
      "rev-1",
    ),
  );
});

it("marks a save to a server that takes no limit, so a workspace limit of 1 is kept as typed (PRO-371)", async () => {
  api.policy.mockResolvedValue(unlimited());
  api.updatePolicy.mockResolvedValue(unlimited({}, { version: 4, maxWorkspaces: 1 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  type("Maximum workspaces", "1");
  fireEvent.click(saveButton());
  await waitFor(() => expect(api.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({ maxWorkspaces: 1, noLimitAware: true }), "rev-1"));
});

it("sends no marker to a server before PRO-371, which refuses a key it does not know", async () => {
  // That server always reports a ceiling.
  api.policy.mockResolvedValue(view({ workspaceCeiling: 50, runningWorkspaceCeiling: 2 }, { maxWorkspaces: 50 }));
  api.updatePolicy.mockResolvedValue(view({ workspaceCeiling: 50, runningWorkspaceCeiling: 2 }, { version: 4, maxWorkspaces: 1 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  type("Maximum workspaces", "1");
  type("Maximum running workspaces", "1");
  fireEvent.click(saveButton());
  await waitFor(() => expect(api.updatePolicy).toHaveBeenCalled());
  expect(api.updatePolicy.mock.calls[0][0]).toMatchObject({ maxWorkspaces: 1 });
  expect(api.updatePolicy.mock.calls[0][0]).not.toHaveProperty("noLimitAware");
});

it("saves 500 workspaces and 100 running at once, and shows them again (PRO-371)", async () => {
  api.policy.mockResolvedValue(unlimited());
  api.updatePolicy.mockResolvedValue(unlimited({}, { version: 4, maxWorkspaces: 500, maxRunningWorkspaces: 100, maxCreatesPerMemberPerHour: 600 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  type("Maximum workspaces", "500");
  type("Maximum running workspaces", "100");
  // Above the old 500 create budget, too.
  type("Maximum workspaces one person may create per hour", "600");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(api.updatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ maxWorkspaces: 500, maxRunningWorkspaces: 100, maxRunningWorkspacesPerMember: null, maxCreatesPerMemberPerHour: 600, maxCreatesPerMemberPerDay: null }),
      "rev-1",
    ),
  );
  await waitFor(() => expect(screen.getByLabelText("Compute status").textContent).toContain("Workspaces 60 of 500"));
  expect(screen.getByLabelText("Compute status").textContent).toContain("Running 3 of 100");
  expect([field("Maximum workspaces").value, field("Maximum running workspaces").value]).toEqual(["500", "100"]);
});

it("clears a limit an admin had set: the emptied field is saved as no limit (PRO-371)", async () => {
  api.policy.mockResolvedValue(unlimited({}, { maxWorkspaces: 500, maxRunningWorkspaces: 100 }));
  api.updatePolicy.mockResolvedValue(unlimited({}, { version: 4 }));
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  expect(field("Maximum workspaces").value).toBe("500");
  type("Maximum workspaces", "");
  type("Maximum running workspaces", "");
  fireEvent.click(saveButton());
  await waitFor(() => expect(api.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({ maxWorkspaces: null, maxRunningWorkspaces: null }), "rev-1"));
  await waitFor(() => expect(screen.getByLabelText("Compute status").textContent).toContain("Workspaces 60, no limit"));
});

it("refuses only numbers that are not whole or are below 1, and says which field (PRO-371)", async () => {
  api.policy.mockResolvedValue(unlimited());
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  for (const typed of ["0", "2.5", "-3", "ten"]) {
    type("Maximum workspaces", typed);
    expect(screen.getByRole("alert").textContent, typed).toBe("Workspaces must be a whole number of 1 or more, or blank for no limit.");
    expect(field("Maximum workspaces").getAttribute("aria-invalid")).toBe("true");
    expect(saveButton().disabled).toBe(true);
  }
  // The other fields are not marked for it.
  expect(field("Maximum running workspaces").getAttribute("aria-invalid")).toBeNull();
  type("Maximum workspaces", "51");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(field("Maximum workspaces").getAttribute("aria-invalid")).toBeNull();
  expect(saveButton().disabled).toBe(false);
  // Only what the server cannot store is too large.
  type("Maximum workspaces", "2147483647");
  expect(screen.queryByRole("alert")).toBeNull();
  type("Maximum workspaces", "2147483648");
  expect(screen.getByRole("alert").textContent).toBe("Workspaces is too large to store. The most is 2147483647.");
  // A refused form is not sent, by the button or by Enter.
  fireEvent.submit(screen.getByRole("form", { name: "Compute limits" }));
  expect(api.updatePolicy).not.toHaveBeenCalled();
});

it("compares two limits only when both are set (PRO-371)", async () => {
  api.policy.mockResolvedValue(unlimited());
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  // Running at once, with no workspace limit to be larger than.
  type("Maximum running workspaces", "100");
  type("Maximum running workspaces per person", "9");
  type("Maximum workspaces one person may create per hour", "30");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(saveButton().disabled).toBe(false);

  type("Maximum workspaces", "50");
  expect(screen.getByRole("alert").textContent).toBe("Running at once must be no larger than the workspace limit.");
  expect(field("Maximum running workspaces").getAttribute("aria-invalid")).toBe("true");
  expect(saveButton().disabled).toBe(true);
  type("Maximum running workspaces", "50");
  expect(screen.queryByRole("alert")).toBeNull();

  type("Maximum workspaces", "4");
  type("Maximum running workspaces", "");
  expect(screen.getByRole("alert").textContent).toBe("Running per person must be no larger than the workspace limit.");
  type("Maximum workspaces", "");
  expect(screen.queryByRole("alert")).toBeNull();

  type("Maximum workspaces one person may create per day", "20");
  expect(screen.getByRole("alert").textContent).toBe("New per person, per hour must be no larger than per day.");
  expect([field("Maximum workspaces one person may create per hour").getAttribute("aria-invalid"), field("Maximum workspaces one person may create per day").getAttribute("aria-invalid")]).toEqual(["true", "true"]);
  type("Maximum workspaces one person may create per day", "30");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(saveButton().disabled).toBe(false);
});

it("keeps the operator's caps where the operator set them (PRO-371)", async () => {
  api.policy.mockResolvedValue(unlimited({ runningWorkspaceCeiling: 10, createBudgetDefaults: { perHour: 10, perDay: null } }));
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  // Empty means the operator's number where there is one, and no limit where there is not.
  expect(field("Maximum workspaces").placeholder).toBe("No limit");
  expect(field("Maximum running workspaces").placeholder).toBe("10 (default)");
  expect(field("Maximum workspaces one person may create per hour").placeholder).toBe("10 (default)");
  expect(field("Maximum workspaces one person may create per day").placeholder).toBe("No limit");
  const status = screen.getByLabelText("Compute status").textContent;
  expect(status).toContain("Workspaces 60, no limit");
  expect(status).toContain("Running 3 of 10");
  type("Maximum workspaces", "500");
  type("Maximum running workspaces", "10");
  expect(screen.queryByRole("alert")).toBeNull();
  type("Maximum running workspaces", "11");
  expect(screen.getByRole("alert").textContent).toBe("Running at once must be no larger than 10, the most this TerminalX service allows.");
  expect(saveButton().disabled).toBe(true);
});

it("on a server before PRO-371, still needs a workspace limit and offers no \"No limit\" for it", async () => {
  // As that server answers: 50 workspaces under a ceiling of 50, 2 running, 10 and 20 a person.
  api.policy.mockResolvedValue(
    view(
      { workspaceCeiling: 50, runningWorkspaceCeiling: 2, createBudgetDefaults: { perHour: 10, perDay: 20 } },
      { maxWorkspaces: 50, maxRunningWorkspaces: null, maxRunningWorkspacesPerMember: null, maxCreatesPerMemberPerHour: null, maxCreatesPerMemberPerDay: null },
    ),
  );
  render(<OrganizationCompute contextRevision="account-1" />);
  await screen.findByLabelText("Maximum workspaces");
  expect([field("Maximum workspaces").value, field("Maximum workspaces").placeholder]).toEqual(["50", ""]);
  expect(field("Maximum running workspaces").placeholder).toBe("2 (default)");
  expect(field("Maximum running workspaces per person").placeholder).toBe("No limit");
  expect(field("Maximum workspaces one person may create per hour").placeholder).toBe("10 (default)");
  expect(field("Maximum workspaces one person may create per day").placeholder).toBe("20 (default)");
  expect(screen.getByLabelText("Compute status").textContent).toContain("Workspaces 3 of 50");
  expect(screen.getByLabelText("Compute status").textContent).toContain("Running 2 of 2");
  expect(saveButton().disabled).toBe(false);
  for (const typed of ["", "51", "500"]) {
    type("Maximum workspaces", typed);
    expect(screen.getByRole("alert").textContent, typed).toBe("Workspaces must be a whole number from 1 to 50, the most this TerminalX service allows.");
    expect(saveButton().disabled).toBe(true);
  }
});

it("tells a member only the limits there are (PRO-371)", async () => {
  api.policy.mockResolvedValue(unlimited({ canEdit: false }));
  const { unmount } = render(<OrganizationCompute contextRevision="account-1" />);
  const limits = await screen.findByLabelText("Compute limits");
  expect(limits.textContent).toBe("Only owners and admins can change compute limits.");
  expect(screen.getByLabelText("Compute status").textContent).toContain("Workspaces 60, no limit");
  expect(screen.getByLabelText("Compute status").textContent).toContain("Running 3, no limit");
  unmount();

  // Only an hour is limited: by the organization, or by the operator where the organization set nothing.
  api.policy.mockResolvedValue(unlimited({ canEdit: false }, { maxCreatesPerMemberPerHour: 1 }));
  const second = render(<OrganizationCompute contextRevision="account-1" />);
  expect((await screen.findByLabelText("Compute limits")).textContent).toContain("Each person can create 1 workspace an hour.");
  second.unmount();
  api.policy.mockResolvedValue(unlimited({ canEdit: false, createBudgetDefaults: { perHour: null, perDay: 20 } }));
  render(<OrganizationCompute contextRevision="account-1" />);
  expect((await screen.findByLabelText("Compute limits")).textContent).toContain("Each person can create 20 workspaces a day.");
});
