import { Plus, RotateCw, Users } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { ListSection } from "@/components/layout/SessionSidebar";
import { reloadBots, useBotStore } from "@/lib/bots";
import { needsYouCount, needsYouTrouble, useNeedsYou, useNeedsYouError } from "@/lib/botItems";
import { showHireBot } from "@/lib/botsPage";
import { openBot, useSessionStore } from "@/lib/sessions";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { cn } from "@/lib/cn";
import type { Bot } from "@/types/bots";
import { BotAvatar, RunsOnIcon } from "./BotAvatar";
import { runsOnLabel, statusLine } from "./botLabels";

/** What the sidebar says with no bots (23.11). */
export const NO_BOTS_TEXT = "No bots yet. A bot keeps a job: it remembers, follows up and asks you when it needs a decision.";

/** "2 bots were saved by a newer TerminalX …": records exist that this build cannot show. */
export function unreadableText(count: number): string {
  return `${count === 1 ? "1 bot was" : `${count} bots were`} saved by a newer TerminalX and can't be shown here. Update the app to see ${count === 1 ? "it" : "them"}.`;
}

/**
 * The sidebar's Bots section (PRO-467, 23.02): one row per bot with its avatar, name, role, one status line and where
 * it runs, a count and a +. Nothing at all while Settings → Experimental → Bots is off.
 */
export function BotsSidebarSection() {
  const on = useExperimentalSettings()?.bots === true;
  if (!on) return null;
  return <BotsList />;
}

function BotsList() {
  const store = useBotStore();
  const count = store.bots.length + store.unreadable;
  return (
    <ListSection
      id="bots"
      label="Bots"
      mark={<Users className="size-3.5 shrink-0 text-muted-foreground" />}
      note={count > 0 ? String(count) : undefined}
      data-testid="bots-sidebar-section"
      // Shown even while the section is folded: they say the list is not the whole team.
      notes={
        <>
          {store.error && (
            <p role="alert" className="flex items-center gap-1 px-2.5 py-1 text-[12px] text-destructive" title={store.error}>
              <span className="min-w-0 flex-1">Couldn't read the bots: {store.error}</span>
              <WithTooltip label="Read the bots again">
                <Button variant="ghost" size="icon-xs" aria-label="Read the bots again" onClick={() => void reloadBots()}>
                  <RotateCw />
                </Button>
              </WithTooltip>
            </p>
          )}
          {store.unreadable > 0 && <p className="px-2.5 py-1 text-[12px] text-warning" data-testid="bots-sidebar-unreadable">{unreadableText(store.unreadable)}</p>}
        </>
      }
      actions={
        <WithTooltip label="Hire a bot">
          <Button variant="ghost" size="icon-xs" aria-label="Hire a bot" className="text-faint" onClick={() => showHireBot()} data-testid="bots-sidebar-hire">
            <Plus />
          </Button>
        </WithTooltip>
      }
    >
      {store.loaded && !store.error && store.bots.length === 0 && store.unreadable === 0 && (
        <p className="px-2.5 py-1 text-[12px] leading-[1.45] text-faint" data-testid="bots-sidebar-empty">{NO_BOTS_TEXT}</p>
      )}
      {store.bots.length > 0 && (
        <ul className="flex flex-col gap-px" aria-label="Bots">
          {store.bots.map((bot) => <BotRow key={bot.id} bot={bot} />)}
        </ul>
      )}
    </ListSection>
  );
}

/** A bot's row opens its own view, on its home chat (PRO-468). */
function BotRow({ bot }: { bot: Bot }) {
  const store = useSessionStore();
  // What waits on you from this bot (PRO-469): the same count as the Bots page's.
  const needs = useNeedsYou();
  const asking = needsYouCount(needs, bot.id);
  const trouble = needsYouTrouble(needs, useNeedsYouError(), bot.id);
  const open = store.view === "bot" ? store.selectedBotId === bot.id : !!store.selectedSessionId && store.sessions.find((session) => session.id === store.selectedSessionId)?.bot?.id === bot.id;
  const place = runsOnLabel(bot.runsOn);
  const status = statusLine(bot);
  return (
    <li>
      <button
        type="button"
        onClick={() => openBot(bot.id)}
        aria-current={open ? "page" : undefined}
        aria-label={`${bot.name}, ${bot.roleTitle}, ${status}${asking ? `, ${asking} need${asking === 1 ? "s" : ""} you` : ""}, runs on ${place}`}
        className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-selected/50 focus-visible:ring-2 focus-visible:ring-ring/40", open && "bg-selected")}
        data-testid="bot-row"
        data-bot={bot.id}
      >
        <BotAvatar roleTemplateId={bot.roleTemplateId} paused={!!bot.paused} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 max-w-[60%] shrink-0 truncate text-[13px] text-foreground">{bot.name}</span>
            <span className="min-w-0 truncate text-[11px] text-faint">{bot.roleTitle}</span>
          </span>
          <span className={cn("truncate text-[11.5px]", bot.paused ? "text-warning" : "text-faint")}>{status}</span>
        </span>
        {trouble ? (
          <span className="shrink-0 text-[11.5px] font-medium text-destructive" title={`Couldn't read what needs you: ${trouble}`} data-testid="bot-row-needs-you-error">!</span>
        ) : asking > 0 ? (
          <span className="shrink-0 text-[11.5px] font-medium text-accent" title={`${asking} need${asking === 1 ? "s" : ""} you`} data-testid="bot-row-needs-you">{asking}</span>
        ) : (
          <span title={place} className="shrink-0 text-faint [&_svg]:size-3">
            <RunsOnIcon runsOn={bot.runsOn} />
          </span>
        )}
      </button>
    </li>
  );
}
