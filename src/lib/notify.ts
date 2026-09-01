import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getPrefs } from "@/lib/prefs";
import { getSessions, selectSession, subscribeSessions } from "@/lib/sessions";
import { sessionStatus, type SessionEntry, type TabEntry, type TabStatus } from "@/types/session";

/**
 * Attention, graded by where the reader is. A turn finishing or an agent
 * asking for a decision is: a desktop banner when another app has focus, an
 * in-app notice when the app is focused but a different session is showing,
 * and only the tone when the session is already on screen. The dock badge
 * counts sessions that want the reader back.
 */
export type NoticeKind = "done" | "waiting" | "failed";

export interface Notice {
  id: string;
  sessionId: string;
  tabId: string;
  kind: NoticeKind;
  title: string;
  body: string;
  at: number;
}

let notices: Notice[] = [];
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

export function useNotices(): Notice[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => notices,
    () => notices,
  );
}

export function dismissNotice(id: string) {
  notices = notices.filter((n) => n.id !== id);
  emit();
}

export function openNotice(n: Notice) {
  selectSession(n.sessionId);
  dismissNotice(n.id);
}

// ---- focus tracking

let focused = typeof document !== "undefined" ? document.hasFocus() : true;
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => (focused = true));
  window.addEventListener("blur", () => (focused = false));
}

// ---- sounds, synthesised so there is nothing to ship

let audio: AudioContext | null = null;
function tone(notes: { f: number; at: number; len: number }[], gain = 0.06) {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime;
    for (const n of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = n.f;
      g.gain.setValueAtTime(0, t0 + n.at);
      g.gain.linearRampToValueAtTime(gain, t0 + n.at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + n.at);
      o.stop(t0 + n.at + n.len + 0.05);
    }
  } catch {
    /* no audio device */
  }
}

export function playSound(kind: NoticeKind) {
  if (!getPrefs().sounds) return;
  if (kind === "done") tone([{ f: 1046.5, at: 0, len: 0.18 }, { f: 1318.5, at: 0.12, len: 0.28 }]);
  else if (kind === "waiting") tone([{ f: 880, at: 0, len: 0.16 }, { f: 880, at: 0.22, len: 0.24 }]);
  else tone([{ f: 440, at: 0, len: 0.3 }, { f: 349.2, at: 0.2, len: 0.4 }]);
}

// ---- desktop banners

let permission: boolean | null = null;
async function canNotify(): Promise<boolean> {
  if (permission != null) return permission;
  try {
    permission = await isPermissionGranted();
    if (!permission) permission = (await requestPermission()) === "granted";
  } catch {
    permission = false;
  }
  return permission;
}

function summarise(session: SessionEntry, tab: TabEntry, kind: NoticeKind): { title: string; body: string } {
  const agent = tab.title ?? getSessions().harnesses.find((h) => h.id === tab.harness)?.name ?? tab.harness;
  const title = kind === "waiting" ? `${agent} needs you` : kind === "failed" ? `${agent} hit a problem` : `${agent} finished`;
  return { title, body: session.title };
}

/** Called for every tab status change; decides what, if anything, to raise. */
export function noteStatusChange(session: SessionEntry, tab: TabEntry, prev: TabStatus, next: TabStatus) {
  let kind: NoticeKind | null = null;
  if (next === "waiting" && prev !== "waiting") kind = "waiting";
  else if (next === "completed" && prev === "in_progress") kind = "done";
  if (!kind) return;
  const { title, body } = summarise(session, tab, kind);
  const onScreen = focused && getSessions().selectedSessionId === session.id;
  if (!focused) {
    void canNotify().then((ok) => ok && sendNotification({ title, body }));
    return;
  }
  playSound(kind);
  if (onScreen) return;
  const id = `${session.id}:${tab.id}:${Date.now()}`;
  notices = [...notices.filter((n) => !(n.sessionId === session.id && n.tabId === tab.id)), { id, sessionId: session.id, tabId: tab.id, kind, title, body, at: Date.now() }];
  emit();
  window.setTimeout(() => dismissNotice(id), 8000);
}

// ---- dock badge

let lastBadge = -1;
function refreshBadge() {
  const n = getSessions().sessions.filter((s) => !s.archived && ["waiting", "completed"].includes(sessionStatus(s))).length;
  if (n === lastBadge) return;
  lastBadge = n;
  try {
    getCurrentWindow()
      .setBadgeCount(n > 0 ? n : undefined)
      .catch(() => {});
  } catch {
    /* not inside a webview */
  }
}

let started = false;
export function startNotifications() {
  if (started) return;
  started = true;
  subscribeSessions(refreshBadge);
  refreshBadge();
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
