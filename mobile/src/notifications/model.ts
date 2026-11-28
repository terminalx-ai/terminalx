/**
 * What the person chose on this phone about notifications (#990): which kinds
 * of event, for which sessions and machines, when, and how much shows on the
 * lock screen. Plain JSON with no screen state, so the push service (#989)
 * can read the same value.
 */

export const NOTIFICATION_KINDS = ["question", "approval", "finished", "failed", "usage_limit", "pr_checks_failed", "pr_merged"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Per session: follow the page's choices, only what needs me, everything from it, or nothing. */
export type SessionOverride = "default" | "needsMe" | "everything" | "mute";
export type LockScreenShow = "everything" | "sessionName" | "nothing";
export type SessionScope = "all" | "mine";

export interface QuietHours {
  on: boolean;
  /** Minutes after local midnight, 0–1439. `end` before `start` runs across midnight. */
  start: number;
  end: number;
  /** Questions and approvals still arrive during quiet hours. */
  stillNotifyNeedsMe: boolean;
}

export interface NotificationSettings {
  v: 1;
  /** The master switch. */
  allow: boolean;
  kinds: Record<NotificationKind, boolean>;
  /** "mine": sessions started from this phone, and sessions followed with an override. */
  sessions: SessionScope;
  /** Per Mac (host id). A Mac not listed is on. */
  machines: Record<string, boolean>;
  quietHours: QuietHours;
  lockScreen: { show: LockScreenShow; sound: boolean };
  /** hostId → sessionId → override; "default" is never stored. */
  perSession: Record<string, Record<string, Exclude<SessionOverride, "default">>>;
  /** hostId → ids of sessions started from this phone, oldest first. */
  started: Record<string, string[]>;
}

export const DEFAULT_KINDS: Record<NotificationKind, boolean> = {
  question: true,
  approval: true,
  finished: true,
  failed: true,
  pr_checks_failed: true,
  usage_limit: false,
  pr_merged: false,
};

/** How many started sessions are kept per Mac; the oldest go first. */
export const STARTED_LIMIT = 200;

export function defaultSettings(): NotificationSettings {
  return {
    v: 1,
    allow: false,
    kinds: { ...DEFAULT_KINDS },
    sessions: "all",
    machines: {},
    quietHours: { on: false, start: 22 * 60, end: 7 * 60, stillNotifyNeedsMe: false },
    lockScreen: { show: "sessionName", sound: true },
    perSession: {},
    started: {},
  };
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/** A stored value read back: anything missing or unreadable takes its default. */
export function parseSettings(value: unknown): NotificationSettings {
  const defaults = defaultSettings();
  if (!value || typeof value !== "object") return defaults;
  const record = value as Record<string, unknown>;
  const kinds = { ...defaults.kinds };
  if (record.kinds && typeof record.kinds === "object") {
    for (const kind of NOTIFICATION_KINDS) {
      const on = (record.kinds as Record<string, unknown>)[kind];
      if (typeof on === "boolean") kinds[kind] = on;
    }
  }
  const machines: Record<string, boolean> = {};
  if (record.machines && typeof record.machines === "object") {
    for (const [hostId, on] of Object.entries(record.machines as Record<string, unknown>)) if (typeof on === "boolean") machines[hostId] = on;
  }
  const quiet = (record.quietHours && typeof record.quietHours === "object" ? record.quietHours : {}) as Record<string, unknown>;
  const lock = (record.lockScreen && typeof record.lockScreen === "object" ? record.lockScreen : {}) as Record<string, unknown>;
  const perSession: NotificationSettings["perSession"] = {};
  if (record.perSession && typeof record.perSession === "object") {
    for (const [hostId, sessions] of Object.entries(record.perSession as Record<string, unknown>)) {
      if (!sessions || typeof sessions !== "object") continue;
      for (const [sessionId, mode] of Object.entries(sessions as Record<string, unknown>)) {
        if (mode === "needsMe" || mode === "everything" || mode === "mute") (perSession[hostId] ??= {})[sessionId] = mode;
      }
    }
  }
  const started: NotificationSettings["started"] = {};
  if (record.started && typeof record.started === "object") {
    for (const [hostId, ids] of Object.entries(record.started as Record<string, unknown>)) {
      if (Array.isArray(ids)) {
        const kept = ids.filter((id): id is string => typeof id === "string" && id.length > 0).slice(-STARTED_LIMIT);
        if (kept.length) started[hostId] = kept;
      }
    }
  }
  return {
    v: 1,
    allow: typeof record.allow === "boolean" ? record.allow : defaults.allow,
    kinds,
    sessions: record.sessions === "mine" ? "mine" : "all",
    machines,
    quietHours: {
      on: typeof quiet.on === "boolean" ? quiet.on : defaults.quietHours.on,
      start: minutes(quiet.start) ?? defaults.quietHours.start,
      end: minutes(quiet.end) ?? defaults.quietHours.end,
      stillNotifyNeedsMe: typeof quiet.stillNotifyNeedsMe === "boolean" ? quiet.stillNotifyNeedsMe : defaults.quietHours.stillNotifyNeedsMe,
    },
    lockScreen: {
      show: lock.show === "everything" || lock.show === "sessionName" || lock.show === "nothing" ? lock.show : defaults.lockScreen.show,
      sound: typeof lock.sound === "boolean" ? lock.sound : defaults.lockScreen.sound,
    },
    perSession,
    started,
  };
}

function minutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 24 * 60 ? value : null;
}

export function machineOn(settings: NotificationSettings, hostId: string): boolean {
  return settings.machines[hostId] !== false;
}

/** Whether this Mac's notifications reach the phone at all. */
export function deliveryOn(settings: NotificationSettings, hostId: string): boolean {
  return settings.allow && machineOn(settings, hostId);
}

export function sessionOverride(settings: NotificationSettings, hostId: string, sessionId: string): SessionOverride {
  return settings.perSession[hostId]?.[sessionId] ?? "default";
}

/** "Sessions I started or follow" on one Mac: started from this phone, or followed with needsMe/everything. */
export function followedSessions(settings: NotificationSettings, hostId: string): string[] {
  const ids = new Set(settings.started[hostId] ?? []);
  for (const [sessionId, mode] of Object.entries(settings.perSession[hostId] ?? {})) if (mode === "needsMe" || mode === "everything") ids.add(sessionId);
  return [...ids];
}

export function withOverride(settings: NotificationSettings, hostId: string, sessionId: string, mode: SessionOverride): NotificationSettings {
  const forHost = { ...(settings.perSession[hostId] ?? {}) };
  if (mode === "default") delete forHost[sessionId];
  else forHost[sessionId] = mode;
  const perSession = { ...settings.perSession };
  if (Object.keys(forHost).length) perSession[hostId] = forHost;
  else delete perSession[hostId];
  return { ...settings, perSession };
}

export function withStartedSession(settings: NotificationSettings, hostId: string, sessionId: string): NotificationSettings {
  const ids = (settings.started[hostId] ?? []).filter((id) => id !== sessionId);
  return { ...settings, started: { ...settings.started, [hostId]: [...ids, sessionId].slice(-STARTED_LIMIT) } };
}

/** The agent events, as the Settings row lists them (the first section of the page). */
const AGENT_KIND_LABELS: [NotificationKind, string][] = [
  ["question", "questions"],
  ["approval", "approvals"],
  ["finished", "finished"],
  ["failed", "failed"],
  ["usage_limit", "usage limits"],
];

/**
 * The Settings row's second line (22.07): the agent events switched on, as
 * "Questions, approvals, finished, failed" for the defaults; "Off" when the
 * master switch is off. Pull request events are not listed, unless they are
 * all that is on.
 */
export function settingsSummary(settings: NotificationSettings): string {
  if (!settings.allow) return "Off";
  const on = AGENT_KIND_LABELS.filter(([kind]) => settings.kinds[kind]).map(([, label]) => label);
  if (!on.length) return settings.kinds.pr_checks_failed || settings.kinds.pr_merged ? "Pull requests only" : "No events chosen";
  const text = on.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
