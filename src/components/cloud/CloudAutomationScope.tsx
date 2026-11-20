import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { getAccount, subscribeAccount } from "@/lib/account";
import { getDataPrivacy, subscribeDataPrivacy } from "@/lib/dataPrivacy";

// Observe each authority transition, including A → B → A in one React batch.
// Ignore unrelated account busy/refresh notifications so a pending refresh
// does not discard a draft when its authority has stayed the same.
let generation = 0;
// Retire old callbacks immediately, even before React commits a batched target switch.
export function retireAutomationTargetScope() { generation += 1; }
function fingerprint(): string {
  const { status } = getAccount();
  return JSON.stringify([status.state, status.context, status.identity, status.organizations, status.multiOrg, getDataPrivacy()]);
}
let observed: string | null = null;
export function automationScopeStamp(): string {
  const current = fingerprint();
  if (current !== observed) { observed = current; generation += 1; }
  return JSON.stringify([generation, current]);
}
const subscribe = (notify: () => void) => {
  const changed = () => { automationScopeStamp(); notify(); };
  const account = subscribeAccount(changed);
  const privacy = subscribeDataPrivacy(changed);
  return () => { account(); privacy(); };
};
export function useAutomationScope() {
  const stamp = useSyncExternalStore(subscribe, automationScopeStamp, automationScopeStamp);
  const { status } = getAccount();
  const privacy = getDataPrivacy();
  return { stamp, allowed: status.state === "signed-in" && privacy.ready && !privacy.enabled };
}

/** Capture before each request; check after every await and before follow-up work. */
export function useAutomationFence() {
  const alive = useRef(true);
  const origin = useRef(automationScopeStamp());
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return useCallback(() => {
    const stamp = origin.current;
    return () => alive.current && stamp === automationScopeStamp();
  }, []);
}
