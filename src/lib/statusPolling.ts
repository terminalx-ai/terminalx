import { useEffect } from "react";

/** Process sampling exists only for the lifetime of the open popover. */
export function useResourceSampling(open: boolean, sample: () => void | Promise<void>) {
  useEffect(() => {
    if (!open) return;
    void sample();
    const timer = window.setInterval(() => void sample(), 2_000);
    return () => window.clearInterval(timer);
  }, [open, sample]);
}

/** The one periodic usage timer. Each tick waits for its refresh to settle
 * before arming the next, so a slow request is never overlapped and a machine
 * waking from sleep gets a single late tick rather than every missed one. A
 * changed interval re-arms from the last tick: shortening it can fire at once,
 * and no second timer is ever left running. `null` turns the timer off.
 */
export function createUsagePolling(refresh: () => void | Promise<void>) {
  let timer: number | undefined;
  let interval: number | null = null;
  let last = Date.now();
  let disposed = false;
  const arm = () => {
    window.clearTimeout(timer);
    timer = undefined;
    if (disposed || interval == null) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      void Promise.resolve().then(refresh).catch(() => {}).finally(() => {
        last = Date.now();
        // Turned off or changed mid-request: that update already re-armed.
        if (timer === undefined) arm();
      });
    }, Math.max(0, Math.min(last + interval - Date.now(), 2_147_483_647)));
  };
  return {
    update(next: number | null) {
      if (next === interval) return;
      interval = next;
      arm();
    },
    dispose() {
      disposed = true;
      window.clearTimeout(timer);
    },
  };
}

/** The backend budgets reset attempts and supplies the next eligible deadline.
 * Consume each deadline once, even if hidden or transport fails; activation
 * revalidates separately. A response with the next deadline rearms the timer.
 */
export function createUsageRevalidation(refresh: () => void | Promise<void>) {
  let timer: number | undefined;
  let consumed: string | undefined;
  let scheduled: string | undefined;
  return {
    update(account: string | null | undefined, at: number | null | undefined) {
      const key = at == null ? undefined : `${account ?? "system"}:${at}`;
      if (key === scheduled) return;
      window.clearTimeout(timer);
      scheduled = key;
      if (at == null || key === consumed) return;
      timer = window.setTimeout(() => {
        consumed = key;
        scheduled = undefined;
        void refresh();
      }, Math.max(0, Math.min(at - Date.now(), 2_147_483_647)));
    },
    dispose() { window.clearTimeout(timer); },
  };
}
