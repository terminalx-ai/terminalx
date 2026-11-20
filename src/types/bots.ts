/** What a bot may do without asking. `full` is the default for a new bot. */
export type BotAccess = "full" | "askOutward" | "readReport";

export type BotRunsOn = "thisMac";

/** When a bot was paused and by whom: `owner`, or the id of the bot that paused it. */
export interface BotPause {
  at: string;
  by: string;
}

export interface Bot {
  id: string;
  /** Unique among the bots, from the name. */
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
