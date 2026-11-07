import { useSyncExternalStore } from "react";

const KEY = "terminalx.intro.v1";
export const INTRO_STEPS = 3;
interface IntroProgress { step: number; completed: boolean }

function read(): IntroProgress {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved.completed === "boolean" && Number.isInteger(saved.step) && saved.step >= 0 && saved.step < INTRO_STEPS) return saved;
  } catch { /* A damaged record starts the tour again. */ }
  return { step: 0, completed: false };
}
let progress = read();
// Replaying never clears completion: quitting a replay must not restore first-run onboarding.
let replay = false;
let snapshot = { ...progress, visible: !progress.completed };
const listeners = new Set<() => void>();
function publish() {
  snapshot = { ...progress, visible: replay || !progress.completed };
  for (const listener of listeners) listener();
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(progress)); } catch { /* Keep this launch usable if storage is unavailable. */ }
  publish();
}
export function replayIntro() { replay = true; progress = { ...progress, step: 0 }; publish(); }
export function finishIntro() { replay = false; progress = { ...progress, completed: true }; save(); }
export function advanceIntro() {
  if (progress.step === INTRO_STEPS - 1) finishIntro();
  else { progress = { ...progress, step: progress.step + 1 }; save(); }
}
export function previousIntro() { progress = { ...progress, step: Math.max(0, progress.step - 1) }; save(); }
export function useIntro() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot); }
window.addEventListener("storage", (event) => {
  if (event.key !== KEY) return;
  progress = read();
  if (progress.completed) replay = false;
  publish();
});
