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
