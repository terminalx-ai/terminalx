import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { InvitesState } from "@/lib/myInvites";

const { state, store, switching } = vi.hoisted(() => ({
  state: { current: { enabled: true, invites: [], deferred: [], open: null, joined: null, kept: null } as InvitesState },
  store: { dismissKept: vi.fn(), dismissJoined: vi.fn() },
  switching: { switchOrganization: vi.fn(), targets: [{ id: "org-2" }] },
}));

vi.mock("@/lib/myInvites", () => ({ ...store, useInvites: () => state.current }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: { state: "signed-in" } }) }));
vi.mock("@/lib/organizationVisibilityGate", () => ({ useOrganizationSwitchingEnabled: () => true }));
vi.mock("@/lib/organizationVisibility", () => ({
  organizationSwitchTargets: () => switching.targets,
  switchOrganization: switching.switchOrganization,
}));

import { InviteNotices } from "./InviteNotices";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("says an invitation was kept for later and until when (12.20)", () => {
  state.current = { ...state.current, kept: { id: "inv-1", organizationName: "Orbit Labs", role: "member", expiresAt: Date.UTC(2026, 11, 3, 12) }, joined: null };
  render(<InviteNotices />);
  expect(screen.getByText("Orbit Labs invitation kept for later")).toBeTruthy();
  expect(screen.getByText("It waits in Settings › Organizations until 3 Dec.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(store.dismissKept).toHaveBeenCalled();
});

it("offers to switch to the organization just joined (01.08)", () => {
  state.current = { ...state.current, kept: null, joined: { organizationId: "org-2", organizationName: "Orbit Labs", role: "member" } };
  render(<InviteNotices />);
  expect(screen.getByText("You joined Orbit Labs")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Switch to Orbit Labs" }));
  expect(switching.switchOrganization).toHaveBeenCalledWith("org-2");
  expect(store.dismissJoined).toHaveBeenCalled();
});

it("leaves the switch out until the organization is listed", () => {
  switching.targets = [];
  state.current = { ...state.current, joined: { organizationId: "org-2", organizationName: "Orbit Labs", role: "member" } };
  render(<InviteNotices />);
  expect(screen.queryByRole("button", { name: "Switch to Orbit Labs" })).toBeNull();
});
