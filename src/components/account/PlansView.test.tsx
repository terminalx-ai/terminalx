import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OrganizationPlan } from "@/lib/api";
import { PlansView } from "./PlansView";

const { privacy, openWelcome, openUrl, organization } = vi.hoisted(() => ({
  privacy: { ready: true, enabled: false },
  openWelcome: vi.fn(),
  openUrl: vi.fn().mockResolvedValue(undefined),
  organization: { role: "member" },
}));

const plan: OrganizationPlan = {
  plan: "free",
  seatsUsed: 2,
  memberLimit: null,
  catalog: { teams: { currency: "USD", unitAmountMinor: 2375, interval: "month", memberLimit: 8 } },
  upgradeTarget: "plans",
};
vi.mock("@/lib/account", () => ({
  useAccount: () => ({
    status: {
      state: "signed-in",
      identity: { organizationId: "org-a" },
      organizations: [{ id: "org-a", name: "Acme", role: organization.role, plan }],
    },
  }),
}));
vi.mock("@/lib/dataPrivacy", () => ({ useDataPrivacy: () => privacy }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@/lib/sessions", () => ({ openWelcome }));

afterEach(() => {
  cleanup();
  privacy.enabled = false;
  organization.role = "member";
  delete plan.catalog.pro;
  delete plan.links;
  vi.clearAllMocks();
});

it("uses the current organization's catalog and clears it as soon as privacy is enabled", () => {
  const view = render(<PlansView />);
  expect(screen.getByRole("heading", { name: "Plans" })).toBeTruthy();
  expect(screen.getByText(/23.75 per seat/)).toBeTruthy();
  expect(screen.getByText("Up to 8 members")).toBeTruthy();
  expect(screen.getByText("Local work on this Mac")).toBeTruthy();
  expect(screen.getByText("Cloud and organizations of your own")).toBeTruthy();
  privacy.enabled = true;
  view.rerender(<PlansView />);
  expect(screen.queryByText("Up to 8 members")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(openWelcome).toHaveBeenCalledOnce();
});

it("renders optional Pro pricing and opens the approved console links", () => {
  organization.role = "owner";
  plan.catalog.pro = { currency: "USD", unitAmountMinor: 1500, interval: "month" };
  plan.links = {
    upgrade: "https://console.terminalx.ai/plans",
    manage: "https://console.terminalx.ai/billing",
  };
  render(<PlansView />);
  expect(screen.getByText("$0")).toBeTruthy();
  expect(screen.getByText("Your plan")).toBeTruthy();
  expect(screen.getByText(/15(?:.00)? \/ month/)).toBeTruthy();
  expect(screen.getByText("One bill for Acme")).toBeTruthy();
  expect(screen.getByText("Checkout, invoices and seat changes open in the web console.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
  fireEvent.click(screen.getByRole("button", { name: "Manage in console" }));
  expect(openUrl.mock.calls).toEqual([[plan.links.upgrade], [plan.links.manage]]);
});

it("omits untrusted upgrade links and shows members who can switch the Teams plan", () => {
  plan.links = {
    upgrade: "https://console.terminalx.ai@elsewhere.test/plans",
    manage: "https://console.terminalx.ai/billing",
  };
  render(<PlansView />);
  expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Manage in console" })).toBeNull();
  expect(screen.getByText("Ask an owner to switch.")).toBeTruthy();
});
