/**
 * How long a cloud workspace may sit idle before it stops itself (PRO-410),
 * in words. `0` is never: it keeps running, and billing, until someone stops
 * it. Everything else is minutes without activity; a running agent turn or a
 * pending approval is activity, so a workspace with an agent working stays up.
 */

/** The choice's name in a picker: "Never", "15 minutes", "1 hour". */
export function idleSuspendLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** The sentence a price ends with. */
export function idleSuspendSentence(minutes: number): string {
  return minutes === 0 ? "It keeps running until you stop it." : `It stops itself after ${minutes} idle ${minutes === 1 ? "minute" : "minutes"}.`;
}

/**
 * The choices in the order they are offered: the windows shortest first,
 * then Never. Anything but a whole number of minutes from 0 up is dropped,
 * and so are repeats.
 */
export function idleSuspendChoices(allowed: readonly number[]): number[] {
  const valid = [...new Set(allowed)].filter((minutes) => Number.isSafeInteger(minutes) && minutes >= 0);
  return [...valid.filter((minutes) => minutes > 0).sort((a, b) => a - b), ...valid.filter((minutes) => minutes === 0)];
}

/**
 * Why Never is missing, when the organization caps idle time; null when it
 * does not, or when Never is offered anyway.
 */
export function idleSuspendCapNote(cap: number | null | undefined, choices: readonly number[]): string | null {
  if (cap === null || cap === undefined || choices.includes(0)) return null;
  return `Your organization stops idle workspaces after at most ${idleSuspendLabel(cap)}, so Never is not offered.`;
}

/**
 * The window a form starts on: the one already chosen while it is still
 * offered, else the provider's default while that is, else the shortest one
 * offered. Null when nothing is offered.
 */
export function initialIdleSuspend(choices: readonly number[], fallback: number, chosen: number | null = null): number | null {
  if (chosen !== null && choices.includes(chosen)) return chosen;
  if (choices.includes(fallback)) return fallback;
  return choices[0] ?? null;
}
