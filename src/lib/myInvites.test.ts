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

import { acceptInvite, declineInvite, decideLater, getInvites, inviteErrorMessage, loadInvites, openInvite, registerInviteLeaveGuard, resetInvitesForTest } from "./myInvites";

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
  it("does not turn the surfaces on when a read fails after the account stopped being ready", async () => {
    invoke.mockImplementationOnce(async () => {
      account.status.phase2Readiness = { personal: [] };
      throw { code: "organization_invites_unavailable" };
    });
    await loadInvites();
    expect(getInvites().enabled).toBe(false);
  });

  it("asks nothing while no organization reports the readiness key", async () => {
    account.status.phase2Readiness = { personal: ["team.events.v1"] };
    await loadInvites();
    expect(invoke).not.toHaveBeenCalled();
    expect(getInvites().enabled).toBe(false);
  });

  it("lists invitations and only tells about a new one; the card never opens by itself", async () => {
    invoke.mockResolvedValue({ invites: [invite("inv-2", { expired: true, expiresAt: Date.now() - DAY }), invite("inv-1")] });
    await loadInvites();
    expect(invoke).toHaveBeenCalledWith("my_invites");
    expect(getInvites()).toMatchObject({ enabled: true, open: null, noticed: "inv-1" });
    expect(getInvites().invites).toHaveLength(2);
    await loadInvites();
    await loadInvites();
    expect(getInvites().open).toBeNull();
    // Open is the person's click.
    expect(openInvite("inv-1")).toBe(true);
    expect(getInvites()).toMatchObject({ open: "inv-1", noticed: null });
  });

  it("does not open the card while what is open cannot be left", async () => {
    invoke.mockResolvedValue({ invites: [invite("inv-1")] });
    await loadInvites();
    const release = registerInviteLeaveGuard(() => false);
    expect(openInvite("inv-1")).toBe(false);
    expect(getInvites().open).toBeNull();
    release();
    expect(openInvite("inv-1")).toBe(true);
  });

  it("does not bring back an invitation answered while a list read was in flight", async () => {
    invoke.mockResolvedValueOnce({ invites: [invite("inv-1")] });
    await loadInvites();
    let answerList: (value: unknown) => void = () => undefined;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { answerList = resolve; }));
    const reading = loadInvites();
    invoke.mockResolvedValueOnce({ organizationId: "org-2", organizationName: "Orbit Labs", role: "member" });
    await acceptInvite("inv-1");
    // The read was asked before the accept and answers with the invitation still in it.
    answerList({ invites: [invite("inv-1")] });
    await reading;
    expect(getInvites().invites).toEqual([]);
  });

  it("reads again when an accept's outcome is unknown, and says so", async () => {
    invoke.mockResolvedValueOnce({ invites: [invite("inv-1")] });
    await loadInvites();
    invoke.mockRejectedValueOnce({ code: "organization_invites_outcome_unknown", status: null });
    invoke.mockResolvedValueOnce({ invites: [] });
    const failure = await acceptInvite("inv-1").catch((error: unknown) => error);
    expect(inviteErrorMessage(failure)).toMatch(/Couldn’t confirm/);
    expect(refreshAccountRoles).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(getInvites().invites).toEqual([]));
  });

  it("keeps an invitation for later, remembered for this account", async () => {
    invoke.mockResolvedValue({ invites: [invite("inv-1")] });
    await loadInvites();
    decideLater("inv-1");
    expect(getInvites()).toMatchObject({ open: null, deferred: ["inv-1"], kept: { id: "inv-1" } });
    resetInvitesForTest();
    await loadInvites();
    // A new window does not tell again about one the person put off.
    expect(getInvites()).toMatchObject({ open: null, noticed: null, deferred: ["inv-1"] });
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
