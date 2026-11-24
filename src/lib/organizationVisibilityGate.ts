import { useSyncExternalStore } from "react";
import { getAccount, subscribeAccount } from "@/lib/account";
import { privacyEnabled, subscribeDataPrivacy } from "@/lib/dataPrivacy";
import { phase2Ready } from "@/lib/phase2Readiness";

export function organizationSwitchingEnabled() {
  if (privacyEnabled()) return false;
  const { status } = getAccount();
  // Use the same account-wide events readiness as the native Phase 2 probe.
  return Object.keys(status.phase2Readiness ?? {}).some((orgId) => phase2Ready(status, orgId, "events"));
}

function subscribe(listener: () => void) {
  const unsubscribeAccount = subscribeAccount(listener);
  const unsubscribePrivacy = subscribeDataPrivacy(listener);
  return () => {
    unsubscribeAccount();
    unsubscribePrivacy();
  };
}

export function useOrganizationSwitchingEnabled() {
  return useSyncExternalStore(subscribe, organizationSwitchingEnabled, () => false);
}
