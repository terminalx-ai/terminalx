import { useSyncExternalStore } from "react";

/**
 * Toasts about setting links (PRO-127): a link was copied from a row's menu,
 * a link turned a setting on, or a link asked to turn on a setting that only
 * the reader can change in the app. Shown by SettingsLinkToasts beside the
 * other in-app notices.
 */
export type SettingToastKind = "copied" | "copy-failed" | "enabled" | "not-linkable";

export interface SettingToast {
  id: number;
  kind: SettingToastKind;
  /** The row the toast is about. */
  settingId: string;
  /** The row's title, as Settings shows it. */
  settingTitle: string;
  message: string;
}

/** How long a toast stays before it goes by itself. */
export const SETTING_TOAST_MS = 6000;

let toasts: SettingToast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of [...listeners]) listener();
}

function messageFor(kind: SettingToastKind, title: string): string {
  switch (kind) {
    case "copied": return `Copied a link to ${title}`;
    case "copy-failed": return `Couldn’t copy a link to ${title}`;
    case "enabled": return `Turned on ${title}`;
    case "not-linkable": return `That link can’t turn on ${title} from outside the app`;
  }
}

function show(kind: SettingToastKind, settingId: string, settingTitle: string): SettingToast {
  // One toast per row: a second copy or link replaces the first instead of stacking.
  for (const old of toasts.filter((toast) => toast.settingId === settingId)) dismissSettingToast(old.id, false);
  const toast: SettingToast = { id: nextId++, kind, settingId, settingTitle, message: messageFor(kind, settingTitle) };
  toasts = [...toasts, toast];
  timers.set(toast.id, setTimeout(() => dismissSettingToast(toast.id), SETTING_TOAST_MS));
  emit();
  return toast;
}

/** "Copied a link to <title>": the row menu's Copy setting link wrote the link to the clipboard. */
export function showSettingLinkCopied(settingId: string, settingTitle: string): SettingToast {
  return show("copied", settingId, settingTitle);
}

/** "Couldn’t copy a link to <title>": the clipboard refused the write. */
export function showSettingLinkCopyFailed(settingId: string, settingTitle: string): SettingToast {
  return show("copy-failed", settingId, settingTitle);
}

/** "Turned on <title>", with Open setting: a link with enable=1 turned a linkable row on. */
export function showSettingEnabled(settingId: string, settingTitle: string): SettingToast {
  return show("enabled", settingId, settingTitle);
}

/** "That link can’t turn on <title> from outside the app": the row is not on the linkable allowlist. */
export function showSettingNotLinkable(settingId: string, settingTitle: string): SettingToast {
  return show("not-linkable", settingId, settingTitle);
}

export function dismissSettingToast(id: number, notify = true): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  const before = toasts.length;
  toasts = toasts.filter((toast) => toast.id !== id);
  if (notify && toasts.length !== before) emit();
}

export function getSettingToasts(): readonly SettingToast[] {
  return toasts;
}

export function useSettingToasts(): readonly SettingToast[] {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => toasts, () => toasts);
}

/** For tests. */
export function forgetSettingToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts = [];
  emit();
}
