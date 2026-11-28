import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ILinkHandler } from "@xterm/xterm";

export type TerminalLinkValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Strictly validate an xterm OSC 8 hyperlink URI.
 * Allows only `https:` and `http:` URLs without embedded credentials or control characters.
 */
export function validateTerminalLink(uri: string): TerminalLinkValidation {
  const trimmed = uri.trim();
  if (!trimmed) return { ok: false, reason: "Empty terminal link." };
  if (CONTROL_CHARS.test(trimmed)) return { ok: false, reason: "Terminal link contains control characters." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Malformed terminal link." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `Unsupported terminal link scheme: ${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Terminal links with embedded credentials are not allowed." };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: "Terminal link is missing a host." };
  }
  return { ok: true, url: parsed.href };
}

async function defaultConfirmTerminalLink(url: string): Promise<boolean> {
  const message = `Open this external link in your browser?\n\n${url}`;
  try {
    return await ask(message, {
      title: "Open terminal link",
      kind: "warning",
      okLabel: "Open link",
      cancelLabel: "Cancel",
    });
  } catch {
    return typeof window !== "undefined" && typeof window.confirm === "function"
      ? window.confirm(message)
      : false;
  }
}

export interface TerminalLinkHandlerOptions {
  confirm?: (url: string) => Promise<boolean> | boolean;
  open?: (url: string) => Promise<void> | void;
}

/**
 * Explicit xterm `ILinkHandler` replacing xterm's unsafe default `window.open()`
 * OSC 8 link activation with strict `http:`/`https:` validation, user confirmation
 * displaying the exact resolved destination URL, and Tauri's `openUrl()`.
 */
export function createTerminalLinkHandler(options: TerminalLinkHandlerOptions = {}): ILinkHandler {
  const confirm = options.confirm ?? defaultConfirmTerminalLink;
  const open = options.open ?? ((url: string) => openUrl(url));
  return {
    activate(_event, uri) {
      const checked = validateTerminalLink(uri);
      if (!checked.ok) return;
      void Promise.resolve(confirm(checked.url))
        .then((confirmed) => {
          if (confirmed) return open(checked.url);
        })
        .catch(() => {});
    },
  };
}
