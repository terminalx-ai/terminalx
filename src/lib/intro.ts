import { useSyncExternalStore } from "react";
import type { AccountStatus } from "@/lib/api";
import { getPrefs, setPrefs, type Prefs } from "@/lib/prefs";

/**
 * The first-run intro (PRO-241, 01.02 and 01.14–01.16): three slides and a last "Ready when you are" step, beside the
 * sign-in panel. It shows once, on a first run while signed out, and comes back at the slide it was on after a quit.
 * Signing in, or Continue without an account, ends it for good; Help › Show intro opens it again at the first slide.
 * Everything here waits behind its key, off by default.
 */
export const INTRO_KEY = "desktop.intro-slides.v1";
/** Slides 0–2, then the last step. */
export const INTRO_LAST_STEP = 3;

/** Open in this window: once shown it stays until it ends, even while the account it waited on signs in. */
let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A first run: its switch on, never ended, and the account known to be signed out. */
export function introDue(prefs: Pick<Prefs, "introSlides" | "introDone">, account: { ready: boolean; status: Pick<AccountStatus, "state"> }): boolean {
  return prefs.introSlides && !prefs.introDone && account.ready && account.status.state === "signed-out";
}

export function useIntroOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

/** The screen is up: keep it up until it ends. */
export function holdIntro(): void {
  if (open) return;
  open = true;
  emit();
}

/** Help › Show intro: again, from the first slide. */
export function showIntro(): void {
  if (!getPrefs().introSlides) return;
  setPrefs({ introStep: 0 });
  holdIntro();
}

export function setIntroStep(step: number): void {
  setPrefs({ introStep: Math.max(0, Math.min(INTRO_LAST_STEP, Math.round(step))) });
}

/** Signed in, or Continue: never again on its own. */
export function finishIntro(): void {
  setPrefs({ introDone: true, introStep: 0 });
  open = false;
  emit();
}

/** Tests only. */
export function resetIntroForTests(): void {
  open = false;
  emit();
}
