import { useSyncExternalStore } from "react";
import { getIdentifier } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BellSlash, X } from "@/icons";
import { Button } from "@/components/ui/button";

/**
 * "Notifications are off for TerminalX" (PRO-327). A session needs the reader
 * and macOS blocks the app's banners and dock badge, so the reader is told
 * here instead, with the way to turn them back on.
 *
 * What is shown lives here; when to show it is `@/lib/notify`'s to decide: it
 * raises the card when a waiting session finds notifications off, and clears
 * it when they are allowed again. "Not now" hides it for the rest of this run
 * of the app, never for good.
 */
export interface NotificationsOff {
  sessionId: string;
  sessionTitle: string;
}

let shown: NotificationsOff | null = null;
let hiddenForRun = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function showNotificationsOff(next: NotificationsOff) {
  if (hiddenForRun) return;
  shown = next;
  emit();
}

export function clearNotificationsOff() {
  if (!shown) return;
  shown = null;
  emit();
}

/** "Not now": nothing more about it until the app is started again. */
export function hideNotificationsOffForRun() {
  hiddenForRun = true;
  clearNotificationsOff();
}

export const notificationsOffHidden = () => hiddenForRun;

export function resetNotificationsOffForTest() {
  shown = null;
  hiddenForRun = false;
  emit();
}

export function useNotificationsOff(): NotificationsOff | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
    () => shown,
  );
}

/** The app's own page under System Settings › Notifications. */
export async function openNotificationSettings() {
  let id = "";
  try {
    id = await getIdentifier();
  } catch {
    /* not inside the app: the Notifications pane without the app selected */
  }
  await openUrl(`x-apple.systempreferences:com.apple.Notifications-Settings.extension${typeof id === "string" && id ? `?id=${encodeURIComponent(id)}` : ""}`).catch(() => {});
}

export function NotificationsOffCard() {
  const off = useNotificationsOff();
  if (!off) return null;
  const title = off.sessionTitle.trim() || "A session";
  return (
    <div
      role="alert"
      data-notifications-off
      className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover p-3 text-sm shadow-surface hairline animate-fade-in"
    >
      <BellSlash className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Notifications are off for TerminalX</div>
        <div className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          “{title}” needs your approval, but macOS blocks TerminalX banners and the dock badge.
        </div>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="border" onClick={() => void openNotificationSettings()}>
            Open System Settings
          </Button>
          <Button variant="ghost" size="sm" onClick={hideNotificationsOffForRun}>
            Not now
          </Button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={clearNotificationsOff}
        className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
