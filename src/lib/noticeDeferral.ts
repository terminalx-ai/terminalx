import { useLayoutEffect } from "react";

// Window-local: only decisions visible in this window defer its in-app notices.
const decisions = new Set<symbol>();
const listeners = new Set<() => void>();

export const noticesDeferred = () => decisions.size > 0;

export function subscribeNoticeDeferral(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Keep notices until every visible decision has closed, without moving focus. */
export function useNoticeDeferral(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const decision = Symbol();
    decisions.add(decision);
    if (decisions.size === 1) for (const listener of listeners) listener();
    return () => {
      decisions.delete(decision);
      if (!decisions.size) for (const listener of listeners) listener();
    };
  }, [active]);
}
