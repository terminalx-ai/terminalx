/** Why PR info could not load, for the panel's own states. */
export type PrErrorKind = "access" | "offline" | "timeout";

/**
 * Judged from the text `gh` (or the process runner) gave, so the backend's
 * errors stay as they are for every other screen. Null when it is none of the three.
 */
export function prErrorKind(details: string): PrErrorKind | null {
  if (/did not answer|timed out|deadline exceeded/i.test(details)) return "timeout";
  if (/error connecting to|could not resolve host|no such host|network is unreachable|dial tcp|connection refused|you are offline/i.test(details)) return "offline";
  if (/http (401|403|404)|bad credentials|not logged in|gh auth login|authentication required|resource not accessible|could not resolve to a repository|saml enforcement/i.test(details)) return "access";
  return null;
}
