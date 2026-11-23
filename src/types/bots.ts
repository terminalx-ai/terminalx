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

/** Where a pause came from (PRO-474). A place a newer app wrote arrives as its own string and is shown as the app's. */
export type BotPauseFrom = "app" | "shortcut" | "phone" | "cli" | (string & {});

/** What a pause stopped, as it was when the bot was paused (PRO-474). Written once, right after the pause. */
export interface BotPauseStopped {
  /** What it was doing, as the page says it after "Paused · ": "was working on “…”", "was quiet". */
  was: string;
  /** Its chats, and sessions it started, that were in a turn: stopped there. */
  chats?: number;
  /** Its runs' workers that were in a turn: each finishes the step it is on, then stops. */
  workers?: number;
  /** Its duty runs that were going. */
  duties?: number;
  /** What it had spent today when it was paused. */
  spent?: { day: string; usd: number };
}

/** When a bot was paused and by whom: `owner`, or the id of the bot whose own session paused it. */
export interface BotPause {
  at: string;
  by: string;
  /** Absent for a pause an older app recorded. */
  from?: BotPauseFrom;
  /** Absent until the pause has been enforced, and for a pause an older app recorded. */
  stopped?: BotPauseStopped;
}

/** One entry of "Held while paused" (23.12), as the runtime read it where it is kept. */
export type PauseHeldEntry =
  /** A scheduled duty run that fell due while its bot was paused: skipped, not run late. `count` folds repeats. */
  | { kind: "skipped"; source: "duty"; botId: string; dutyId: string; name: string; at: string; count: number }
  /** A duty that wakes on events: they are not read while paused, so they wait and wake it on resume. */
  | { kind: "kept"; source: "events"; botId: string; dutyId: string; name: string; at: string }
  /** Work handed to the paused bot: it starts on resume. */
  | { kind: "kept"; source: "handoff"; botId: string; fromId: string; by: string; number: number; title: string; at: string }
  /** A message (an answer, a status, a stop) sent to the paused bot: sent on resume. */
  | { kind: "kept"; source: "message"; botId: string; fromId: string; messageKind: string; handoff?: number | null; at: string }
  /** The owner's answer, comment or work given on one of its items: sent on resume. */
  | { kind: "kept"; source: "answer"; botId: string; number: number; messageKind: "answer" | "comment" | "work" | (string & {}); at: string };

/** What the paused bots hold (PRO-474): every bot's turns still going and its open questions, and the held list. */
export interface PauseHeld {
  /** `inTurn`: its run workers in a turn (a paused bot's, finishing their step); its chats answering you are not counted. */
  bots: { id: string; inTurn: number; needsYou: number }[];
  entries: PauseHeldEntry[];
  /** A part that could not be read: said, never shown as nothing held. */
  errors: string[];
}

/**
 * Someone besides the owner who may give a bot work (PRO-478), and what they may do. The owner is never listed: they
 * always ask and approve. A `kind` or `may` a newer app wrote arrives as its own string, is shown as it is, and grants
 * nothing here.
 */
export interface BotAsker {
  kind: "person" | "bot" | (string & {});
  /** A person's account user id, or a bot's id. */
  id: string;
  /** How a person is shown, as they were named when added. A bot is shown by its own name. */
  name?: string;
  may: BotAskerMay;
  /** The organisation a person was added from. They are inactive while the bot does not work there. */
  org?: string;
  /** A person's email, as their organisation lists them: their comments on Linear are known by it (PRO-480). */
  email?: string;
  /** A person's GitHub login, as the owner gave it: their comments on GitHub are known by it (PRO-480). */
  github?: string;
}

/** Ask and approve (a person only), ask, or hand off work (another bot only). */
export type BotAskerMay = "askApprove" | "ask" | "handOff" | (string & {});

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
  /** Who besides the owner may give it work. Absent or empty: the owner alone. */
  whoCanAsk?: BotAsker[];
  /** The owner turned its memory off: a conversation is given none, and the bot writes none. */
  memoryOff?: boolean;
  /** A resume asked for from the `terminalx` CLI, waiting for the owner's answer in the app (PRO-468). */
  resumeRequest?: { at: string; by: string };
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
  /** The whole list: an entry left out is removed. */
  whoCanAsk?: BotAsker[];
  /** The bot's `modified` as read: a whole-list change is refused when the bot changed since. */
  ifModified?: string;
  memoryOff?: boolean;
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
