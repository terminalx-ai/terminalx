import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { account, invoke, refreshAccountRoles } = vi.hoisted(() => ({
  account: {
    status: {
      state: "signed-in",
      identity: { email: "invitee@example.com" },
      phase2Readiness: { personal: ["organization.invites-welcome.v1"] } as Record<string, string[]>,
    },
  },
  invoke: vi.fn(),
  refreshAccountRoles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api", () => ({ invoke }));
vi.mock("@/lib/account", () => ({
  getAccount: () => account,
  subscribeAccount: () => () => undefined,
  refreshAccountRoles,
}));

import { acceptInvite, declineInvite, decideLater, getInvites, inviteErrorMessage, loadInvites, openInvite, resetInvitesForTest } from "./myInvites";

const DAY = 86_400_000;
const invite = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  organizationName: id === "inv-1" ? "Orbit Labs" : "Acme Labs",
  role: "member",
  expiresAt: Date.now() + 5 * DAY,
  invitedBy: "Ada Park",
  createdAt: Date.now() - 2 * DAY,
  expired: false,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  resetInvitesForTest();
  account.status.phase2Readiness = { personal: ["organization.invites-welcome.v1"] };
  invoke.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("my invites", () => {
  it("asks nothing while no organization reports the readiness key", async () => {
    account.status.phase2Readiness = { personal: ["team.events.v1"] };
    await loadInvites();
    expect(invoke).not.toHaveBeenCalled();
    expect(getInvites().enabled).toBe(false);
  });

  it("lists invitations and opens the first open one's card once", async () => {
    invoke.mockResolvedValue({ invites: [invite("inv-2", { expired: true, expiresAt: Date.now() - DAY }), invite("inv-1")] });
    await loadInvites();
    expect(invoke).toHaveBeenCalledWith("my_invites");
    expect(getInvites()).toMatchObject({ enabled: true, open: "inv-1" });
    expect(getInvites().invites).toHaveLength(2);
    openInvite(null);
    await loadInvites();
    // Not again by itself in this window.
    expect(getInvites().open).toBeNull();
  });

  it("keeps an invitation for later, remembered for this account", async () => {
    invoke.mockResolvedValue({ invites: [invite("inv-1")] });
    await loadInvites();
    decideLater("inv-1");
    expect(getInvites()).toMatchObject({ open: null, deferred: ["inv-1"], kept: { id: "inv-1" } });
    resetInvitesForTest();
    await loadInvites();
    // A new window does not open a card the person put off.
    expect(getInvites()).toMatchObject({ open: null, deferred: ["inv-1"] });
  });

  it("accepts, reads the organizations again and says who was joined", async () => {
    invoke.mockResolvedValueOnce({ invites: [invite("inv-1")] });
    await loadInvites();
    invoke.mockResolvedValueOnce({ organizationId: "org-2", organizationName: "Orbit Labs", role: "member" });
    await acceptInvite("inv-1");
    expect(invoke).toHaveBeenLastCalledWith("my_invite_accept", { inviteId: "inv-1" });
    expect(refreshAccountRoles).toHaveBeenCalledWith(true);
    expect(getInvites()).toMatchObject({ invites: [], open: null, joined: { organizationId: "org-2" } });
  });

  it("declines, removing the invitation and the choice to decide later", async () => {
    invoke.mockResolvedValueOnce({ invites: [invite("inv-1")] });
    await loadInvites();
    decideLater("inv-1");
    invoke.mockResolvedValueOnce({ declined: true });
    await declineInvite("inv-1");
    expect(invoke).toHaveBeenLastCalledWith("my_invite_decline", { inviteId: "inv-1" });
    expect(getInvites()).toMatchObject({ invites: [], deferred: [], kept: null });
  });

  it("explains refusals in a few words and never shows server text", () => {
    expect(inviteErrorMessage({ code: "invite_expired" })).toMatch(/expired/);
    expect(inviteErrorMessage({ code: "organization_member_limit_reached" })).toMatch(/no free seat/);
    expect(inviteErrorMessage(new Error("<b>boom</b>"))).toBe("Couldn’t reach TerminalX. Try again.");
  });
});
