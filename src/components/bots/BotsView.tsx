import { useState } from "react";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Calendar, Loader2, Moon, Pause, Play, Plus, RotateCw } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { pauseAllBots, pauseBot, reloadBots, resumeAllBots, resumeBot, useBotStore } from "@/lib/bots";
import { focusTaken, showHireBot, useBotsPage } from "@/lib/botsPage";
import { cn } from "@/lib/cn";
import { openBot } from "@/lib/sessions";
import type { Bot } from "@/types/bots";
import { BotAvatar, RunsOnIcon } from "./BotAvatar";
import { accessLabel, reportsToLabel, runsOnLabel, statusLine, worksInLabel } from "./botLabels";
import { unreadableText } from "./BotsSidebarSection";
import { BotsHeader } from "./BotsHeader";
import { FirstBot } from "./FirstBot";
import { HireBot } from "./HireBot";

/**
 * The Bots view (PRO-467): Hire a bot (23.03), the first-bot page while there are none (23.11), else the team (23.02).
 * The first-bot page only shows when the bots were read and there are truly none: not while they load, not over an
 * error, and not while records exist that this build cannot read.
 */
export function BotsView() {
  const page = useBotsPage();
  const store = useBotStore();
  if (page.page === "hire") return <HireBot initialRoleId={page.roleId} />;
  if (store.loaded && !store.error && store.bots.length === 0 && store.unreadable === 0) return <FirstBot />;
  return <BotsTeam focus={page.page === "team" && !!page.focus} />;
}

function BotsTeam({ focus }: { focus: boolean }) {
  const store = useBotStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bots = store.bots;
  const allPaused = bots.length > 0 && bots.every((bot) => bot.paused);
  const paused = bots.filter((bot) => bot.paused).length;
  const onMac = bots.filter((bot) => bot.runsOn === "thisMac").length;
  const elsewhere = bots.length - onMac;
  // Until the list is read, or when it could not be and nothing was read before, there is no team to count.
  const known = store.loaded && !(store.error && bots.length === 0);
  const team = bots.length + store.unreadable;

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    action().then(() => setError(null), (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bots-team">
      <BotsHeader title="Bots" note="Your AI team. The bots are yours and go with you across organisations." focus={focus} onFocused={focusTaken}>
        {allPaused ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(resumeAllBots)} data-testid="bots-resume-all">
            {busy ? <Loader2 className="animate-spin" /> : <Play />} Resume all
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={busy || bots.length === 0} onClick={() => run(pauseAllBots)} data-testid="bots-pause-all">
            {busy ? <Loader2 className="animate-spin" /> : <Pause />} Pause all
          </Button>
        )}
        {/* Filled by the calendar ticket. */}
        <WithTooltip label="The bots' calendar comes in a later build">
          <span>
            <Button variant="outline" size="sm" disabled aria-label="Calendar (coming later)">
              <Calendar /> Calendar
            </Button>
          </span>
        </WithTooltip>
        <Button variant="accent" size="sm" onClick={() => showHireBot()} data-testid="bots-hire">
          <Plus /> Hire a bot
        </Button>
      </BotsHeader>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="flex min-w-0 flex-col gap-5 px-6 py-4">
          {!store.loaded && (
            <p role="status" className="flex items-center gap-2 text-[12.5px] text-faint" data-testid="bots-reading">
              <Loader2 className="size-3.5 animate-spin" /> Reading the bots…
            </p>
          )}
          {store.error && (
            <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
              <span className="min-w-0 flex-1">Couldn't read the bots: {store.error}</span>
              <Button variant="outline" size="sm" onClick={() => void reloadBots()} data-testid="bots-retry">
                <RotateCw /> Retry
              </Button>
            </div>
          )}
          {error && <MachineHostError error={error} onRestarted={() => setError(null)} className="rounded-md bg-destructive/10 px-3 py-2" />}
          {store.unreadable > 0 && <p className="rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning" data-testid="bots-unreadable">{unreadableText(store.unreadable)}</p>}
          {allPaused && (
            <p className="rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning" data-testid="bots-all-paused">
              Every bot is paused. A paused bot stays paused until you resume it.
            </p>
          )}

          {known && (
          <>
          <div className="grid grid-cols-2 gap-3 @4xl/editor-host:grid-cols-4" data-testid="bots-stats">
            <StatCard
              label="Team"
              value={team === 1 ? "1 bot" : `${team} bots`}
              note={[`${onMac} on this Mac`, elsewhere ? `${elsewhere} elsewhere` : "", store.unreadable ? `${store.unreadable} cannot be read by this version` : ""].filter(Boolean).join(" · ")}
            />
            <StatCard label="Needs you" value="0" note="Nothing waiting" accent />
            <StatCard label="Working now" value={`${bots.length - paused} ready`} note={paused ? `${paused} paused` : "None paused"} />
            <StatCard label="Spent today" value="—" note="Model and cloud time · shown, never capped" />
          </div>

          {/* Filled by the work-items ticket. */}
          <section aria-labelledby="bots-needs-you" data-testid="bots-needs-you">
            <h2 id="bots-needs-you" className="mb-2 text-[11px] font-medium uppercase tracking-[.08em] text-accent">
              Needs you <span className="ml-1">0</span>
            </h2>
            <p className="rounded-lg border border-dashed border-hairline-strong px-4 py-3 text-[12.5px] text-faint">
              Nothing needs you. A bot's questions and approvals wait here.
            </p>
          </section>

          <section aria-labelledby="bots-team-heading">
            <h2 id="bots-team-heading" className="mb-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Team</h2>
            <TeamTable bots={bots} unreadable={store.unreadable} onError={setError} />
          </section>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, note, accent = false }: { label: string; value: string; note: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-hairline bg-card px-4 py-3" data-testid="bots-stat">
      <p className="truncate text-[11px] font-medium uppercase tracking-[.08em] text-faint">{label}</p>
      <p className={cn("mt-1 truncate text-[19px] font-semibold", accent ? "text-accent" : "text-foreground")}>{value}</p>
      <p className="mt-0.5 text-[12px] text-faint">{note}</p>
    </div>
  );
}

const COLUMNS = ["Bot", "Doing now", "Needs you", "Runs on", "Reports to", "Works in", "Spent", "Active", ""];

/** The team table (23.02). It scrolls sideways inside its own box when the window is narrow. */
function TeamTable({ bots, unreadable, onError }: { bots: Bot[]; unreadable: number; onError: (error: string | null) => void }) {
  return (
    <div className="min-w-0 overflow-x-auto scrollbar-thin" data-testid="bots-table-scroll">
      <table className="w-full min-w-[860px] border-collapse text-[12.5px]" aria-label="Team" data-testid="bots-table">
        <thead>
          <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-[.06em] text-faint">
            {COLUMNS.map((column, index) => (
              <th key={index} scope="col" className="px-2 py-2 font-medium">
                {column || <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bots.map((bot) => <TeamRow key={bot.id} bot={bot} bots={bots} unreadable={unreadable} onError={onError} />)}
        </tbody>
      </table>
    </div>
  );
}

function TeamRow({ bot, bots, unreadable, onError }: { bot: Bot; bots: Bot[]; unreadable: number; onError: (error: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const lead = bot.reportsTo === "owner" ? null : bots.find((other) => other.id === bot.reportsTo) ?? null;
  const toggle = () => {
    setBusy(true);
    (bot.paused ? resumeBot(bot.id) : pauseBot(bot.id))
      .then(() => onError(null), (cause) => onError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <tr className="group border-b border-hairline" data-testid="bots-table-row" data-bot={bot.id} data-paused={bot.paused ? "true" : "false"}>
      <td className="px-2 py-2.5">
        {/* A table cell does not bound its content's width: the box inside does, so a long name truncates. */}
        {/* The name opens the bot's own view, on its home chat (PRO-468). */}
        <button
          type="button"
          onClick={() => openBot(bot.id)}
          aria-label={`Open ${bot.name}`}
          className="flex w-[220px] min-w-0 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="bot-open"
        >
          <BotAvatar roleTemplateId={bot.roleTemplateId} size="md" paused={!!bot.paused} />
          <div className="min-w-0">
            <p className="truncate text-[13px] text-foreground group-hover:underline" title={bot.name}>{bot.name}</p>
            {/* Full access is every bot's default; a bot that was lowered says so. */}
            <p className="truncate text-[11.5px] text-faint" data-testid="bot-role-line">{bot.access === "full" ? bot.roleTitle : `${bot.roleTitle} · ${accessLabel(bot.access)}`}</p>
          </div>
        </button>
      </td>
      <td className="px-2 py-2.5">
        {bot.paused ? (
          <span className="inline-flex items-center gap-1.5 text-warning" data-testid="bot-doing-now"><Pause className="size-3.5" /> {statusLine(bot)}</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground" data-testid="bot-doing-now"><Moon className="size-3.5" /> Quiet</span>
        )}
      </td>
      <td className="px-2 py-2.5 text-faint">–</td>
      <td className="px-2 py-2.5">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
          <RunsOnIcon runsOn={bot.runsOn} className="size-3.5" />
          {runsOnLabel(bot.runsOn)}
        </span>
      </td>
      <td className="px-2 py-2.5">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
          {lead && <BotAvatar roleTemplateId={lead.roleTemplateId} size="xs" />}
          {reportsToLabel(bot.reportsTo, bots, unreadable)}
        </span>
      </td>
      <td className="px-2 py-2.5 text-muted-foreground">
        <span className="block max-w-[200px] truncate" title={worksInLabel(bot.worksIn)}>{worksInLabel(bot.worksIn)}</span>
      </td>
      <td className="px-2 py-2.5 font-mono text-faint">—</td>
      <td className="px-2 py-2.5 text-faint">—</td>
      <td className="px-2 py-2.5 text-right">
        <WithTooltip label={bot.paused ? `Resume ${bot.name}` : `Pause ${bot.name}`}>
          <Button variant="ghost" size="icon-xs" disabled={busy} aria-label={bot.paused ? `Resume ${bot.name}` : `Pause ${bot.name}`} onClick={toggle} data-testid="bot-pause-toggle">
            {bot.paused ? <Play /> : <Pause />}
          </Button>
        </WithTooltip>
      </td>
    </tr>
  );
}
