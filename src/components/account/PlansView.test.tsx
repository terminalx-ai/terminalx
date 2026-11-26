import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OrganizationPlan } from "@/lib/api";
import { PlansView } from "./PlansView";

const { privacy, openWelcome } = vi.hoisted(() => ({
  privacy: { ready: true, enabled: false },
  openWelcome: vi.fn(),
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
      organizations: [{ id: "org-a", plan }],
    },
  }),
}));
vi.mock("@/lib/dataPrivacy", () => ({ useDataPrivacy: () => privacy }));
vi.mock("@/lib/sessions", () => ({ openWelcome }));

afterEach(() => {
  cleanup();
  privacy.enabled = false;
  vi.clearAllMocks();
});

it("uses the current organization's catalog and clears it as soon as privacy is enabled", () => {
  const view = render(<PlansView />);
  expect(screen.getByRole("heading", { name: "Plans" })).toBeTruthy();
  expect(screen.getByText(/23.75 per seat/)).toBeTruthy();
  expect(screen.getByText("Up to 8 members")).toBeTruthy();
  privacy.enabled = true;
  view.rerender(<PlansView />);
  expect(screen.queryByText("Up to 8 members")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(openWelcome).toHaveBeenCalledOnce();
});
