import { useEffect, useState } from "react";
import { api, type AccountStatus, type DesktopAnnouncement } from "@/lib/api";
import { phase2Ready } from "@/lib/phase2Readiness";

/**
 * The sidebar's announcement card (PRO-241): the active organization's current announcement, asked for again every
 * hour while its readiness key is on. Closing it hides it on this device; NEW shows the first time it is seen here.
 */
export const ANNOUNCEMENT_REFRESH_MS = 60 * 60 * 1000;
const KEY = "raccoon.announcements";
const KEEP = 50;

interface Record { dismissed: string[]; seen: string[] }

function read(): Record {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const ids = (list: unknown) => Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
    return { dismissed: ids(value?.dismissed), seen: ids(value?.seen) };
  } catch {
    return { dismissed: [], seen: [] };
  }
}

function write(record: Record) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ dismissed: record.dismissed.slice(-KEEP), seen: record.seen.slice(-KEEP) }));
  } catch { /* Storage may be unavailable: it shows again next time. */ }
}

/** The organization to ask, or none: signed in, data privacy off, and the key on there. */
export function announcementOrg(status: AccountStatus, privacy: { ready: boolean; enabled: boolean }): string | null {
  const org = status.identity?.organizationId;
  return org && privacy.ready && !privacy.enabled && phase2Ready(status, org, "announcements") ? org : null;
}

export interface ShownAnnouncement extends DesktopAnnouncement {
  /** Shown with NEW: flagged new, and not seen on this device before. */
  badge: boolean;
}

export function useAnnouncement(org: string | null): { announcement: ShownAnnouncement | null; dismiss: () => void } {
  const [announcement, setAnnouncement] = useState<ShownAnnouncement | null>(null);
  useEffect(() => {
    setAnnouncement(null);
    if (!org) return;
    let live = true;
    const load = () => {
      void api.announcementsCurrent(org).then(({ announcement: next }) => {
        if (!live) return;
        const record = read();
        if (!next || record.dismissed.includes(next.id)) return setAnnouncement(null);
        setAnnouncement((current) => current?.id === next.id
          ? { ...next, badge: current.badge }
          : { ...next, badge: next.isNew && !record.seen.includes(next.id) });
        if (!record.seen.includes(next.id)) write({ ...record, seen: [...record.seen, next.id] });
      }).catch(() => {
        // Unavailable or offline: keep what is shown; the next hour asks again.
      });
    };
    load();
    const timer = window.setInterval(load, ANNOUNCEMENT_REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [org]);
  const dismiss = () => {
    if (!announcement) return;
    const record = read();
    write({ ...record, dismissed: [...record.dismissed.filter((id) => id !== announcement.id), announcement.id] });
    setAnnouncement(null);
  };
  return { announcement, dismiss };
}
