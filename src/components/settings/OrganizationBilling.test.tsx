import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationBilling as Billing, OrganizationSummary } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  billing: vi.fn(),
  portal: vi.fn(),
  openUrl: vi.fn(async () => {}),
  openPlans: vi.fn(),
  privacy: { enabled: false, managed: false, ready: true },
}));

vi.mock("@/lib/api", () => ({ api: { organizationBilling: mocks.billing, organizationBillingPortal: mocks.portal } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@/lib/sessions", () => ({ openPlans: mocks.openPlans }));
vi.mock("@/lib/dataPrivacy", () => ({ PRIVACY_MESSAGE: "Turned off by data privacy mode", useDataPrivacy: () => mocks.privacy }));

const { OrganizationBilling } = await import("./OrganizationBilling");

const org: OrganizationSummary = { id: "org-1", name: "Acme", role: "owner", isPersonal: false, cloud: { enabled: true, flags: {} } };
const teams: Billing = {
  plan: "teams", billedTo: "organization",
  seats: { used: 3, limit: 5 },
  seatPrice: { currency: "USD", unitAmountMinor: 2000, interval: "month" },
  nextCharge: { date: "2026-12-01T12:00:00.000Z", amountMinor: 6000, currency: "USD" },
  payer: "Fixture Payer", canManageBilling: true,
};
const show = (organization = org) => render(<OrganizationBilling organization={organization} contextRevision="rev-1" />);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.privacy = { enabled: false, managed: false, ready: true };
  mocks.billing.mockResolvedValue(teams);
  mocks.portal.mockResolvedValue("https://polar.sh/acme/portal?customer_session_token=fixture");
});
afterEach(cleanup);

describe("Organization > Billing (PRO-596)", () => {
  it("shows the server's plan, seats, next charge and payer for a Teams owner", async () => {
    show();
    expect(await screen.findByText("Teams")).toBeTruthy();
    expect(mocks.billing).toHaveBeenCalledWith("org-1");
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("3 of 5 used")).toBeTruthy();
    expect(screen.getByText(/\$60\.00 on Dec 1, 2026/)).toBeTruthy();
    expect(screen.getByText("$20.00 per seat each month")).toBeTruthy();
    expect(screen.getByText("Fixture Payer")).toBeTruthy();
    expect(screen.getByText("Seats follow members")).toBeTruthy();
    // Change plan needs the PRO-182 Plans data for this organization.
    expect(screen.queryByRole("button", { name: "Change plan" })).toBeNull();
  });

  it("uses whatever limit and price the server sends", async () => {
    mocks.billing.mockResolvedValue({ ...teams, seats: { used: 7, limit: 9 }, seatPrice: { ...teams.seatPrice!, unitAmountMinor: 2300 } });
    show();
    expect(await screen.findByText("7 of 9 used")).toBeTruthy();
    expect(screen.getByText("$23.00 per seat each month")).toBeTruthy();
  });

  it("opens the Polar portal for the payer and nothing else", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Manage payment" }));
    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("https://polar.sh/acme/portal?customer_session_token=fixture"));
    expect(mocks.portal).toHaveBeenCalledWith("org-1", "organization");

    mocks.portal.mockResolvedValue("https://polar.sh.evil.test/portal");
    fireEvent.click(screen.getByRole("button", { name: "Manage payment" }));
    expect(await screen.findByText(/Couldn't open the payment portal/)).toBeTruthy();
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
  });

  it("hides the payer and portal from a member", async () => {
    mocks.billing.mockResolvedValue({ ...teams, payer: null, canManageBilling: false });
    show({ ...org, role: "member" });
    expect(await screen.findByText("3 of 5 used")).toBeTruthy();
    expect(screen.queryByText("Paid by")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage payment" })).toBeNull();
  });

  it("shows a Free plan with nothing scheduled, and offers Change plan when Plans is available", async () => {
    mocks.billing.mockResolvedValue({ plan: "free", billedTo: "personal", seats: null, seatPrice: null, nextCharge: null, payer: null, canManageBilling: false });
    const plan = { plan: "free", seatsUsed: 1, memberLimit: null, upgradeTarget: "plans", catalog: { teams: { currency: "USD", unitAmountMinor: 2000, interval: "month", memberLimit: 5 } } } as const;
    show({ ...org, plan });
    expect(await screen.findByText("Free")).toBeTruthy();
    expect(screen.getByText("None scheduled")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByText("Seats")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change plan" }));
    expect(mocks.openPlans).toHaveBeenCalled();
  });

  it("renders an empty state when the server has no billing for the organization", async () => {
    mocks.billing.mockRejectedValue({ code: "organization_billing_unavailable", status: 404 });
    show();
    expect(await screen.findByTestId("organization-billing-empty")).toBeTruthy();
  });

  it("offers a retry after another failure", async () => {
    mocks.billing.mockRejectedValueOnce({ code: "cloud_workspace_network", status: null });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("3 of 5 used")).toBeTruthy();
    expect(mocks.billing).toHaveBeenCalledTimes(2);
  });

  it("reads nothing in data privacy mode", () => {
    mocks.privacy = { enabled: true, managed: false, ready: true };
    show();
    expect(screen.getByText("Turned off by data privacy mode")).toBeTruthy();
    expect(mocks.billing).not.toHaveBeenCalled();
  });
});
