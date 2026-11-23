import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { setupView } from "./setup";

vi.mock("expo-router", () => ({ useSitemap: () => null }));
const { SETUP_PATHS, pagePaths, stepHref, withPages } = await import("./setup-routes");

// PRO-527: a path with no page of its own opens as a workspace of that name (`cloud/[workspaceId]`),
// so each path the setup opens is checked against the pages the app has.

const app = join(dirname(fileURLToPath(import.meta.url)), "../../app");
const hasPage = (path: string) => [`${path}.tsx`, `${path}/index.tsx`].some((file) => existsSync(join(app, file)));

/**
 * Pages of the sibling issues that are not on this branch yet, by the pull
 * request that adds each at this path. Take an entry out when its page lands:
 * the test below fails until that is done, and from then on checks the path.
 */
const AWAITED: Partial<Record<keyof typeof SETUP_PATHS, string>> = {
  compute: "#1509 (PRO-528) mobile/app/cloud/compute.tsx",
  agents: "#1510 (PRO-529) mobile/app/agent-logins/index.tsx",
};

describe("the pages the setup opens", () => {
  for (const [name, path] of Object.entries(SETUP_PATHS) as [keyof typeof SETUP_PATHS, string][]) {
    it(`${path} is a page of the app${AWAITED[name] ? `, once ${AWAITED[name]} lands` : ""}`, () => {
      // An awaited page that is there is no longer awaited: its entry goes, and the path is checked from then on.
      expect(hasPage(path)).toBe(!AWAITED[name]);
    });
  }

  it("opens a step with the organization's id, and the organization step with none", () => {
    expect(stepHref("organization", "org-a")).toBe("/cloud/setup/organization");
    expect(stepHref("compute", null)).toBe("/cloud/setup/organization");
    expect(stepHref("compute", "org-a")).toEqual({ pathname: "/cloud/compute", params: { orgId: "org-a" } });
    expect(stepHref("agents", "org-a")).toEqual({ pathname: "/agent-logins", params: { orgId: "org-a" } });
    expect(stepHref("launch", "org-a")).toEqual({ pathname: "/cloud/new", params: { orgId: "org-a" } });
  });
});

describe("the pages the router has", () => {
  const node = (contextKey: string, href: string, children: any[] = []) => ({ contextKey, filename: contextKey, href, isInternal: false, isGenerated: false, children });
  const sitemap = node("./_layout.tsx", "/", [
    node("./(tabs)/_layout.tsx", "/(tabs)", [node("./(tabs)/cloud.tsx", "/(tabs)/cloud")]),
    node("./cloud/[workspaceId].tsx", "/cloud/[workspaceId]"),
    node("./cloud/compute.tsx", "/cloud/compute"),
    node("./agent-logins/index.tsx", "/agent-logins"),
  ]);

  it("lists pages at any depth, and no layout as a page", () => {
    const paths = pagePaths(sitemap);
    expect([...paths].sort()).toEqual(["/(tabs)/cloud", "/agent-logins", "/cloud/[workspaceId]", "/cloud/compute"]);
    expect(pagePaths(null).size).toBe(0);
  });

  it("keeps a step whose page is missing from opening, and takes the button with it", () => {
    const organization = { orgId: "org-a", name: "Acme", role: "owner" as const, isPersonal: false };
    const unread = { value: [], error: null, unreachable: false, refused: false };
    const view = setupView(organization, true, { providers: unread, logins: unread, read: true });
    expect(view.action).toEqual({ step: "compute", label: "Continue: connect compute" });
    const without = withPages(view, (step) => step !== "compute");
    expect(without.action).toBeNull();
    expect(without.steps.find((step) => step.key === "compute")).toMatchObject({ state: "next", opens: false });
    expect(without.steps.find((step) => step.key === "organization")!.opens).toBe(true);
    // With every page there, nothing changes.
    expect(withPages(view, () => true)).toEqual(view);
  });
});
