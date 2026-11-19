/**
 * Setting links from other apps (PRO-127): `terminalx://settings/<row-id>[?enable=1]`.
 * The native side checks the link's shape and hands the webview only
 * `{ id, enable }`, never the URL; it comes through the one link router
 * (`desktopLinks.ts`) with every other `terminalx://` route.
 */
import { useSyncExternalStore } from "react";
import { settingById, type SettingId } from "@/components/settings/settingsRegistry";
import { enableSetting } from "@/lib/settingsLinks";
import { SETTING_TOAST_MS, showSettingEnabled, showSettingNotLinkable } from "@/lib/settingsToasts";

/** A setting link as the native side validated it. */
export interface SettingDeepLink {
  id: string;
  enable: boolean;
}

/** Where a followed link opens Settings: at a row, or at its default page (null). */
export type OpenSettingsAt = (row: SettingId | null) => void;

/**
 * Follow a link: open Settings at its row and, with `enable`, turn the row on
 * only when enableSetting says it is linkable, with a toast either way. An id
 * that is no row opens Settings at its default page, changes nothing, and
 * says no setting matches.
 */
export async function followSettingDeepLink(link: SettingDeepLink, open: OpenSettingsAt): Promise<void> {
  const row = settingById(link.id);
  if (!row) {
    open(null);
    showUnknownSettingLink();
    return;
  }
  open(row.id as SettingId);
  if (!link.enable) return;
  let result: Awaited<ReturnType<typeof enableSetting>>;
  try {
    result = await enableSetting(row.id);
  } catch (error) {
    console.error("turn on a setting from a link", error);
    return;
  }
  if (result === "enabled") showSettingEnabled(row.id, row.title);
  else if (result === "not-linkable") showSettingNotLinkable(row.id, row.title);
}

// ---- "No setting matches that link": a link named a row this app has not got.

export const UNKNOWN_SETTING_LINK_MESSAGE = "No setting matches that link";

export interface UnknownSettingLinkNotice {
  id: number;
  message: string;
}

let notice: UnknownSettingLinkNotice | null = null;
let nextNotice = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

/** Show the notice, in place of one already showing; it goes by itself like the other setting toasts. */
export function showUnknownSettingLink(): UnknownSettingLinkNotice {
  if (timer) clearTimeout(timer);
  const shown: UnknownSettingLinkNotice = { id: nextNotice++, message: UNKNOWN_SETTING_LINK_MESSAGE };
  notice = shown;
  timer = setTimeout(() => dismissUnknownSettingLink(shown.id), SETTING_TOAST_MS);
  emit();
  return shown;
}

export function dismissUnknownSettingLink(id?: number): void {
  if (!notice || (id !== undefined && notice.id !== id)) return;
  if (timer) clearTimeout(timer);
  timer = undefined;
  notice = null;
  emit();
}

export function getUnknownSettingLink(): UnknownSettingLinkNotice | null {
  return notice;
}

export function useUnknownSettingLink(): UnknownSettingLinkNotice | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => notice, () => notice);
}
