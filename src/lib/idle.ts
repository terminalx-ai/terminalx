/**
 * Schedule non-critical startup or background work when the browser is idle,
 * falling back to a short timeout where `requestIdleCallback` is unavailable
 * (e.g., WebKit / older Safari). Returns a cancel function.
 */
export function scheduleIdle(task: () => void, timeout = 1500): () => void {
  if (typeof window === "undefined") {
    task();
    return () => {};
  }
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof win.requestIdleCallback === "function") {
    const id = win.requestIdleCallback(() => task(), { timeout });
    return () => win.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(task, 50);
  return () => window.clearTimeout(id);
}
