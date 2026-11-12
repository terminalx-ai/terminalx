/** Why PR info could not load, for the panel's own states. */
export type PrErrorKind = "access" | "offline" | "timeout";

const TAG = /^\[pr-error:(access|offline|timeout)\]\s*/;

/** The kind Rust tagged the error with, else judged from the text; null when it is none of the three. */
export function prErrorKind(details: string): PrErrorKind | null {
  const tagged = TAG.exec(details);
  if (tagged) return tagged[1] as PrErrorKind;
  if (/did not answer|timed out|deadline exceeded/i.test(details)) return "timeout";
  if (/error connecting to|could not resolve host|no such host|network is unreachable|dial tcp|you are offline/i.test(details)) return "offline";
  if (/http (401|403|404)|bad credentials|not logged in|gh auth login|resource not accessible|could not resolve to a repository/i.test(details)) return "access";
  return null;
}

/** The error text without its kind tag, for the details. */
export const prErrorDetails = (details: string) => details.replace(TAG, "");
