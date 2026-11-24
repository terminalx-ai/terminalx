import { describe, expect, it, vi } from "vitest";
import { CloudApiError, type CloudCredential, type CloudProvider } from "../../api";
import { choiceDetail, computeStanding, connectedAgents, focusOrganization, managesSetup, setupModel, type OrganizationReads } from "./steps";

// The agent names come from the logins module, which draws its state badge with React Native.
vi.mock("react-native", () => import("@mobile/ui/testing/native"));

/** The steps of 25.01 decided from the server's answers alone. */

const provider = (id: string, displayName: string, availability: string, keyed = true) => ({ id, displayName, availability, canManage: true, descriptor: { credentialFields: keyed ? [{ name: "credential", kind: "secret", label: "Key" }] : [] } }) as unknown as CloudProvider;
const login = (provider: string, state = "connected") => ({ id: `cred-${provider}`, provider, authKind: "api-key", fingerprint: "f", version: 1, updatedAt: 1, state, sharedUse: "organization", epoch: 1 }) as CloudCredential;
const read = <T,>(value: T) => ({ state: "read" as const, value, error: null });
const failed = (code = "cloud_workspace_unavailable", status: number | null = null) => ({ state: "failed" as const, value: null, error: new CloudApiError(code, status) });
const owner = { orgId: "org-1", name: "Northwind", role: "owner" };
const reads = (providers: CloudProvider[], logins: CloudCredential[] = []): OrganizationReads => ({ providers: read(providers), logins: read(logins) });

describe("computeStanding", () => {
  it("is done with a connected key, says a key that stopped working before a provider ready as it is, and is missing otherwise", () => {
    expect(computeStanding([provider("box", "Boat", "available"), provider("a37", "Agent37", "available")])).toEqual({ kind: "done", detail: "Boat, Agent37 · connected" });
    expect(computeStanding([provider("tx", "TerminalX Cloud", "available", false), provider("box", "Boat", "attention-required")])).toMatchObject({ kind: "attention", provider: { id: "box" } });
    expect(computeStanding([provider("tx", "TerminalX Cloud", "available", false)])).toEqual({ kind: "done", detail: "TerminalX Cloud · ready to use" });
    expect(computeStanding([provider("tx", "TerminalX Cloud", "disabled-for-create", false), provider("box", "Boat", "not-connected")])).toEqual({ kind: "missing" });
  });
});

describe("connectedAgents", () => {
  it("names the agents with a working login, in the phone's order; GitHub is not an agent", () => {
    expect(connectedAgents([login("claude"), login("codex"), login("cursor", "revoked"), login("github")])).toEqual(["Codex", "Claude Code"]);
  });
});

describe("setupModel", () => {
  it("is step 1 until the organization is chosen or something of it is set up", () => {
    const fresh = setupModel({ organization: owner, reads: reads([]), chosen: false, createsOrganizations: true });
    expect(fresh.steps.map((step) => step.state)).toEqual(["next", "waiting", "waiting", "waiting"]);
    expect(fresh.action).toEqual({ label: "Start setup", href: "/cloud/setup/organization?orgId=org-1", launch: false });
    const chosen = setupModel({ organization: owner, reads: reads([]), chosen: true, createsOrganizations: true });
    expect(chosen.steps.map((step) => step.state)).toEqual(["done", "next", "waiting", "waiting"]);
    expect(chosen.action?.href).toBe("/cloud/compute?orgId=org-1");
  });

  it("opens a step's page once it is reached, not while it waits or could not be read; a key to fix opens", () => {
    const fresh = setupModel({ organization: owner, reads: reads([]), chosen: false, createsOrganizations: true });
    expect(fresh.steps.map((step) => step.href)).toEqual(["/cloud/setup/organization?orgId=org-1", null, null, null]);
    const unread = setupModel({ organization: owner, reads: { providers: failed(), logins: failed() }, chosen: true, createsOrganizations: true });
    expect(unread.steps.map((step) => step.href)).toEqual(["/cloud/setup/organization?orgId=org-1", null, null, null]);
    const attention = setupModel({ organization: owner, reads: reads([provider("box", "Boat", "attention-required")], [login("codex")]), chosen: true, createsOrganizations: true });
    expect(attention.steps.map((step) => step.href)).toEqual(["/cloud/setup/organization?orgId=org-1", "/cloud/compute?orgId=org-1", "/cloud/logins?orgId=org-1", null]);
  });

  it("never calls a step done or missing on a guess: a list that could not be read says so, and a read under way waits", () => {
    const reading = setupModel({ organization: owner, reads: null, chosen: true, createsOrganizations: true });
    expect(reading.reading).toBe(true);
    expect(reading.action).toBeNull();
    const unread = setupModel({ organization: owner, reads: { providers: failed(), logins: read([login("codex")]) }, chosen: false, createsOrganizations: true });
    expect(unread.steps[1]).toMatchObject({ state: "failed", alert: true, detail: "Could not be read. Pull down to try again." });
    expect(unread.steps[2]).toMatchObject({ state: "done", detail: "Codex · connected" });
    expect(unread.unread).toBe(true);
    expect(unread.action).toBeNull();
    // What was read before stays when a later read fails.
    const kept = setupModel({ organization: owner, reads: { providers: { ...failed(), value: [provider("box", "Boat", "available")] }, logins: read([]) }, chosen: false, createsOrganizations: true });
    expect(kept.steps[1]).toMatchObject({ state: "done", detail: "Boat · connected" });
    expect(kept.unread).toBe(false);
  });

  it("lets a member launch once compute is there, without their organization's logins", () => {
    const member = { ...owner, role: "member" };
    expect(managesSetup(member)).toBe(false);
    expect(managesSetup({ ...member, isPersonal: true })).toBe(true);
    const none = setupModel({ organization: member, reads: { providers: read([]), logins: { state: "not-asked", value: null, error: null } }, chosen: true, createsOrganizations: true });
    expect(none.noCompute).toBe(true);
    expect(none.steps.slice(1, 3).map((step) => step.href)).toEqual([null, null]);
    expect(none.action).toBeNull();
    const ready = setupModel({ organization: member, reads: { providers: read([{ ...provider("box", "Boat", "available"), canManage: false } as CloudProvider]), logins: failed("organization_admin_required", 403) }, chosen: true, createsOrganizations: true });
    expect(ready.canLaunch).toBe(true);
    expect(ready.action).toEqual({ label: "Launch a workspace", href: "/cloud/launch?orgId=org-1", launch: true });
  });
});

describe("the organization page's rows and choice", () => {
  it("says each organization's role and how far its setup is", () => {
    const personal = { orgId: "p", name: "Personal", role: "owner", isPersonal: true };
    expect(choiceDetail(personal, null, true)).toBe("Just you. A personal organization cannot have members.");
    expect(choiceDetail(personal, reads([]), false)).toBe("Personal · Owner");
    expect(choiceDetail(owner, reads([provider("box", "Boat", "available")]), false)).toBe("Owner · compute connected");
    expect(choiceDetail({ ...owner, role: "member" }, reads([]), false)).toBe("Member · an owner or admin sets it up");
  });

  it("sets up the chosen organization, else the first with something set up, else the personal one", () => {
    const personal = { orgId: "p", name: "Personal", role: "owner", isPersonal: true };
    const team = { orgId: "t", name: "Team", role: "owner" };
    expect(focusOrganization([team, personal], null, () => false)?.orgId).toBe("p");
    expect(focusOrganization([team, personal], null, (orgId) => orgId === "t")?.orgId).toBe("t");
    expect(focusOrganization([team, personal], "t", () => false)?.orgId).toBe("t");
    expect(focusOrganization([], null, () => false)).toBeNull();
  });
});
