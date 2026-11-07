import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import type { AccountStatus } from "@/lib/api";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn(), listeners: new Set<() => void>(), account: { status: {} as AccountStatus } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/account", () => ({ getAccount: () => mocks.account, refreshMembershipsAfterInvite: mocks.refresh, subscribeAccount: (fn: () => void) => { mocks.listeners.add(fn); return () => mocks.listeners.delete(fn); }, useAccount: () => {
  useSyncExternalStore((fn) => { mocks.listeners.add(fn); return () => mocks.listeners.delete(fn); }, () => mocks.account.status);
  return mocks.account;
} }));
import { OrganizationInvitations } from "./OrganizationInvitations";
import { bootInvitations, getInvitations, refreshInvitations, resetInvitations, respondToInvitation } from "@/lib/organizationInvitations";
const status = (account = "one", revision = "1"): AccountStatus => ({ state: "signed-in", identity: { name: "Member", email: "member@example.com", organization: "" }, context: { account, scope: account, revision }, expiresAt: null, lastError: null, organizations: [] });
const invite = (id = "inv-1") => ({ id, organizationName: "Research & Development", role: "member", expiresAt: Date.now() + 60_000, invitedBy: "Admin" });
const changeAccount = (next: AccountStatus) => act(() => { mocks.account.status = next; for (const listener of mocks.listeners) listener(); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  mocks.account.status = status(); mocks.refresh.mockReset().mockResolvedValue(true);
  mocks.invoke.mockReset().mockImplementation(async (command) => {
    if (command === "account_invitations") return { invites: [invite()] };
    if (command === "account_invitation_accept") return { organizationId: "joined", organizationName: "Research & Development", role: "member" };
    if (command === "account_invitation_decline") return { declined: true };
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); resetInvitations(); mocks.listeners.clear(); vi.useRealTimers(); });

describe("in-app organization invitations", () => {
  it("shows a catalog-refreshed invite in both callout and list without needing an existing organization", async () => {
    mocks.invoke.mockResolvedValueOnce({ invites: [] });
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findByText("No pending invitations.");
    expect(screen.queryByTestId("sidebar-invitations")).toBeNull();
    await act(() => refreshInvitations());
    expect(screen.getAllByText("Join Research & Development")).toHaveLength(2);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "account_invitations")).toHaveLength(2);
  });
  it("accepts once across both surfaces, disables both actions, refreshes membership and removes both rows", async () => {
    const acceptance = deferred<unknown>();
    mocks.invoke.mockImplementation((command) => command === "account_invitations" ? Promise.resolve({ invites: [invite()] }) : acceptance.promise);
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    const callout = await screen.findByTestId("sidebar-invitations");
    fireEvent.click(within(callout).getByRole("button", { name: "Accept" }));
    fireEvent.click(within(callout).getByRole("button", { name: "Decline" }));
    await respondToInvitation("inv-1", "accept");
    expect(screen.getAllByRole("button", { name: "Accepting…" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    await act(async () => { acceptance.resolve({ organizationId: "joined" }); });
    await waitFor(() => expect(screen.queryAllByTestId("organization-invitation")).toHaveLength(0));
    expect(mocks.refresh).toHaveBeenCalledWith(status().context);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "account_invitation_accept")).toEqual([["account_invitation_accept", { inviteId: "inv-1", contextRevision: "1" }]]);
  });
  it("declines without changing membership and a late earlier list cannot resurrect the invite", async () => {
    render(<OrganizationInvitations sidebar />); await screen.findByText("Join Research & Development");
    const oldList = deferred<{ invites: ReturnType<typeof invite>[] }>();
    mocks.invoke.mockImplementationOnce(() => oldList.promise);
    let refresh!: Promise<void>; act(() => { refresh = refreshInvitations(); });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(screen.queryByText("Join Research & Development")).toBeNull());
    await act(async () => { oldList.resolve({ invites: [invite()] }); await refresh; });
    expect(getInvitations().invitations).toEqual([]); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it.each(["accept", "decline"] as const)("drops a late %s outcome and errors after logout/account replacement", async (action) => {
    bootInvitations(); await refreshInvitations();
    const operation = deferred<unknown>(); mocks.invoke.mockImplementationOnce(() => operation.promise);
    const response = respondToInvitation("inv-1", action);
    changeAccount({ state: "signed-out", identity: null, lastError: null, expiresAt: null });
    changeAccount(status("two", "2")); await refreshInvitations();
    operation.reject({ code: "forbidden" }); await response;
    expect(getInvitations().scope).toBe(JSON.stringify(["two", "2"]));
    expect(getInvitations().error).toBeNull(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("drops a late list after signing out and back into the same account", async () => {
    const oldList = deferred<{ invites: ReturnType<typeof invite>[] }>(); mocks.invoke.mockImplementationOnce(() => oldList.promise);
    bootInvitations();
    changeAccount({ state: "signed-out", identity: null, lastError: null, expiresAt: null });
    mocks.invoke.mockResolvedValueOnce({ invites: [] }); changeAccount(status("one", "new-generation")); await refreshInvitations();
    oldList.resolve({ invites: [invite("old")] }); await oldList.promise;
    expect(getInvitations().invitations).toEqual([]);
  });
  it.each(["not_found", "invite_expired"])("removes %s invitations and explains the outcome", async (code) => {
    render(<OrganizationInvitations />); await screen.findByText("Join Research & Development");
    mocks.invoke.mockRejectedValueOnce({ code }); fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByRole("alert"); expect(screen.queryByText("Join Research & Development")).toBeNull();
  });
  it.each(["forbidden", "email_unverified", "invite_requires_pro"])("preserves the invite and translates %s into actionable copy", async (code) => {
    render(<OrganizationInvitations />); await screen.findByText("Join Research & Development");
    mocks.invoke.mockRejectedValueOnce({ code }); fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect((await screen.findByRole("alert")).textContent).not.toContain(code); expect(screen.getByText("Join Research & Development")).toBeTruthy();
  });
  it("removes expired rows on the polling tick even when offline", async () => {
    vi.useFakeTimers(); bootInvitations(); await refreshInvitations();
    mocks.invoke.mockRejectedValue({ code: "unavailable" }); await vi.advanceTimersByTimeAsync(60_001);
    expect(getInvitations().invitations).toEqual([]);
  });
  it.each(["accept", "decline"] as const)("keeps a terminal %s refusal when a list started during the mutation lands late", async (action) => {
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findAllByText("Join Research & Development");
    const mutation = deferred<unknown>(); const list = deferred<{ invites: ReturnType<typeof invite>[] }>();
    mocks.invoke.mockImplementationOnce(() => mutation.promise).mockImplementationOnce(() => list.promise);
    let response!: Promise<void>; let refresh!: Promise<void>;
    act(() => { response = respondToInvitation("inv-1", action); });
    act(() => { refresh = refreshInvitations(); });
    await act(async () => { mutation.reject({ code: "not_found" }); await response; });
    expect(screen.queryAllByTestId("organization-invitation")).toHaveLength(0);
    await act(async () => { list.resolve({ invites: [invite()] }); await refresh; });
    expect(screen.queryAllByTestId("organization-invitation")).toHaveLength(0);
    expect(screen.getAllByRole("alert").every((alert) => alert.textContent?.includes("no longer available"))).toBe(true);
    mocks.invoke.mockResolvedValueOnce({ invites: [invite("new-invitation")] });
    await act(() => refreshInvitations());
    expect(screen.getAllByTestId("organization-invitation")).toHaveLength(2);
  });
  it.each([
    { action: "decline", code: "forbidden", message: "Your account does not have permission" },
    { action: "decline", code: "organization_members_outcome_unknown", message: "The response was lost" },
    { action: "accept", code: "forbidden", message: "Your account does not have permission" },
    { action: "accept", code: "organization_members_outcome_unknown", message: "The response was lost" },
    { action: "accept", code: "email_unverified", message: "Verify your account email" },
    { action: "accept", code: "invite_requires_pro", message: "Accepting this invitation requires TerminalX Pro" },
  ].flatMap((scenario) => ["success", "failure"].map((listOutcome) => ({ ...scenario, listOutcome }))))("keeps $action $code feedback when a list started during the action finishes with $listOutcome", async ({ action, code, message, listOutcome }) => {
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findAllByText("Join Research & Development");
    const mutation = deferred<unknown>(); const list = deferred<{ invites: ReturnType<typeof invite>[] }>();
    mocks.invoke.mockImplementationOnce(() => mutation.promise).mockImplementationOnce(() => list.promise);
    fireEvent.click(within(screen.getByTestId("sidebar-invitations")).getByRole("button", { name: action === "accept" ? "Accept" : "Decline" }));
    expect(screen.getAllByRole("button", { name: action === "accept" ? "Accepting…" : "Declining…" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    let refresh!: Promise<void>; act(() => { refresh = refreshInvitations(); });
    await act(async () => { mutation.reject({ code }); });
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const errors = screen.getAllByRole("alert").map((alert) => alert.textContent);
    expect(errors.every((error) => error?.includes(message))).toBe(true);
    await act(async () => {
      if (listOutcome === "success") list.resolve({ invites: [invite()] });
      else list.reject({ code: "unavailable" });
      await refresh;
    });
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual(errors);
    expect(screen.getAllByTestId("organization-invitation")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^(Accept|Decline)$/ }).every((button) => !button.hasAttribute("disabled"))).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === `account_invitation_${action}`)).toHaveLength(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(action === "accept" ? 1 : 0);
    mocks.invoke.mockResolvedValueOnce({ invites: [{ ...invite("new"), organizationName: "Another team" }] });
    await act(() => refreshInvitations());
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.getAllByText("Join Another team")).toHaveLength(2);
  });
  it("preserves an Accept refusal against a list started during its membership reconciliation", async () => {
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findAllByText("Join Research & Development");
    const membership = deferred<boolean>(); const list = deferred<{ invites: ReturnType<typeof invite>[] }>();
    mocks.refresh.mockImplementationOnce(() => membership.promise);
    mocks.invoke.mockRejectedValueOnce({ code: "email_unverified" }).mockImplementationOnce(() => list.promise);
    let response!: Promise<void>; let refresh!: Promise<void>;
    act(() => { response = respondToInvitation("inv-1", "accept"); });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    act(() => { refresh = refreshInvitations(); });
    await act(async () => { membership.resolve(true); await response; });
    await act(async () => { list.resolve({ invites: [invite()] }); await refresh; });
    expect(screen.getAllByRole("alert").every((alert) => alert.textContent?.includes("Verify your account email"))).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("preserves a Decline refusal against membership recovery started while that Decline was pending", async () => {
    const first = invite(); const second = invite("second");
    mocks.invoke.mockResolvedValueOnce({ invites: [first, second] }); mocks.refresh.mockResolvedValueOnce(false);
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findAllByText("Join Research & Development");
    mocks.invoke.mockRejectedValueOnce({ code: "organization_members_outcome_unknown" });
    await act(() => respondToInvitation(first.id, "accept"));
    const mutation = deferred<unknown>(); const recovery = deferred<boolean>();
    mocks.invoke.mockImplementationOnce(() => mutation.promise).mockResolvedValueOnce({ invites: [second] });
    mocks.refresh.mockImplementationOnce(() => recovery.promise);
    let response!: Promise<void>; act(() => { response = respondToInvitation(second.id, "decline"); });
    await act(() => refreshInvitations());
    await act(async () => { mutation.reject({ code: "forbidden" }); await response; });
    await act(async () => { recovery.resolve(true); await recovery.promise; });
    expect(screen.getAllByRole("alert").every((alert) => alert.textContent?.includes("Your account does not have permission"))).toBe(true);
    expect(screen.queryAllByText("Organizations refreshed.")).toHaveLength(0);
    expect(getInvitations().membershipRefreshNeeded).toBe(true);
  });
  it("retains uncertain acceptance recovery through a failed membership read and list-only refresh", async () => {
    mocks.refresh.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<OrganizationInvitations />); await screen.findByText("Join Research & Development");
    mocks.invoke.mockRejectedValueOnce({ code: "organization_members_outcome_unknown" });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByText(/The response was lost/);
    mocks.invoke.mockResolvedValueOnce({ invites: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh invitations" }));
    await screen.findByText(/Your organization membership could not be refreshed/);
    expect(screen.queryByText(/^Joined /)).toBeNull();
    mocks.invoke.mockResolvedValueOnce({ invites: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh invitations" }));
    await screen.findByText("Organizations refreshed.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "account_invitation_accept")).toHaveLength(1);
  });
  it.each(["forbidden", "not_found"])("keeps a newer Decline %s error when an older membership retry succeeds", async (code) => {
    const first = invite(); const second = { ...invite("second"), organizationName: "Another team" };
    mocks.invoke.mockResolvedValueOnce({ invites: [first, second] });
    mocks.refresh.mockResolvedValueOnce(false);
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findAllByText("Join Another team");
    mocks.invoke.mockRejectedValueOnce({ code: "organization_members_outcome_unknown" });
    await act(() => respondToInvitation(first.id, "accept"));
    const recovery = deferred<boolean>(); mocks.refresh.mockImplementationOnce(() => recovery.promise);
    mocks.invoke.mockResolvedValueOnce({ invites: [second] });
    await act(() => refreshInvitations());
    mocks.invoke.mockRejectedValueOnce({ code });
    await act(() => respondToInvitation(second.id, "decline"));
    const error = getInvitations().error;
    await act(async () => { recovery.resolve(true); await recovery.promise; });
    expect(getInvitations().error).toBe(error);
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([error, error]);
    expect(screen.queryAllByText("Organizations refreshed.")).toHaveLength(0);
    expect(screen.queryAllByText("Join Another team")).toHaveLength(code === "not_found" ? 0 : 2);
    expect(getInvitations().membershipRefreshNeeded).toBe(true);
  });
  it.each(["success", "unknown"])("keeps a newer action error when an earlier Accept %s membership read completes", async (outcome) => {
    const first = invite(); const second = { ...invite("second"), organizationName: "Another team" };
    mocks.invoke.mockResolvedValueOnce({ invites: [first, second] });
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findAllByText("Join Another team");
    const recovery = deferred<boolean>(); mocks.refresh.mockImplementationOnce(() => recovery.promise);
    if (outcome === "success") mocks.invoke.mockResolvedValueOnce({ organizationId: "joined" });
    else mocks.invoke.mockRejectedValueOnce({ code: "organization_members_outcome_unknown" });
    let accepting!: Promise<void>; act(() => { accepting = respondToInvitation(first.id, "accept"); });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    mocks.invoke.mockRejectedValueOnce({ code: "forbidden" });
    await act(() => respondToInvitation(second.id, "decline"));
    const error = getInvitations().error;
    await act(async () => { recovery.resolve(true); await accepting; });
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([error, error]);
    expect(getInvitations().notice).toBeNull();
    expect(getInvitations().membershipRefreshNeeded).toBe(true);
    expect(getInvitations().pending).toEqual({});
    expect(screen.queryAllByText("Join Another team")).toHaveLength(2);
  });
  it("does not reconcile an uncertain membership while another Accept is still pending", async () => {
    const first = invite(); const second = { ...invite("second"), organizationName: "Another team" };
    mocks.invoke.mockResolvedValueOnce({ invites: [first, second] }); mocks.refresh.mockResolvedValueOnce(false);
    render(<OrganizationInvitations />); await screen.findByText("Join Another team");
    mocks.invoke.mockRejectedValueOnce({ code: "organization_members_outcome_unknown" });
    await act(() => respondToInvitation(first.id, "accept"));
    const pending = deferred<unknown>(); mocks.invoke.mockImplementationOnce(() => pending.promise);
    let accepting!: Promise<void>; act(() => { accepting = respondToInvitation(second.id, "accept"); });
    mocks.invoke.mockResolvedValueOnce({ invites: [second] }); await act(() => refreshInvitations());
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(getInvitations().membershipRefreshNeeded).toBe(true);
    await act(async () => { pending.resolve({ organizationId: "second-org" }); await accepting; });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(getInvitations().membershipRefreshNeeded).toBe(false);
  });
  it("retries membership refresh after a successful accept without sending accept again", async () => {
    mocks.refresh.mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<OrganizationInvitations />); await screen.findByText("Join Research & Development");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByText(/Refresh to load your updated organizations/);
    mocks.invoke.mockResolvedValueOnce({ invites: [] }); fireEvent.click(screen.getByRole("button", { name: "Refresh invitations" }));
    await screen.findByText("Organizations refreshed."); expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "account_invitation_accept")).toHaveLength(1);
  });
  it.each([true, false].flatMap((fresh) => [false, true].map((newerDecline) => ({ fresh, newerDecline }))))("does not report a failed membership read while Accept reconciliation is pending (fresh=$fresh, newer Decline=$newerDecline)", async ({ fresh, newerDecline }) => {
    const second = { ...invite("second"), organizationName: "Another team" };
    mocks.invoke.mockResolvedValueOnce({ invites: [invite(), second] });
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findAllByText("Join Another team");
    const membership = deferred<boolean>(); mocks.refresh.mockImplementationOnce(() => membership.promise);
    let response!: Promise<void>; act(() => { response = respondToInvitation("inv-1", "accept"); });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    mocks.invoke.mockResolvedValueOnce({ invites: [second] }); await act(() => refreshInvitations());
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.queryAllByText(/^Joined /)).toHaveLength(0);
    expect(getInvitations().pending["inv-1"]).toBe("accept");
    if (newerDecline) {
      mocks.invoke.mockRejectedValueOnce({ code: "forbidden" });
      await act(() => respondToInvitation(second.id, "decline"));
    }
    await act(async () => { membership.resolve(fresh); await response; });
    expect(getInvitations().pending).toEqual({});
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "account_invitation_accept")).toHaveLength(1);
    if (newerDecline) {
      expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual(Array(2).fill("Your account does not have permission to use this invitation. Refresh or sign in again."));
      expect(screen.queryAllByText(/^Joined /)).toHaveLength(0);
      expect(getInvitations().membershipRefreshNeeded).toBe(true);
    } else {
      expect(screen.getAllByText(fresh ? "Joined Research & Development." : "Joined Research & Development. Refresh to load your updated organizations.")).toHaveLength(2);
      expect(getInvitations().membershipRefreshNeeded).toBe(!fresh);
      if (fresh) expect(screen.queryAllByRole("alert")).toHaveLength(0);
      else expect(screen.getAllByRole("alert").every((alert) => alert.textContent?.includes("Your organization membership could not be refreshed"))).toBe(true);
    }
  });
  it.each([true, false])("shows recovery failure only after the retry completes (fresh=%s)", async (fresh) => {
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findAllByText("Join Research & Development");
    mocks.refresh.mockResolvedValueOnce(false);
    await act(() => respondToInvitation("inv-1", "accept"));
    const membership = deferred<boolean>(); mocks.refresh.mockImplementationOnce(() => membership.promise);
    mocks.invoke.mockResolvedValueOnce({ invites: [] }); await act(() => refreshInvitations());
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    await act(async () => { membership.resolve(fresh); await membership.promise; });
    expect(getInvitations().membershipRefreshNeeded).toBe(!fresh);
    if (fresh) {
      expect(screen.queryAllByRole("alert")).toHaveLength(0);
      expect(screen.getAllByText("Organizations refreshed.")).toHaveLength(2);
    } else expect(screen.getAllByRole("alert").every((alert) => alert.textContent?.includes("Your organization membership could not be refreshed"))).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "account_invitation_accept")).toHaveLength(1);
  });
  it("keeps a separate list permission error when membership recovery succeeds", async () => {
    render(<><OrganizationInvitations sidebar /><OrganizationInvitations /></>);
    await screen.findAllByText("Join Research & Development");
    mocks.refresh.mockResolvedValueOnce(false); await act(() => respondToInvitation("inv-1", "accept"));
    const membership = deferred<boolean>(); mocks.refresh.mockImplementationOnce(() => membership.promise);
    mocks.invoke.mockRejectedValueOnce({ code: "forbidden" }); await act(() => refreshInvitations());
    await act(async () => { membership.resolve(true); await membership.promise; });
    expect(screen.getAllByRole("alert").every((alert) => alert.textContent?.includes("Your account does not have permission"))).toBe(true);
    expect(getInvitations().membershipRefreshNeeded).toBe(false);
  });
  it("does not restore a recovery warning when an older retry fails after a newer retry succeeds", async () => {
    render(<OrganizationInvitations />); await screen.findByText("Join Research & Development");
    mocks.refresh.mockResolvedValueOnce(false); await act(() => respondToInvitation("inv-1", "accept"));
    const older = deferred<boolean>(); const newer = deferred<boolean>();
    mocks.refresh.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    mocks.invoke.mockResolvedValue({ invites: [] });
    await act(() => refreshInvitations()); await act(() => refreshInvitations());
    await act(async () => { newer.resolve(true); await newer.promise; });
    await act(async () => { older.resolve(false); await older.promise; });
    expect(getInvitations().membershipRefreshNeeded).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Organizations refreshed.")).toBeTruthy();
  });
});
