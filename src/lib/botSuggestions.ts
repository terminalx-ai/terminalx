import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { errorMessage, invoke } from "@/lib/api";
import { useAutomationStore } from "@/lib/automations";
import { dutiesOf } from "@/lib/botDuties";
import type { Automation, AutomationRun } from "@/types/automations";
import type { BotSuggestion, BuiltinLast, BuiltinStatus, SuggestionStarted, SuggestionsView } from "@/types/botSuggestions";

/**
 * A bot's suggestions and its built-in duties (PRO-477). A look around proposes work, read-only; the owner presses
 * Start, which makes an item and sends it to the bot as the owner's message, or Dismiss. Start carries a person's
 * proof, as giving work does. Every call is refused while Settings → Experimental → Bots is off.
 */
export const suggestionsApi = {
  /** The open suggestions, newest first, and how Look around and Tidy memory last went. */
  list: (id: string) => invoke<SuggestionsView>("bot_suggestions", { id }),
  start: (id: string, number: number) => invoke<SuggestionStarted>("bot_suggestion_start", { id, number }),
  dismiss: (id: string, number: number) => invoke<BotSuggestion>("bot_suggestion_dismiss", { id, number }),
};

/** The event the runtime sends when a bot's suggestions change (`bots::suggestions::CHANGED_EVENT`). */
export const SUGGESTIONS_EVENT = "bot_suggestions_changed";

/** Which built-in a duty is, if it is one: `lookAround`, `tidyMemory`, or one a newer app made. */
export function builtinOf(duty: Pick<Automation, "bot">): string | null {
  const kind = duty.bot?.builtin;
  return typeof kind === "string" && kind ? kind : null;
}

/**
 * A bot's suggestions, read when it opens, when they change, and when one of its built-in duties changes or runs, so
 * the status line follows a look as it ends. A read that fails is kept and said, never shown as no suggestions.
 */
export function useBotSuggestions(botId: string): { view: SuggestionsView | null; error: string | null; reload: () => void } {
  const automations = useAutomationStore();
  const [view, setView] = useState<SuggestionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = useMemo(() => builtinKey(automations.automations, automations.runs, botId), [automations.automations, automations.runs, botId]);
  useEffect(() => {
    let live = true;
    suggestionsApi.list(botId).then(
      (value) => { if (live) { setView(value); setError(null); } },
      (cause) => { if (live) setError(errorMessage(cause)); },
    );
    return () => { live = false; };
  }, [botId, key, tick]);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let live = true;
    listen<{ botId?: string }>(SUGGESTIONS_EVENT, (event) => {
      if (!event.payload?.botId || event.payload.botId === botId) setTick((value) => value + 1);
    }).then((unlisten) => { if (live) stop = unlisten; else unlisten(); }, () => { /* outside a webview */ });
    return () => { live = false; stop?.(); };
  }, [botId]);
  return { view, error, reload: useCallback(() => setTick((value) => value + 1), []) };
}

/** What says a bot's built-ins changed or ran: each one's definition and its newest run's state. */
export function builtinKey(automations: readonly Automation[], runs: Record<string, AutomationRun[]>, botId: string): string {
  return dutiesOf(automations, botId)
    .filter((duty) => builtinOf(duty))
    .map((duty) => {
      const newest = runs[duty.id]?.[0];
      return `${duty.id}:${duty.modified}:${duty.enabled}:${duty.lastRunAt ?? ""}:${newest ? `${newest.runId}/${newest.status}` : ""}`;
    })
    .join("|");
}

/** A bot's enabled duties that wake on a schedule, soonest first: its Up next. Event-woken ones follow, untimed. */
export function upNext(duties: readonly Automation[], limit = 4): { duty: Automation; at: string | null }[] {
  const on = duties.filter((duty) => duty.enabled);
  const timed = on.filter((duty) => !duty.eventTrigger && !duty.issueTrigger && Number.isFinite(Date.parse(duty.nextRunAt)));
  timed.sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
  const untimed = on.filter((duty) => !timed.includes(duty));
  return [...timed.map((duty) => ({ duty, at: duty.nextRunAt })), ...untimed.map((duty) => ({ duty, at: null }))].slice(0, limit);
}

/**
 * The Suggestions status line: when the bot last looked and what came of it, a look that was refused or did no work
 * saying why, or that Look around is off. `when` turns a time into words ("20m ago").
 */
export function lookLine(status: BuiltinStatus | null, botName: string, when: (iso: string) => string): string {
  if (!status) return `${botName} has no Look around yet.`;
  if (status.running) return `${botName} is looking around now…`;
  const last = status.last;
  const off = status.enabled ? "" : " Look around is off.";
  if (!last) return status.enabled ? `${botName} has not looked around yet.` : `Look around is off.`;
  const at = last.at ? when(last.at) : "";
  return `${lastLine(last, at)}${off}`;
}

function lastLine(last: BuiltinLast, at: string): string {
  const since = at ? ` ${at}` : "";
  switch (last.status) {
    case "completed": {
      const made = last.suggestions === 1 ? "1 suggestion" : `${last.suggestions} suggestions`;
      const refused = last.refused > 0 ? `; ${last.refused === 1 ? "1 action" : `${last.refused} actions`} refused, it may only read` : "";
      return `Last looked${since}: ${made}${refused}.`;
    }
    case "skippedPrecheck":
      return `Last check${since}: ${last.why ?? "Nothing new."}`;
    case "failed":
    case "timedOut":
      return `Last look${since} ${last.status === "timedOut" ? "timed out" : "failed"}${last.why ? `: ${last.why}` : "."}`;
    default:
      return `Last look${since} did not run${last.why ? `: ${last.why}` : "."}`;
  }
}
