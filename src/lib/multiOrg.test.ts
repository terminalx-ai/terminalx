import { describe, expect, it } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { mayStartCloudSessions } from "./multiOrg";

const status = (role: string | null, memberWorkspaces?: boolean): AccountStatus =>
  ({
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: "org-a" },
    expiresAt: null,
    lastError: null,
    organizations: role ? [{ id: "org-a", name: "Acme", role, isPersonal: false, cloud: { enabled: true, flags: {} } }] : [],
    ...(memberWorkspaces === undefined ? {} : { memberWorkspaces }),
  }) as AccountStatus;

describe("who may start a cloud session, which is what creates a workspace (PRO-73)", () => {
  it("is every member, where the server says members create", () => {
    for (const role of ["owner", "admin", "member"]) expect(mayStartCloudSessions(status(role, true), "org-a")).toBe(true);
  });

  it("stays with owners and admins against a server from before that rule", () => {
    expect(mayStartCloudSessions(status("member"), "org-a")).toBe(false);
    expect(mayStartCloudSessions(status("member", false), "org-a")).toBe(false);
    expect(mayStartCloudSessions(status("owner"), "org-a")).toBe(true);
    expect(mayStartCloudSessions(status("admin", false), "org-a")).toBe(true);
  });

  it("is not known for an organization the account has no role in, or while signed out", () => {
    expect(mayStartCloudSessions(status(null, true), "org-a")).toBeNull();
    expect(mayStartCloudSessions(status("member", true), "org-b")).toBeNull();
    expect(mayStartCloudSessions(status("member", true), null)).toBeNull();
    expect(mayStartCloudSessions({ ...status("member", true), state: "signed-out" } as AccountStatus, "org-a")).toBeNull();
  });
});
