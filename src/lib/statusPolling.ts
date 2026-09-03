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
