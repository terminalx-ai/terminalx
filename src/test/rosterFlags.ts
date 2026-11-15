import type { AccountStatus, OrganizationSummary } from "@/lib/api";
import { setRosterContext } from "@/lib/organizationRoster";

/** A capability refresh delivered through the real rollout hook in roster UI tests. */
export const rosterFlagAccount = {
  status: { state: "signed-out", identity: null, expiresAt: null, lastError: null } as AccountStatus,
  listeners: new Set<() => void>(),
};
export const rosterFlagAccountMock = {
  getAccount: () => ({ status: rosterFlagAccount.status }),
  useAccount: () => ({ status: rosterFlagAccount.status }),
  subscribeAccount: (listener: () => void) => {
    rosterFlagAccount.listeners.add(listener);
    return () => { rosterFlagAccount.listeners.delete(listener); };
  },
};
export function refreshRosterFlags(enabledOrgIds: string[] = ["org-1", "org-2", "org-b"], activeOrg = "org-1") {
  rosterFlagAccount.status = {
    state: "signed-in", identity: { email: "me@example.com", name: "Me", organization: activeOrg, organizationId: activeOrg },
    context: { scope: "account", revision: "account-1", account: "account" },
    expiresAt: null, lastError: null,
    organizations: ["org-1", "org-2", "org-b"].map((id): OrganizationSummary => ({ id, name: id, role: id === "org-1" ? "owner" : "admin", cloud: { enabled: true, flags: enabledOrgIds.includes(id) ? { "team.roster.v1": true } : {} } })),
  };
  setRosterContext(activeOrg, "account-1", enabledOrgIds);
  for (const listener of [...rosterFlagAccount.listeners]) listener();
}
