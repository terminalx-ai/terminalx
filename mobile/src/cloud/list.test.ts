import { describe, expect, it } from "vitest";
import type { CatalogOrganization } from "./catalog";
import { cloudSections, emptyOrganizationsLabel, setupCandidates } from "./list";

const org = (orgId: string, workspaces: string[], error: string | null = null): CatalogOrganization => ({
  organization: { orgId, name: orgId.toUpperCase(), role: "member" },
  workspaces: workspaces.map((id) => ({ workspace: { id, orgId, name: id, provider: "box", state: "suspended" }, latestOperation: null })),
  error,
  loaded: true,
});

describe("the Cloud list's order (#988)", () => {
  it("puts organizations with workspaces first, then unread ones, and folds the empty ones into one row", () => {
    const { sections, empty } = cloudSections([org("personal", []), org("acme", ["a1", "a2"]), org("e2e-1", []), org("broken", [], "cloud_provider_unavailable"), org("northwind", ["n1"]), org("e2e-2", [])]);
    expect(sections.map((section) => [section.key, section.data.map((item) => item.workspace.id)])).toEqual([["acme", ["a1", "a2"]], ["northwind", ["n1"]], ["broken", []]]);
    expect(sections[2].error).toBe("cloud_provider_unavailable");
    expect(empty.map((organization) => organization.orgId)).toEqual(["personal", "e2e-1", "e2e-2"]);
  });

  it("keeps an organization whose list failed but still shows what was read before as a section", () => {
    const { sections, empty } = cloudSections([org("acme", ["a1"], "cloud_provider_unavailable")]);
    expect(sections.map((section) => section.key)).toEqual(["acme"]);
    expect(empty).toEqual([]);
  });

  it("counts the folded row in words", () => {
    expect(emptyOrganizationsLabel(5)).toBe("5 organizations with no workspaces");
    expect(emptyOrganizationsLabel(1)).toBe("1 organization with no workspaces");
  });

  it("reads the setup of the organizations with no workspaces, never one whose list could not be read (25.01)", () => {
    const candidates = setupCandidates([org("personal", []), org("acme", ["a1"]), org("broken", [], "cloud_provider_unavailable"), org("e2e", [])]);
    expect(candidates.map((organization) => organization.orgId)).toEqual(["personal", "e2e"]);
  });
});
