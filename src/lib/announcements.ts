import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getAccount, subscribeAccount } from "@/lib/account";
import { bootDataPrivacy, getDataPrivacy, subscribeDataPrivacy } from "@/lib/dataPrivacy";

export interface Announcement {
  id: string;
  title: string;
  body: string;
  link: string;
  isNew: boolean;
  requiredFlag?: string;
}
const KEY = "terminalx.announcements.v1";
export const ANNOUNCEMENT_INTERVAL_MS = 60 * 60 * 1000;
interface Receipts { seen: string[]; dismissed: string[]; lastSeen: { id: string; at: string } | null }
function readReceipts(): Receipts {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && Array.isArray(value.seen) && value.seen.every((id: unknown) => typeof id === "string") && Array.isArray(value.dismissed) && value.dismissed.every((id: unknown) => typeof id === "string")) return value;
  } catch { /* A damaged receipt must not prevent future announcements. */ }
  return { seen: [], dismissed: [], lastSeen: null };
}
let receipts = readReceipts();
let current: Announcement | null = null;
let snapshot: Announcement | null = null;
const listeners = new Set<() => void>();

function allowed() { const privacy = getDataPrivacy(); return privacy.ready && !privacy.enabled; }
function eligible(announcement: Announcement) {
  if (!announcement.requiredFlag) return true;
  const account = getAccount().status;
  if (account.state !== "signed-in") return false;
  const organization = account.organizations?.find((org) => org.id === account.identity?.organizationId);
  return organization?.cloud?.flags[announcement.requiredFlag] === true;
}
function publish() {
  snapshot = current && allowed() && eligible(current) && !receipts.dismissed.includes(current.id)
    ? { ...current, isNew: current.isNew && !receipts.seen.includes(current.id) } : null;
  for (const listener of listeners) listener();
}
export function parseAnnouncement(value: unknown): Announcement | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id || item.id.length > 128 ||
      typeof item.title !== "string" || !item.title || item.title.length > 160 ||
      typeof item.body !== "string" || !item.body || item.body.length > 2000 ||
      typeof item.link !== "string" || typeof item.isNew !== "boolean" ||
      (item.requiredFlag !== undefined && (typeof item.requiredFlag !== "string" || !item.requiredFlag))) return null;
  try { const link = new URL(item.link); if (link.protocol !== "https:" || link.username || link.password) return null; } catch { return null; }
  return { id: item.id, title: item.title, body: item.body, link: item.link, isNew: item.isNew, ...(typeof item.requiredFlag === "string" ? { requiredFlag: item.requiredFlag } : {}) };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(receipts)); } catch { /* In-memory receipts still apply this launch. */ }
  publish();
}
export function markAnnouncementSeen(id: string) {
  if (!receipts.seen.includes(id)) receipts.seen.push(id);
  receipts.lastSeen = { id, at: new Date().toISOString() };
  save();
}
export function dismissAnnouncement(id: string) {
  if (!receipts.dismissed.includes(id)) receipts.dismissed.push(id);
  markAnnouncementSeen(id);
}
export function useAnnouncement() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}
window.addEventListener("storage", (event) => { if (event.key === KEY) { receipts = readReceipts(); publish(); } });

/** One owner in AppShell, independent of whether the sidebar is visible. */
export function startAnnouncementChecks() {
  let stopped = false;
  let generation = 0;
  let busy = false;
  let lastAttempt = -Infinity;
  let wasAllowed = false;
  const refresh = async () => {
    if (stopped || !allowed() || busy) return;
    busy = true;
    lastAttempt = Date.now();
    const asked = ++generation;
    try {
      const appVersion = await getVersion();
      if (stopped || asked !== generation || !allowed()) return;
      const result = await invoke<unknown>("announcements_current", { appVersion });
      if (stopped || asked !== generation || !allowed()) return;
      current = parseAnnouncement(result);
      publish();
    } catch { /* Offline and older servers are quiet; retry on the next interval. */ }
    finally { if (asked === generation) busy = false; }
  };
  const privacyChanged = () => {
    const enabled = allowed();
    if (!enabled) { ++generation; busy = false; current = null; }
    const resumed = enabled && !wasAllowed;
    wasAllowed = enabled;
    publish();
    if (resumed) void refresh();
  };
  const unsubscribePrivacy = subscribeDataPrivacy(privacyChanged);
  const unsubscribeAccount = subscribeAccount(publish);
  privacyChanged();
  void bootDataPrivacy();
  const timer = window.setInterval(() => void refresh(), ANNOUNCEMENT_INTERVAL_MS);
  const wake = () => { if (Date.now() - lastAttempt >= ANNOUNCEMENT_INTERVAL_MS) void refresh(); };
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  return () => {
    stopped = true; ++generation;
    clearInterval(timer); unsubscribePrivacy(); unsubscribeAccount();
    window.removeEventListener("focus", wake); window.removeEventListener("online", wake);
  };
}
