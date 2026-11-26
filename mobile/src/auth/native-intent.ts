import { isAuthCallbackUrl } from "./protocol";

/**
 * Where a link that opened the app goes. Android hands the sign-in callback back as an ordinary link
 * (iOS keeps it inside the sign-in sheet): it is no page to open, so the app stays where it is and the
 * sign-in finishes from the link itself. Every other link opens as it always has.
 */
export function systemPathFor(path: string): string | null {
  return isAuthCallbackUrl(path) ? null : path;
}
