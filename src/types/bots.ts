/**
 * What a bot may do without asking. `full` is the default for a new bot. A level a newer app wrote
 * arrives as its own string; act on it as `readReport`, never as `full` (see `effectiveAccess`).
 */
export type BotAccess = "full" | "askOutward" | "readReport" | (string & {});

/** Only `thisMac` for now; a place a newer app wrote (a cloud workspace, another machine) arrives as its own string. */
export type BotRunsOn = "thisMac" | (string & {});

/** The level to act on: one this app does not know counts as the most restrictive one it knows. */
export function effectiveAccess(access: BotAccess): KnownBotAccess {
  return (KNOWN_ACCESS as readonly string[]).includes(access) ? (access as KnownBotAccess) : "readReport";
}

const KNOWN_ACCESS = ["full", "askOutward", "readReport"] as const;
type KnownBotAccess = (typeof KNOWN_ACCESS)[number];

/** When a bot was paused and by whom: `owner` (every caller today), or the id of the bot that paused it. */
export interface BotPause {
  at: string;
  by: string;
}

export interface Bot {
  /** The one stable reference to a bot: keep this, never the slug. */
  id: string;
  /** Unique among the bots, from the name. Changes with a rename and may be reused after a delete. */
  slug: string;
  name: string;
  roleTitle: string;
  roleTemplateId: string;
  harness: string;
  /** Empty for the agent's own default model. */
  model: string;
  effort?: string;
  access: BotAccess;
  runsOn: BotRunsOn;
  /** `owner` or another bot's id. */
  reportsTo: string;
  /** `personal` when it works for its owner alone. */
  worksIn: string[];
  paused?: BotPause;
  created: string;
  modified: string;
}

/** Every bot as one save left them. Of two lists, the one with the higher `revision` is the newer. */
export interface BotList {
  revision: number;
  bots: Bot[];
  /** Records the app cannot read (a newer app's). Kept as they are, and listed by none. */
  unreadable: number;
}

/** A change to a bot: a field left out stays as it is, and `effort: null` goes back to the agent's default. */
export interface BotPatch {
  name?: string;
  roleTitle?: string;
  harness?: string;
  model?: string;
  effort?: string | null;
  access?: BotAccess;
  runsOn?: BotRunsOn;
  reportsTo?: string;
  worksIn?: string[];
}

/** What wakes a duty. Data only until a person switches the duty on. */
export type BotDutyWake =
  | { kind: "schedule"; cron: string }
  | { kind: "github"; event: string }
  | { kind: "linear"; event: string }
  | { kind: "bot" }
  | { kind: "message" };

export interface BotTemplateDuty {
  id: string;
  title: string;
  description: string;
  wake: BotDutyWake;
  /** Always `false` in a template. */
  enabled: boolean;
}

/** A bundled role: no credentials, no permissions, every duty off. */
export interface BotRoleTemplate {
  id: string;
  title: string;
  description: string;
  /** The standing instructions a new bot's `ROLE.md` starts from. */
  role: string;
  skills: string[];
  duties: BotTemplateDuty[];
}
