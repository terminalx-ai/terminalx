import type { AutomationRunStatus } from "@/types/automations";
import type { BotItem, BotItemAct } from "@/types/botItems";

/** Where a suggestion came from: a look around's run, or the bot's chat. */
export interface SuggestionFrom {
  kind: "lookAround" | "chat" | (string & {});
  session?: string | null;
  run?: string | null;
  runNumber?: number | null;
}

/** Something a bot proposes doing (PRO-477), shown on its Home tab with Start and Dismiss. */
export interface BotSuggestion {
  number: number;
  title: string;
  why: string;
  /** `open`, `started` or `dismissed`; another state a newer app wrote counts as closed. */
  state: "open" | "started" | "dismissed" | (string & {});
  created: string;
  closed?: string | null;
  from: SuggestionFrom;
  /** The item Start made. */
  item?: number | null;
}

/** The last finished run of a built-in duty, as its status line says it. */
export interface BuiltinLast {
  runId: string;
  runNumber: number;
  at: string | null;
  status: AutomationRunStatus;
  /** Why it did no work, when it did none: the free check's words, a pause, a failure. */
  why: string | null;
  suggestions: number;
  /** How many actions TerminalX refused while it looked, and which. */
  refused: number;
  refusedWhat: string[];
}

export interface BuiltinStatus {
  dutyId: string;
  enabled: boolean;
  nextRunAt: string;
  running: boolean;
  focus: string | null;
  last: BuiltinLast | null;
}

export interface SuggestionsStatus {
  lookAround: BuiltinStatus | null;
  tidyMemory: BuiltinStatus | null;
  paused: boolean;
  readOnly: boolean;
}

/** A bot's open suggestions, newest first, and how its built-in duties last went. */
export interface SuggestionsView {
  suggestions: BotSuggestion[];
  /** Suggestions a newer app wrote that this one cannot show. */
  unreadable: number;
  status: SuggestionsStatus;
}

/** What Start did: the suggestion, now started, the item it made, and whether the bot was told. */
export interface SuggestionStarted {
  suggestion: BotSuggestion;
  item: BotItem | null;
  delivery: BotItemAct["delivery"];
}
