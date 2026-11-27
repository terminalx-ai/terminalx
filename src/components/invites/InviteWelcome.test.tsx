import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InviteWelcome as Welcome, MyInvite } from "@/lib/myInvites";

const { store } = vi.hoisted(() => ({
  store: {
    fetchWelcome: vi.fn(),
    acceptInvite: vi.fn(),
    declineInvite: vi.fn(),
    decideLater: vi.fn(),
  },
}));

vi.mock("@/lib/myInvites", async (importOriginal) => ({ ...(await importOriginal<object>()), ...store }));
vi.mock("@/components/layout/WindowControls", () => ({ WindowControls: () => null }));

import { InviteWelcome } from "./InviteWelcome";

const invite: MyInvite = { id: "inv-1", organizationName: "Orbit Labs", role: "member", expiresAt: Date.now() + 86_400_000, invitedBy: "Ada Park" };

const welcome = (over: Partial<Welcome> = {}): Welcome => ({
  id: "inv-1",
  organizationName: "Orbit Labs",
  role: "member",
  expiresAt: invite.expiresAt,
  createdAt: Date.now() - 86_400_000,
  invitedBy: "Ada Park",
  seatCovered: true,
  checkedAt: Date.now(),
  github: { state: "ready", repositories: ["orbit/app", "orbit/api", "orbit/docs"] },
  agents: [
    { provider: "claude", state: "ready", authKind: "subscription" },
    { provider: "codex", state: "needs_login" },
  ],
  computer: { state: "building", name: "orbit-cloud", version: 2 },
  admins: [
    { name: "Ada Park", owner: true },
    { name: "Sam Rivera", owner: false },
  ],
  ...over,
});

beforeEach(() => {
  store.fetchWelcome.mockResolvedValue(welcome());
  store.acceptInvite.mockResolvedValue({ organizationId: "org-2", organizationName: "Orbit Labs", role: "member" });
  store.declineInvite.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const row = (name: string) => screen.getByText(name, { selector: "div" }).closest("li")!;

it("shows a ready or not-ready line per agent, GitHub and the computer (12.20 → 12.21)", async () => {
  render(<InviteWelcome invite={invite} onClose={() => undefined} />);
  expect(screen.getByRole("heading", { name: "Welcome to Orbit Labs" })).toBeTruthy();
  expect(screen.getByText("Ada Park invited you as a member")).toBeTruthy();
  await screen.findByText("Ready for you");
  expect(screen.getByText("2 of 4")).toBeTruthy();
  expect(within(row("GitHub")).getByText("Ready")).toBeTruthy();
  expect(within(row("GitHub")).getByText("app, api and docs, through the organization’s GitHub App")).toBeTruthy();
  expect(within(row("Claude Code")).getByText("Ready")).toBeTruthy();
  expect(within(row("Codex")).getByText("Needs a login")).toBeTruthy();
  expect(within(row("Cloud computer")).getByText("Building")).toBeTruthy();
  expect(within(row("Cloud computer")).getByText("orbit-cloud · version 2 is building")).toBeTruthy();
  expect(screen.getByText("Your seat is covered by Orbit Labs’ Teams plan.")).toBeTruthy();
  expect(screen.getByText(/cloud sessions can start once the computer finishes building/)).toBeTruthy();
  expect(screen.getByText("owner")).toBeTruthy();
});

it("says everything is ready without a count when it is (12.08)", async () => {
  store.fetchWelcome.mockResolvedValue(welcome({ agents: [{ provider: "claude", state: "ready" }, { provider: "codex", state: "ready" }], computer: { state: "ready", version: 1 }, seatCovered: false }));
  render(<InviteWelcome invite={invite} onClose={() => undefined} />);
  await screen.findByText(/already connected everything/);
  expect(screen.queryByText(/of 4/)).toBeNull();
  expect(screen.queryByText(/Teams plan/)).toBeNull();
  expect(screen.queryByText(/finishes building/)).toBeNull();
});

it("accepts with the button or Enter, declines, and decides later", async () => {
  const onClose = vi.fn();
  render(<InviteWelcome invite={invite} onClose={onClose} />);
  await screen.findByText("Ready for you");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Accept and join/ })));
  expect(store.acceptInvite).toHaveBeenCalledWith("inv-1");
  expect(onClose).toHaveBeenCalledTimes(1);

  cleanup();

  render(<InviteWelcome invite={invite} onClose={onClose} />);
  await act(async () => fireEvent.keyDown(document.body, { key: "Enter" }));
  expect(store.acceptInvite).toHaveBeenCalledTimes(2);
  cleanup();

  render(<InviteWelcome invite={invite} onClose={onClose} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Decline" })));
  expect(store.declineInvite).toHaveBeenCalledWith("inv-1");

  fireEvent.click(screen.getByRole("button", { name: "Decide later" }));
  expect(store.decideLater).toHaveBeenCalledWith("inv-1");
});

it("keeps the card open with a short reason when accepting is refused", async () => {
  store.acceptInvite.mockRejectedValue({ code: "organization_member_limit_reached" });
  const onClose = vi.fn();
  render(<InviteWelcome invite={invite} onClose={onClose} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Accept and join/ })));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no free seat/));
  expect(onClose).not.toHaveBeenCalled();
});

it("points to Model access for an own model route", async () => {
  render(<InviteWelcome invite={invite} onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "use my own model route" }));
  expect(screen.getByText(/Settings → Orbit Labs → Model access/)).toBeTruthy();
});
