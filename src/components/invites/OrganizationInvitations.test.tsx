import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InviteWelcome, InvitesState } from "@/lib/myInvites";

const DAY = 86_400_000;
const { store, state } = vi.hoisted(() => ({
  store: { fetchWelcome: vi.fn(), acceptInvite: vi.fn(), declineInvite: vi.fn(), openInvite: vi.fn() },
  state: { current: null as unknown as InvitesState },
}));

vi.mock("@/lib/myInvites", async (importOriginal) => ({ ...(await importOriginal<object>()), ...store, useInvites: () => state.current }));

import { OrganizationInvitations, readinessSummary } from "./OrganizationInvitations";

const welcome: InviteWelcome = {
  id: "inv-1",
  organizationName: "Orbit Labs",
  role: "member",
  expiresAt: Date.now() + 6 * DAY,
  createdAt: Date.now() - 2 * DAY,
  seatCovered: true,
  checkedAt: Date.now(),
  github: { state: "ready", repositories: ["orbit/app"] },
  agents: [
    { provider: "claude", state: "ready" },
    { provider: "codex", state: "needs_login" },
  ],
  computer: { state: "ready", version: 1 },
  admins: [],
};

beforeEach(() => {
  state.current = {
    enabled: true,
    invites: [
      { id: "inv-1", organizationName: "Orbit Labs", role: "member", expiresAt: Date.now() + 6 * DAY, createdAt: Date.now() - 2 * DAY, invitedBy: "Ada Park", teamsPlan: true },
      { id: "inv-2", organizationName: "Acme Labs", role: "member", expiresAt: Date.now() - DAY, createdAt: Date.UTC(2026, 10, 2), invitedBy: "Alex Rivera", expired: true },
    ],
    deferred: ["inv-1"],
    open: null,
    noticed: null,
    joined: null,
    kept: null,
  };
  store.fetchWelcome.mockResolvedValue(welcome);
  store.acceptInvite.mockResolvedValue({ organizationId: "org-2", organizationName: "Orbit Labs", role: "member" });
  store.declineInvite.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("lists an open invitation with what is ready, and an expired one to remove (12.20)", async () => {
  render(<OrganizationInvitations />);
  expect(screen.getByRole("heading", { name: "Invitations" })).toBeTruthy();
  const open = screen.getByRole("listitem", { name: "Orbit Labs invitation" });
  expect(within(open).getByText("Teams")).toBeTruthy();
  expect(within(open).getByText("You chose Decide later")).toBeTruthy();
  expect(within(open).getByText("Ada Park invited you as a member · 2 days ago")).toBeTruthy();
  expect(await within(open).findByText("GitHub, Claude Code and the cloud computer are ready for you · Codex needs a login")).toBeTruthy();
  expect(within(open).getByText("Your seat is covered by Orbit Labs’ Teams plan.")).toBeTruthy();
  expect(within(open).getByText(/^Expires on /)).toBeTruthy();

  const expired = screen.getByRole("listitem", { name: "Acme Labs, expired invitation" });
  expect(within(expired).getByText("Expired")).toBeTruthy();
  expect(within(expired).getByText("Alex Rivera invited you on 2 Nov. Ask Alex for a new invitation.")).toBeTruthy();
  expect(store.fetchWelcome).toHaveBeenCalledTimes(1);
});

it("accepts, declines, reviews and removes", async () => {
  render(<OrganizationInvitations />);
  const open = screen.getByRole("listitem", { name: "Orbit Labs invitation" });
  fireEvent.click(within(open).getByRole("button", { name: "Review" }));
  expect(store.openInvite).toHaveBeenCalledWith("inv-1");
  await act(async () => fireEvent.click(within(open).getByRole("button", { name: "Accept and join" })));
  expect(store.acceptInvite).toHaveBeenCalledWith("inv-1");
  cleanup();

  render(<OrganizationInvitations />);
  await act(async () => fireEvent.click(within(screen.getByRole("listitem", { name: "Orbit Labs invitation" })).getByRole("button", { name: "Decline" })));
  expect(store.declineInvite).toHaveBeenCalledWith("inv-1");
  await act(async () => fireEvent.click(within(screen.getByRole("listitem", { name: "Acme Labs, expired invitation" })).getByRole("button", { name: "Remove" })));
  expect(store.declineInvite).toHaveBeenCalledWith("inv-2");
});

it("shows nothing while the readiness key is off or nothing waits", () => {
  state.current = { ...state.current, enabled: false };
  const { container, rerender } = render(<OrganizationInvitations />);
  expect(container.textContent).toBe("");
  state.current = { ...state.current, enabled: true, invites: [] };
  rerender(<OrganizationInvitations />);
  expect(container.textContent).toBe("");
});

it("words a building computer and a missing GitHub", () => {
  expect(readinessSummary({ ...welcome, github: { state: "missing", repositories: [] }, computer: { state: "building", version: 2 } })).toBe(
    "Claude Code is ready for you · GitHub isn’t set up · Codex needs a login · The cloud computer is building",
  );
});
