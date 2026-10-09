import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getPrefs } from "@/lib/prefs";
import { getSessions, selectSession, subscribeSessions } from "@/lib/sessions";
import { isUnread, sessionColumn } from "@/lib/dashboard";
import { createCloudAttentionTracker, getCloudDashboard, openCloudSession, subscribeCloudDashboard, type CloudAttention } from "@/lib/cloudDashboard";
import { isCloudKey } from "@/types/target";
import { appWindow, type AppWindow } from "@/lib/appWindow";
import { getFloating, showFloatingWindow, subscribeFloating } from "@/lib/floating";
import { sessionStatus, type SessionEntry, type TabEntry, type TabStatus } from "@/types/session";
import type { AutomationRun } from "@/types/automations";

/**
 * Attention, graded by where the reader is. A turn finishing or an agent
 * asking for a decision is: a desktop banner when another app has focus, an
 * in-app notice when the app is focused but a different session is showing,
 * and only the tone when the session is already on screen. The dock badge
 * counts sessions that want the reader back.
 *
 * The app has two windows and one reader. Every window hears every status
 * change, so each decides for itself and they must not both speak: the window
 * that has the focus raises the tone and the notice; when neither has it, the
 * main window alone sends the banner and keeps the dock badge. A banner about
 * the session the floating window shows brings that window back when the
 * reader returns to the app.
 */
export type NoticeKind = "done" | "waiting" | "failed";

export interface Notice {
  id: string;
  sessionId: string;
  tabId: string;
  kind: NoticeKind;
  /** The agent, for a session the local store does not hold (a cloud one). */
  harness?: string;
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
  // A cloud session opens on the tab that asked, and only looks: nothing wakes its workspace.
  if (isCloudKey(n.sessionId)) openCloudSession(n.sessionId, n.tabId);
  else selectSession(n.sessionId);
  dismissNotice(n.id);
}

// ---- focus tracking

let focused = typeof document !== "undefined" ? document.hasFocus() : true;

/**
 * Where the reader is, across windows. Each window writes whether it has the
 * focus and which session it shows; the other reads it. Local storage is the
 * one thing both pages share without a round trip, and it is how the
 * preferences already cross between them.
 */
interface Presence {
  focused: boolean;
  sessionId: string | null;
}
const presenceKey = (win: AppWindow) => `raccoon.presence.${win}`;
const otherWindow = (): AppWindow => (appWindow() === "main" ? "floating" : "main");

/** This window has the reader: the focus, and (for the floating one) it is on screen. A hidden floating window shows nothing to anyone, whatever its page thinks. */
function looking(): boolean {
  return focused && (appWindow() === "main" || getFloating().visible);
}

function publishPresence() {
  try {
    const presence: Presence = { focused: looking(), sessionId: getSessions().selectedSessionId };
    localStorage.setItem(presenceKey(appWindow()), JSON.stringify(presence));
  } catch {
    /* storage unavailable: each window then speaks for itself, as one window always did */
  }
}

function presenceElsewhere(): Presence | null {
  try {
    const raw = localStorage.getItem(presenceKey(otherWindow()));
    const parsed = raw ? (JSON.parse(raw) as Partial<Presence>) : null;
    return parsed ? { focused: parsed.focused === true, sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null } : null;
  } catch {
    return null;
  }
}

/**
 * A banner went out while nobody was looking. When the reader comes back to
 * the app it is for this: the floating window, if that is where the session
 * is shown, is brought up on it.
 */
let raised: { sessionId: string; tabId: string } | null = null;

function onReturn() {
  const wasAway = !looking() && !presenceElsewhere()?.focused;
  focused = true;
  publishPresence();
  const target = raised;
  raised = null;
  if (!wasAway || !target || appWindow() !== "main") return;
  // The reader came back to the main window and it already shows the session
  // (they sent it here with "Open in main window"): there is nothing to bring up.
  if (getSessions().selectedSessionId === target.sessionId) return;
  // Only a session the floating window has in this run of the app: what it
  // says about itself now, not what it showed some other day. The main
  // window's own sessions are where the reader left them, and are not
  // navigated for them.
  if (presenceElsewhere()?.sessionId === target.sessionId) void showFloatingWindow(target.sessionId, target.tabId).catch(() => {});
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", onReturn);
  window.addEventListener("blur", () => {
    focused = false;
    publishPresence();
  });
  // The reader came back through the other window: what was raised has been answered there.
  window.addEventListener("storage", (event) => {
    if (event.key === presenceKey(otherWindow()) && event.storageArea === localStorage && presenceElsewhere()?.focused) raised = null;
  });
}

/** Whether a banner is this window's to send: nobody is looking, and this is the main window. */
function sendsBanner(): boolean {
  return !looking() && !presenceElsewhere()?.focused && appWindow() === "main";
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

function summarise(_session: SessionEntry, tab: TabEntry, kind: NoticeKind): { title: string; body: string } {
  const agent = getSessions().harnesses.find((h) => h.id === tab.harness)?.name ?? "Agent";
  const status = kind === "waiting" ? `${agent} needs attention` : kind === "failed" ? `${agent} hit a problem` : `${agent} finished`;
  const title = `TerminalX — ${status}`;
  return { title, body: kind === "waiting" ? "Open the session to review its recovery actions or pending request." : "Open the session to review the conversation." };
}

/** Called for every tab status change; decides what, if anything, to raise. */
export function noteStatusChange(session: SessionEntry, tab: TabEntry, prev: TabStatus, next: TabStatus) {
  let kind: NoticeKind | null = null;
  if (next === "waiting" && prev !== "waiting") kind = "waiting";
  else if (next === "completed" && prev === "in_progress") kind = "done";
  if (!kind) return;
  const { title, body } = summarise(session, tab, kind);
  const onScreen = looking() && getSessions().selectedSessionId === session.id;
  if (!looking()) {
    // The other window has the reader, or this is not the window that sends banners.
    if (!sendsBanner()) return;
    raised = { sessionId: session.id, tabId: tab.id };
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

/** Automation failures use the same focus-aware path as agent attention. */
export function noteAutomationFailure(name: string, run: AutomationRun) {
  const title = `${name} failed`;
  const body = run.error ?? `Run ${run.runNumber} did not finish.`;
  if (!focused) {
    if (sendsBanner()) void canNotify().then((ok) => ok && sendNotification({ title, body }));
    return;
  }
  playSound("failed");
  if (!run.sessionId || !run.tabId || getSessions().selectedSessionId === run.sessionId) return;
  const id = `${run.sessionId}:${run.tabId}:${Date.now()}`;
  notices = [...notices.filter((notice) => !(notice.sessionId === run.sessionId && notice.tabId === run.tabId)), {
    id,
    sessionId: run.sessionId,
    tabId: run.tabId,
    kind: "failed",
    title,
    body,
    at: Date.now(),
  }];
  emit();
  window.setTimeout(() => dismissNotice(id), 8000);
}

// ---- cloud sessions (PRO-23 CS-19)

let observeCloud: ReturnType<typeof createCloudAttentionTracker> | null = null;

function agentLabel(harness: string): string {
  return getSessions().harnesses.find((h) => h.id === harness)?.name ?? (harness === "claude" ? "Claude" : harness === "codex" ? "Codex" : harness || "Agent");
}

/** Raise a cloud session's wait or finish: the same focus-aware path as a local tab's. */
export function raiseCloudAttention({ kind, session, tab }: CloudAttention) {
  const agent = agentLabel(tab.harness);
  const title = `TerminalX — ${kind === "waiting" ? `${agent} needs attention` : kind === "failed" ? `${agent} hit a problem` : `${agent} finished`}`;
  const where = `${session.title} · ${session.orgName} cloud`;
  const body = kind === "waiting" ? `${where}. Open the session to review its pending request.` : kind === "failed" ? `${where}. Open the session to review its recovery actions.` : `${where}. Open the session to review the conversation.`;
  if (!focused) {
    if (sendsBanner()) void canNotify().then((ok) => ok && sendNotification({ title, body }));
    return;
  }
  playSound(kind);
  if (getSessions().selectedSessionId === session.key) return;
  const id = `${session.key}:${tab.tabId}:${Date.now()}`;
  notices = [...notices.filter((n) => !(n.sessionId === session.key && n.tabId === tab.tabId)), { id, sessionId: session.key, tabId: tab.tabId, kind, harness: tab.harness, title, body, at: Date.now() }];
  emit();
  window.setTimeout(() => dismissNotice(id), 8000);
}

function onCloudSessions() {
  // Attention and badge counts deliberately use ALL live organizations, never the sidebar visibility projection.
  observeCloud ??= createCloudAttentionTracker();
  for (const event of observeCloud(getCloudDashboard())) raiseCloudAttention(event);
}

// ---- dock badge

let lastBadge = -1;
function refreshBadge() {
  // One badge for the app, kept by the main window: two windows counting
  // would only race each other to write the same number.
  if (appWindow() !== "main") return;
  const local = getSessions().sessions.filter((s) => !s.archived && ["waiting", "completed"].includes(sessionStatus(s))).length;
  // Cloud sessions that want the reader back: waiting, or finished and unread.
  const cloud = getCloudDashboard().filter((s) => !s.archived && s.tabs.length > 0 && (sessionColumn(s) === "needs" || isUnread(s))).length;
  const n = local + cloud;
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
  // The session on screen is part of where the reader is.
  let shown = getSessions().selectedSessionId;
  publishPresence();
  subscribeSessions(() => {
    const now = getSessions().selectedSessionId;
    if (now === shown) return;
    shown = now;
    publishPresence();
  });
  subscribeFloating(publishPresence);
  // Cloud sessions and the badge are the main window's: the floating window shows neither.
  if (appWindow() !== "main") return;
  // The floating window is made by this run of the app. What an earlier run
  // left written for it is not a window that has the reader now.
  try {
    localStorage.removeItem(presenceKey("floating"));
  } catch {
    /* storage unavailable */
  }
  subscribeSessions(refreshBadge);
  subscribeCloudDashboard(() => {
    onCloudSessions();
    refreshBadge();
  });
  onCloudSessions();
  refreshBadge();
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
