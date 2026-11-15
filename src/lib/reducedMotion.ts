import { useSyncExternalStore } from "react";

/**
 * Whether the system asks for reduced motion (`prefers-reduced-motion: reduce`).
 *
 * This is what stills progress signs (the working mark, a running piece's mark,
 * the Working bars) and sidebar motion (section folds, drags). The Pixel raccoon
 * preference does not: it hides the mascot only.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  // A test's DOM may have no matchMedia at all; that reads as "motion is fine".
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const mq = media();
  if (!mq?.addEventListener) return () => {};
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
