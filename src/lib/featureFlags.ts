import { useSyncExternalStore } from "react";
import type { AccountStatus } from "@/lib/api";
import { getAccount, subscribeAccount } from "@/lib/account";
import { useDataPrivacy } from "@/lib/dataPrivacy";

/** Add a key on the server and a rollout checklist before adding a new team surface. */
export const featureFlags = {
  teamEvents: "team.events.v1",
  teamRoster: "team.roster.v1",
  organizationSetup: "organization.setup-flow.v1",
  privacyControls: "organization.privacy-controls.v1",
} as const;

export type FeatureFlag = (typeof featureFlags)[keyof typeof featureFlags];
const knownFlags = new Set<string>(Object.values(featureFlags));

/** Flags control availability, never permission. Always check the feature's existing role/access rules too. */
export function featureFlagEnabled(status: AccountStatus, flag: FeatureFlag, organizationId?: string | null): boolean {
  if (status.state !== "signed-in" || !knownFlags.has(flag)) return false;
  // An explicit null means no organization; only an omitted argument follows the active one.
  const orgId = organizationId === undefined ? status.identity?.organizationId : organizationId;
  if (!orgId) return false;
  return status.organizations?.find((org) => org.id === orgId)?.cloud?.flags[flag] === true;
}

/** Shares the account's capability refresh and invalidates mounted surfaces without restarting. */
export function useFeatureFlag(flag: FeatureFlag, organizationId?: string | null): boolean {
  const privacy = useDataPrivacy();
  const enabled = useSyncExternalStore(
    subscribeAccount,
    () => featureFlagEnabled(getAccount().status, flag, organizationId),
    () => false,
  );
  return enabled && !privacy.enabled;
}
