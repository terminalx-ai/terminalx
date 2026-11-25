import { useSitemap, type Href, type SitemapType } from "expo-router";
import { useMemo } from "react";
import type { SetupStepKey, SetupView } from "./setup";

/**
 * Where each step of the cloud setup opens (25.01). The organization pages
 * are this module's own; compute (25.03, PRO-528), agent logins (25.04,
 * PRO-529) and launching (25.05, PRO-530) are their issues' screens, opened
 * here by path with the organization's id as `orgId`. Each goes back when it
 * is done, and the Cloud tab reads the steps again.
 */
export const SETUP_PATHS = {
  steps: "/cloud/setup",
  organization: "/cloud/setup/organization",
  newOrganization: "/cloud/setup/new-organization",
  compute: "/cloud/compute",
  agents: "/agent-logins",
  launch: "/cloud/new",
} as const;

/** The page of a step, for the organization being set up; the organization step needs none. */
export function stepHref(step: SetupStepKey, orgId: string | null): Href {
  if (step === "organization" || !orgId) return SETUP_PATHS.organization as Href;
  return { pathname: SETUP_PATHS[step], params: { orgId } } as unknown as Href;
}

/** The steps page of one organization: its folded row, or its name among the organizations with no workspaces. */
export function stepsHref(orgId: string): Href {
  return { pathname: SETUP_PATHS.steps, params: { orgId } } as unknown as Href;
}

/** Whether the app has a step's page: asked before anything offers to open it. */
export type HasSetupPage = (step: SetupStepKey) => boolean;

/** Every path the router has a page for, from its own list of them. */
export function pagePaths(sitemap: SitemapType | null): Set<string> {
  const paths = new Set<string>();
  const walk = (node: SitemapType) => {
    if (typeof node.href === "string" && !node.contextKey.match(/_layout\.[jt]sx?$/)) paths.add(node.href);
    node.children.forEach(walk);
  };
  if (sitemap) walk(sitemap);
  return paths;
}

/**
 * Which steps have a page in this app. A path with no page of its own would
 * open as a workspace of that name (`/cloud/[workspaceId]`), so a step whose
 * screen is not in the app yet is shown and not offered.
 */
export function useSetupPages(): HasSetupPage {
  const sitemap = useSitemap();
  return useMemo(() => {
    const paths = pagePaths(sitemap);
    return (step) => paths.has(step === "organization" ? SETUP_PATHS.organization : SETUP_PATHS[step]);
  }, [sitemap]);
}

/** The steps as drawn in this app: one whose page is missing does not open, and carries no button. */
export function withPages(view: SetupView, has: HasSetupPage): SetupView {
  return {
    ...view,
    steps: view.steps.map((step) => (step.opens && !has(step.key) ? { ...step, opens: false } : step)),
    action: view.action && has(view.action.step) ? view.action : null,
  };
}
