import { openUrl } from "@tauri-apps/plugin-opener";

export interface OpenExternalWebUrlOptions {
  /** Allow `http:` in addition to `https:` (e.g. local previews in BrowserView). Defaults to false (`https:` only). */
  allowHttp?: boolean;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Strictly validate an external web URL before handing it to Tauri's `openUrl()`.
 * Enforces `https:` (or `http:` when `allowHttp` is true) and rejects control
 * characters, malformed URLs, missing hostnames, and embedded credentials.
 */
export function validateExternalWebUrl(raw: string, options: OpenExternalWebUrlOptions = {}): string | null {
  const trimmed = raw.trim();
  if (!trimmed || CONTROL_CHARS.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const protocolOk = options.allowHttp
    ? parsed.protocol === "https:" || parsed.protocol === "http:"
    : parsed.protocol === "https:";
  if (!protocolOk) return null;
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  return parsed.href;
}

/**
 * Open a validated external web URL in the OS default browser.
 * Refuses non-web schemes (`mailto:`, `tel:`, `file:`, `x-apple.systempreferences:`, etc.)
 * and credentialed URLs.
 */
export async function openExternalWebUrl(url: string, options?: OpenExternalWebUrlOptions): Promise<void> {
  const safe = validateExternalWebUrl(url, options);
  if (!safe) {
    throw new Error("Refused to open an invalid or non-HTTPS external URL.");
  }
  await openUrl(safe);
}
