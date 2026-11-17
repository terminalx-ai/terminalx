import { deliveryOn, followedSessions, isNotificationKind, sessionOverride, type NotificationKind, type NotificationSettings, type QuietHours } from "./model";

/** A notification as the Mac sends it (#990 wire contract); `kind` and the rest are absent from older Macs. */
export interface HostNotification {
  seq: number;
  epoch: string;
  title: string;
  body: string;
  sessionId?: string;
  tabId?: string;
  /** A known kind, or another string from a newer Mac (shown, as an unknown kind). */
  kind?: string;
  sessionTitle?: string;
  question?: { requestId: string; options: { label: string }[] };
  approval?: { requestId: string };
}

/** What `notifications.subscribe` and `notifications.missedSince` take as `filter` from a Mac with `notificationFilters`. */
export interface SubscribeFilter {
  kinds: NotificationKind[];
  sessions: { scope: "all" } | { scope: "only"; ids: string[] };
  overrides: Record<string, "needsMe" | "everything" | "mute">;
}

/** What to show for a notification the phone lets through. */
export interface NotificationPresentation {
  title: string;
  body: string;
  /**
   * The machine's name, only when the lock screen shows everything. iOS heads
   * each notification with the app's name already, so 22.07's
   * "TerminalX · Studio MacBook" reads as that heading and this line.
   */
  subtitle?: string;
  /** iOS groups by this: one stack per session (per Mac when none is named), as 22.07 draws them, not one for the app. */
  thread: string;
  sound: boolean;
  /** Read when the notification is tapped or answered: `_layout.tsx` opens `sessionId`/`tabId`. */
  data: {
    hostId: string;
    sessionId: string;
    tabId: string;
    kind: string;
    /** Details are hidden: no answer buttons (#990, lock screen "Nothing"). */
    detailsHidden: boolean;
    requestId?: string;
    options?: { label: string }[];
  };
}

/** Each Mac's subscribe filter: what the phone asks it to send. Quiet hours and the lock screen stay on the phone. */
export function subscribeFilter(settings: NotificationSettings, hostId: string): SubscribeFilter {
  const kinds = (Object.keys(settings.kinds) as NotificationKind[]).filter((kind) => settings.kinds[kind]);
  const overrides: SubscribeFilter["overrides"] = { ...(settings.perSession[hostId] ?? {}) };
  return {
    kinds,
    sessions: settings.sessions === "all" ? { scope: "all" } : { scope: "only", ids: followedSessions(settings, hostId) },
    overrides,
  };
}

export function inQuietHours(quiet: QuietHours, now: Date): boolean {
  if (!quiet.on || quiet.start === quiet.end) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return quiet.start < quiet.end ? minute >= quiet.start && minute < quiet.end : minute >= quiet.start || minute < quiet.end;
}

const needsMe = (kind: string | undefined) => kind === "question" || kind === "approval";

/**
 * Whether the phone shows a notification. Applied to every notification,
 * because a Mac too old for `notificationFilters` sends everything.
 *
 * A notification without a kind (an older Mac) skips the kind switches; the
 * master switch, the machine, mute, the session scope and quiet hours still
 * apply. An unknown kind (a newer Mac) is shown as if switched on.
 */
export function shouldShow(settings: NotificationSettings, hostId: string, event: HostNotification, now: Date): boolean {
  if (!deliveryOn(settings, hostId)) return false;
  const override = event.sessionId ? sessionOverride(settings, hostId, event.sessionId) : "default";
  if (override === "mute") return false;
  if (override === "needsMe" && event.kind !== undefined && !needsMe(event.kind)) return false;
  if (override === "default") {
    if (settings.sessions === "mine" && event.sessionId && !followedSessions(settings, hostId).includes(event.sessionId)) return false;
    if (isNotificationKind(event.kind) && !settings.kinds[event.kind]) return false;
  }
  if (inQuietHours(settings.quietHours, now) && !(settings.quietHours.stillNotifyNeedsMe && needsMe(event.kind))) return false;
  return true;
}

const GENERIC: Record<NotificationKind, { title: string; body: string }> = {
  question: { title: "An agent needs your answer", body: "Open TerminalX to see the question." },
  approval: { title: "An agent needs approval", body: "Open TerminalX to see the request." },
  finished: { title: "An agent finished", body: "Open TerminalX to see the result." },
  failed: { title: "An agent stopped on an error", body: "Open TerminalX to see what happened." },
  usage_limit: { title: "An agent reached a usage limit", body: "Open TerminalX to see when it can go on." },
  pr_checks_failed: { title: "A pull request's checks failed", body: "Open TerminalX to see the checks." },
  pr_merged: { title: "A pull request was merged", body: "Open TerminalX to see it." },
};
const GENERIC_OTHER = { title: "TerminalX", body: "Open TerminalX to see what happened." };

export function genericText(kind: string | undefined): { title: string; body: string } {
  return isNotificationKind(kind) ? GENERIC[kind] : GENERIC_OTHER;
}

/** The notification's text at the chosen lock-screen level. */
export function present(settings: NotificationSettings, hostId: string, machineName: string, event: HostNotification): NotificationPresentation {
  const show = settings.lockScreen.show;
  const generic = genericText(event.kind);
  const answer = event.question ? { requestId: event.question.requestId, options: event.question.options } : event.approval ? { requestId: event.approval.requestId } : {};
  const data: NotificationPresentation["data"] = {
    hostId,
    sessionId: event.sessionId ?? "",
    tabId: event.tabId ?? "",
    kind: event.kind ?? "",
    detailsHidden: show === "nothing",
    ...(show === "nothing" ? {} : answer),
  };
  const sound = settings.lockScreen.sound;
  const thread = event.sessionId ? `${hostId}:${event.sessionId}` : hostId;
  if (show === "everything") return { title: event.title, body: event.body, subtitle: machineName, thread, sound, data };
  if (show === "sessionName") return { title: event.title, body: generic.body, thread, sound, data };
  return { title: generic.title, body: generic.body, thread, sound, data };
}
