import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));



import type { AccountStatus } from "./api";

afterEach(async () => { (await import("./cloudCatalog")).resetCloudCatalog(); (await import("./organizationInvitations")).resetInvitations(); });
it.each([false, true])("catalog refresh and acceptance recover the live joined organization without restart (lost response: %s)", async (lostResponse) => {
  vi.resetModules();
  const { bootAccount, getAccount } = await import("./account");
  const { bootCloudCatalog, getCloudCatalog, refreshCloudCatalog } = await import("./cloudCatalog");
  const { getInvitations, refreshInvitations, respondToInvitation } = await import("./organizationInvitations");
  native.invoke.mockReset();
  let status: AccountStatus = { state: "signed-in", identity: { name: "New member", email: "new@example.com", organization: "", organizationId: "" }, context: { account: "new-member", scope: "new-member", revision: "new-member:1" }, organizations: [], multiOrg: true, expiresAt: null, lastError: null };
  let invited = false;
  let failMembership = false;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === "account_status") return status;
    if (command === "account_refresh_roles") {
      if (failMembership) { failMembership = false; throw { code: "unavailable" }; }
      return { status, fresh: true };
    }
    if (command === "account_invitations") return { invites: invited ? [{ id: "inv", organizationName: "Joined team", role: "member", expiresAt: Date.now() + 60_000 }] : [] };
    if (command === "account_invitation_accept") {
      invited = false;
      status = { ...status, organizations: [{ id: "joined", name: "Joined team", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } }] };
      if (lostResponse) { failMembership = true; throw { code: "organization_members_outcome_unknown" }; }
      return { organizationId: "joined", organizationName: "Joined team", role: "member" };
    }
    if (command === "cloud_catalog_load") return null;
    if (command === "cloud_workspaces") { expect(args.orgId).toBe("joined"); return { workspaces: [], quota: { used: 0, limit: 3 } }; }
    if (command === "cloud_workspace_repositories") return { configured: true, repositories: [] };
    if (command === "cloud_catalog_save") return;
    return [];
  });
  await bootAccount(); bootCloudCatalog(); await refreshInvitations();
  expect(getInvitations().invitations).toEqual([]);
  invited = true;
  await refreshCloudCatalog();
  await vi.waitFor(() => expect(getInvitations().invitations).toHaveLength(1));
  await respondToInvitation("inv", "accept");
  if (lostResponse) {
    expect(getAccount().status.organizations).toEqual([]);
    expect(getInvitations().membershipRefreshNeeded).toBe(true);
    await refreshInvitations();
  }
  await vi.waitFor(() => expect(getAccount().status.organizations?.map((org) => org.id)).toEqual(["joined"]));
  await vi.waitFor(() => expect(getCloudCatalog().orgs.joined?.source).toBe("live"));
  expect(getInvitations().invitations).toEqual([]);
  expect(native.invoke.mock.calls.some(([command]) => command === "organization_select")).toBe(false);
  expect(native.invoke.mock.calls.filter(([command]) => command === "account_invitation_accept")).toHaveLength(1);
});
