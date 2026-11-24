import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";

let enabled = false;
let requested = false;
const listeners = new Set<() => void>();

export function organizationSwitchingEnabled() {
  return enabled;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useOrganizationSwitchingEnabled({ requestCapability = true } = {}) {
  useEffect(() => {
    if (!requestCapability || requested) return;
    requested = true;
    // The native Phase 2 rollout intentionally keeps production off. Only an
    // affirmative capability response enables the switcher and its shortcuts.
    void Promise.resolve().then(() => api.phase2DesktopContractsAvailable()).then((ready) => {
      if (ready !== true) return;
      enabled = true;
      for (const listener of listeners) listener();
    }).catch(() => {});
  }, [requestCapability]);
  return useSyncExternalStore(subscribe, organizationSwitchingEnabled, () => false);
}
