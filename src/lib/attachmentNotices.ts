import { useSyncExternalStore } from "react";
import { limitNotice, reservedNotice, tooLargeNotice, type Admission, type Offered } from "@/lib/attachmentRules";

/**
 * Why files offered to a message were not all attached (PRO-290, screen
 * 03.23), as toasts at the bottom right: the message was full ("Only the
 * first 10 files were attached"), or a file was refused for its name or its
 * size. Each stays until it is closed or `TIMEOUT_MS` passes; the line above
 * the draft keeps the counts meanwhile.
 */
export interface AttachmentNotice {
  id: string;
  /** "limit": the warning triangle. "refused": the destructive file-x. */
  kind: "limit" | "refused";
  title: string;
  body: string;
}

/** Long enough to read both lines; the composer's summary line says the same in short. */
export const TIMEOUT_MS = 15_000;
/** Ten refused names at once would cover the window: the oldest go first. */
const MAX_SHOWN = 4;

let notices: AttachmentNotice[] = [];
let next = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function publish(list: AttachmentNotice[]) {
  notices = list;
  for (const listener of listeners) listener();
}

/** Show a notice; one with the same title replaces it (the same file refused twice, a second over-full drop). */
export function showAttachmentNotice(notice: Omit<AttachmentNotice, "id">): string {
  const same = notices.find((n) => n.kind === notice.kind && n.title === notice.title);
  if (same) dropTimer(same.id);
  const id = `attachment-notice-${++next}`;
  const kept = notices.filter((n) => n !== same);
  const list = [...kept, { ...notice, id }];
  for (const old of list.slice(0, Math.max(0, list.length - MAX_SHOWN))) dropTimer(old.id);
  publish(list.slice(-MAX_SHOWN));
  timers.set(id, setTimeout(() => dismissAttachmentNotice(id), TIMEOUT_MS));
  return id;
}

export function dismissAttachmentNotice(id: string) {
  dropTimer(id);
  if (notices.some((n) => n.id === id)) publish(notices.filter((n) => n.id !== id));
}

function dropTimer(id: string) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

/**
 * The notices for one offer of files, from the rules' own sentences: the
 * limit notice when some were not added, and one for each refused file.
 */
export function announceAdmission<T extends Offered>(offered: number, admission: Admission<T>, verb: "dropped" | "pasted" | "picked") {
  if (admission.notAdded.length) showAttachmentNotice({ kind: "limit", ...limitNotice(offered, admission.notAdded.length, verb) });
  for (const { item, reason } of admission.refused) {
    showAttachmentNotice({ kind: "refused", ...(reason === "reserved" ? reservedNotice(item.name) : tooLargeNotice(item.name)) });
  }
}

export function useAttachmentNotices(): AttachmentNotice[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices,
    () => notices,
  );
}

/** For tests: nothing showing, no timers left. */
export function resetAttachmentNotices() {
  for (const id of [...timers.keys()]) dropTimer(id);
  publish([]);
}
