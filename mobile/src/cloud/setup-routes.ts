import type { Href } from "expo-router";
import type { SetupStepKey } from "./setup";

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
  agents: "/cloud/agent-logins",
  launch: "/cloud/launch",
} as const;

/** The page of a step, for the organization being set up; the organization step needs none. */
export function stepHref(step: SetupStepKey, orgId: string | null): Href {
  if (step === "organization" || !orgId) return SETUP_PATHS.organization as Href;
  return { pathname: SETUP_PATHS[step], params: { orgId } } as unknown as Href;
}
