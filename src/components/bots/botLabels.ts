import type { Bot, BotAccess, BotDutyWake, BotRunsOn } from "@/types/bots";
import { effectiveAccess } from "@/types/bots";

/** Where a bot runs, in words. A place a newer app wrote is shown as its own text. */
export function runsOnLabel(runsOn: BotRunsOn): string {
  return runsOn === "thisMac" ? "This Mac" : runsOn;
}

/**
 * Whom a bot reports to: you, or another bot by its id. A lead that is not in the list is gone, unless records exist
 * that this build cannot read: it may be one of those.
 */
export function reportsToLabel(reportsTo: string, bots: Bot[], unreadable = 0): string {
  if (reportsTo === "owner") return "You";
  return bots.find((bot) => bot.id === reportsTo)?.name ?? (unreadable > 0 ? "A bot this version can't read" : "A removed bot");
}

/** Where it works: `personal` is you alone; an empty list means wherever it is given work. */
export function worksInLabel(worksIn: string[]): string {
  if (!worksIn.length) return "Wherever you give it work";
  return worksIn.map((place) => (place === "personal" ? "Personal" : place)).join(", ");
}

/** The access level as the page names it. A level a newer app wrote is shown as itself, and acted on as read and report. */
export function accessLabel(access: BotAccess): string {
  const known = effectiveAccess(access);
  if (known !== access) return `${access} (acts as Read and report)`;
  return known === "full" ? "Full access" : known === "askOutward" ? "Asks before acting outside" : "Read and report";
}

/**
 * The one status line under a bot's name. A resume asked for from the `terminalx` CLI waits on the owner's answer in
 * the bot's view (PRO-468); the runtime stops listing it after a day.
 */
export function statusLine(bot: Bot): string {
  if (!bot.paused) return "Quiet";
  return bot.resumeRequest ? "Paused · asks to resume" : "Paused";
}

/** What wakes a duty, as the line after its title. */
export function wakeLabel(wake: BotDutyWake): string {
  switch (wake.kind) {
    case "schedule":
      return `On a schedule · ${wake.cron}`;
    case "github":
      return `GitHub · ${wake.event}`;
    case "linear":
      return `Linear · ${wake.event}`;
    case "bot":
      return "When another bot asks";
    case "message":
      return "When you message it";
    default:
      // A kind a newer app wrote is shown as itself.
      return String((wake as { kind?: unknown }).kind ?? "");
  }
}

/** The bullets under "## What you do" in a role's text, for its "What it does". */
export function roleDuties(role: string): string[] {
  const lines = role.split("\n");
  const start = lines.findIndex((line) => /^##\s+what you do\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line.trim())) break;
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) items.push(item[1].trim());
  }
  return items;
}
