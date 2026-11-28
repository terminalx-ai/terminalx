import { ArrowLeft } from "@/icons";
import { Button } from "@/components/ui/button";
import { useBotStore } from "@/lib/bots";
import { showBotsTeam } from "@/lib/botsPage";
import { BotAvatar } from "./BotAvatar";
import { BotMenu } from "./BotMenu";
import { BotSettings } from "./BotSettings";

/**
 * A bot's settings as a page of the Bots view (PRO-478), reached from the team table: the bot's name with its menu
 * above the settings. A bot that is not in the list says why rather than showing nothing.
 */
export function BotSettingsPage({ botId }: { botId: string }) {
  const store = useBotStore();
  const bot = store.bots.find((value) => value.id === botId) ?? null;
  const back = (
    <Button variant="ghost" size="sm" onClick={() => showBotsTeam(true)} data-testid="bot-settings-back">
      <ArrowLeft /> Bots
    </Button>
  );
  if (!bot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="bot-settings-page">
        <header className="flex min-h-12 shrink-0 items-center border-b border-hairline px-4 py-2">{back}</header>
        <p className="px-6 py-8 text-sm text-muted-foreground" data-testid="bot-settings-missing">
          {!store.loaded ? "Reading the bots…" : store.error ? `The bots cannot be read: ${store.error}` : store.unreadable > 0 ? "This bot cannot be read by this version of TerminalX." : "This bot is no longer here."}
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bot-settings-page">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-4 py-2">
        {back}
        <BotAvatar roleTemplateId={bot.roleTemplateId} size="md" paused={!!bot.paused} />
        <div className="min-w-0 flex-1">
          <h1 className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[15px] font-semibold text-foreground" title={bot.name}>{bot.name}</span>
            <span className="truncate text-[13px] text-muted-foreground">{bot.roleTitle}</span>
          </h1>
          <p className="text-[12px] text-faint">Settings</p>
        </div>
        <BotMenu bot={bot} onDeleted={() => showBotsTeam(true)} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="px-8 py-4">
          <BotSettings key={bot.id} bot={bot} />
        </div>
      </div>
    </div>
  );
}
