import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { organizationRunningCount, organizationVisibility, reconcileOrganizationPrefs, setOrganizationHidden } from "./organizationVisibility";
import { getCloudCatalog } from "@/lib/cloudCatalog";

const mocks = vi.hoisted(() => ({ status: null as unknown as AccountStatus, ask: vi.fn() }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: mocks.status }), subscribeAccount: () => () => {}, useAccount: () => ({ status: mocks.status }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask }));

const org = (id: string, name: string) => ({ id, name, role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } });
const account: AccountStatus = { state: "signed-in", identity: { name: "Ada", email: "ada@example.com", organization: "Beta", organizationId: "b" }, expiresAt: null, lastError: null, multiOrg: true, organizations: [org("a", "Acme"), org("b", "Beta"), org("c", "Gamma")] };
const ids = (orgs: { id: string }[]) => orgs.map((org) => org.id);

beforeEach(() => {
  mocks.status = account;
  mocks.ask.mockReset().mockResolvedValue(true);
  setPrefs({ organizationDisplay: "all", hiddenOrganizations: [], selectedOrganization: null });
});

describe("organization visibility", () => {
  it("defaults to every organization, default first; ignores unknown hidden ids", () => {
    expect(ids(organizationVisibility(account, getPrefs()).orgs)).toEqual(["b", "a", "c"]);
    setPrefs({ hiddenOrganizations: ["b", "left"] });
    const visibility = organizationVisibility(account, getPrefs());
    expect(ids(visibility.orgs)).toEqual(["a", "c"]);
    expect(ids(visibility.hidden)).toEqual(["b"]);
    expect(visibility.defaultOrg).toBe("b");
  });

  it("shows exactly one, defaulting to the default org, and ignores hide choices until All returns", () => {
    setPrefs({ hiddenOrganizations: ["b", "a"], organizationDisplay: "one" });
    expect(ids(organizationVisibility(account, getPrefs()).orgs)).toEqual(["b"]);
    setPrefs({ selectedOrganization: "a" });
    expect(ids(organizationVisibility(account, getPrefs()).orgs)).toEqual(["a"]);
    setPrefs({ organizationDisplay: "all" });
    expect(ids(organizationVisibility(account, getPrefs()).orgs)).toEqual(["c"]);
    expect(getPrefs().hiddenOrganizations).toEqual(["b", "a"]);
  });

  it.each(["all", "one"] as const)("temporarily reveals the selected hidden session in %s without changing preferences", (organizationDisplay) => {
    setPrefs({ hiddenOrganizations: ["a"], selectedOrganization: "b", organizationDisplay });
    const before = getPrefs();
    const revealed = organizationVisibility(account, before, "cloud:a:ws:session");
    expect(revealed.visibleIds.has("a")).toBe(true);
    expect(revealed.temporaryOrganization).toBe("a");
    expect(organizationVisibility(account, before, "local-session").visibleIds.has("a")).toBe(false);
    expect(getPrefs()).toBe(before);
  });

  it("shows new memberships in All and preserves a chosen organization in One", () => {
    const joined = { ...account, organizations: [...account.organizations!, org("d", "Delta")] };
    expect(organizationVisibility(joined, getPrefs()).visibleIds.has("d")).toBe(true);
    setPrefs({ organizationDisplay: "one", selectedOrganization: "a" });
    reconcileOrganizationPrefs(joined);
    expect(ids(organizationVisibility(joined, getPrefs()).orgs)).toEqual(["a"]);
  });

  it("prunes departed memberships and saves a valid One-mode fallback", () => {
    setPrefs({ hiddenOrganizations: ["a", "left"], organizationDisplay: "one", selectedOrganization: "left" });
    reconcileOrganizationPrefs(account);
    expect(getPrefs()).toMatchObject({ hiddenOrganizations: ["a"], selectedOrganization: "b" });
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).toMatchObject({ hiddenOrganizations: ["a"], selectedOrganization: "b" });
    reconcileOrganizationPrefs({ ...account, state: "signed-out", organizations: undefined });
    expect(getPrefs().hiddenOrganizations).toEqual(["a"]);
  });

  it("keeps an initialized One selection when the default later changes", () => {
    setPrefs({ organizationDisplay: "one" });
    reconcileOrganizationPrefs(account);
    reconcileOrganizationPrefs({ ...account, identity: { ...account.identity!, organizationId: "c" } });
    expect(getPrefs().selectedOrganization).toBe("b");
  });

  it("cannot hide Local or a non-member and never changes the default organization", async () => {
    expect(await setOrganizationHidden("local", true)).toBe(false);
    expect(await setOrganizationHidden("left", true)).toBe(false);
    expect(await setOrganizationHidden("b", true)).toBe(true);
    expect(mocks.status.identity?.organizationId).toBe("b");
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(await setOrganizationHidden("b", false)).toBe(true);
    expect(getPrefs().hiddenOrganizations).toEqual([]);
  });
});

describe("running workspace counts", () => {
  it("counts running, provisioning, and attention-required machines, excluding stopped and archived machines", () => {
    const catalog = getCloudCatalog();
    const workspaces = ["ready", "provisioning", "attention-required", "suspended", "archived"].map((state, id) => ({ workspace: { id: String(id), state }, latestOperation: null })) as CloudWorkspaceListItem[];
    const orgCatalog = { orgId: "a", workspaces, repositories: null, repositoriesAt: null, quota: null, fetchedAt: 1, source: "live" as const, error: null, sessions: {} };
    expect(organizationRunningCount("a", { ...catalog, orgs: { a: orgCatalog } })).toBe(3);
    const quota = { used: 9, limit: 10, running: { used: 5, limit: 10 } };
    expect(organizationRunningCount("a", { ...catalog, orgs: { a: { ...orgCatalog, quota } } })).toBe(5);
  });
});
