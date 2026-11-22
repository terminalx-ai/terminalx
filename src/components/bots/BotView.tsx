import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { BotDuties } from "@/components/bots/BotDuties";
import { Bot as BotIcon, Brain, CircleDot, Home, LayoutGrid, Laptop, ListChecks, Loader2, MessageSquare, MessageSquarePlus, PanelLeft, Pause, Play, ShieldOff, Settings2, Sparkles } from "@/icons";
import { SessionView } from "@/components/session/SessionView";
import { BotRoleMemory } from "@/components/bots/BotRoleMemory";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { WithTooltip } from "@/components/ui/tooltip";
import { botsApi, errorMessage } from "@/lib/api";
import { botChats, botSpentToday, openHomeChat, spentTodayLabel, startBotChat, usageKey } from "@/lib/botChats";
import { pauseBot, resumeBot, useBotStore } from "@/lib/bots";
import { heldLine, pausedBySentence, pausedStatus, usePauseHeld } from "@/lib/botPause";
import { showBotsTeam } from "@/lib/botsPage";
import { needsYouCount, needsYouTrouble, tookOpening, useNeedsYou, useNeedsYouError, useOpeningItem } from "@/lib/botItems";
import { cn } from "@/lib/cn";
import { conversationTitle, selectSession, upsertSession, useSessionStore } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import { effectiveAccess, type Bot, type PauseHeld } from "@/types/bots";
import type { SessionEntry } from "@/types/session";
import { ChatRow } from "./BotChatRow";
import { BotHome } from "./BotHome";
import { BotItemPage } from "./BotItemPage";
import { HandoffCards, TeamBriefEditor, TeamBriefRow } from "./BotHandoffs";
import { RunPlanCards, StartedRunRow } from "./BotRuns";
import { runStateLine, startedStateLine, workerSessions } from "@/lib/botRuns";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { useRunsByLead } from "@/lib/orchestration";
import type { Run } from "@/types/orchestration";
import { BotMenu } from "./BotMenu";
import { BotSettings } from "./BotSettings";

export type BotTab = "home" | "chat" | "duties" | "role" | "settings";

const TABS: { id: BotTab; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Home", icon: LayoutGrid },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "duties", label: "Duties", icon: ListChecks },
  { id: "role", label: "Role and memory", icon: Brain },
  { id: "settings", label: "Settings", icon: Settings2 },
];

const ACCESS_LABEL = { full: "Full access", askOutward: "Asks before outward", readReport: "Read and report" } as const;

function accessLabel(bot: Bot): string {
  const known = effectiveAccess(bot.access);
  // A level a newer app wrote is shown as it is, and acted on as read and report.
  return known === bot.access ? ACCESS_LABEL[known] : `${bot.access} (read and report here)`;
}

function runsOnLabel(bot: Bot): string {
  return bot.runsOn === "thisMac" ? "This Mac" : bot.runsOn;
}

/**
 * A bot's view (PRO-468, designs 23.01 and 23.04): its header with what it runs on, its Pause and its menu (agent and
 * model, rename, delete), and its tabs. Chat has the bot's chats on the left, the open one's transcript and composer on
 * the right; Role and memory is the bot's role, memory and their history (PRO-470, design 23.06), and an unsaved role
 * edit is kept when another tab is opened; Settings has its settings (PRO-478, 23.07), the same as the team table's
 * settings page.
 */
export function BotView({ botId, chatId, sidebarOpen, onToggleSidebar, titlebarInset }: {
  botId: string;
  /** The bot's chat selected in the session store, if one is; else its home chat is shown. */
  chatId: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  titlebarInset: number;
}) {
  const bots = useBotStore();
  const store = useSessionStore();
  const [tab, setTab] = useState<BotTab>("chat");
  const bot = bots.bots.find((value) => value.id === botId) ?? null;
  const { chats, startedBy, dutyRuns } = useMemo(() => botChats(store.sessions, botId), [store.sessions, botId]);
  // A session one of the bot's chats started, opened here rather than in its project.
  const [startedId, setStartedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setStartedId(null), [chatId]);
  // The team brief, open where a chat would be (PRO-475).
  const [briefOpen, setBriefOpen] = useState(false);
  useEffect(() => setBriefOpen(false), [chatId, botId]);
  // The Home tab's open item (PRO-469); another bot opens on its own Home.
  const [item, setItem] = useState<number | null>(null);
  useEffect(() => setItem(null), [botId]);
  const opening = useOpeningItem(botId);
  useEffect(() => {
    if (opening === null) return;
    setTab("home");
    setItem(opening);
    tookOpening();
  }, [opening]);
  const needs = useNeedsYou();
  const asking = needsYouCount(needs, botId);
  const trouble = needsYouTrouble(needs, useNeedsYouError(), botId);
  const working = needs?.counts.find((count) => count.botId === botId)?.inProgress ?? 0;

  // The home chat is made at hire; a bot hired before, or whose home chat was archived, gets one when it is opened.
  const hasHome = chats.some((chat) => chat.bot?.home);
  const [homeFailed, setHomeFailed] = useState(false);
  useEffect(() => setHomeFailed(false), [botId]);
  const botKnown = !!bot;
  useEffect(() => {
    if (!botKnown || hasHome) return;
    let live = true;
    openHomeChat(botId).then(
      (chat) => { if (live) upsertSession(chat); },
      (cause) => { if (live) { setError(errorMessage(cause)); setHomeFailed(true); } },
    );
    return () => { live = false; };
  }, [botId, botKnown, hasHome]);

  // The day's spend, read again whenever one of its sessions records usage, and when the day changes.
  const [spent, setSpent] = useState<{ usd: number; day: string } | null>(null);
  const spentKey = useMemo(() => usageKey([...chats, ...startedBy]), [chats, startedBy]);
  const [day, setDay] = useState(() => new Date().toDateString());
  useEffect(() => {
    const timer = window.setInterval(() => setDay(new Date().toDateString()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!botKnown) return;
    let live = true;
    botSpentToday(botId).then((value) => { if (live) setSpent(value); }, () => { if (live) setSpent(null); });
    return () => { live = false; };
  }, [botId, botKnown, spentKey, day]);

  const open = startedBy.find((chat) => chat.id === startedId) ?? [...chats, ...dutyRuns].find((chat) => chat.id === chatId) ?? chats[0] ?? null;
  const select = (chat: SessionEntry) => {
    setBriefOpen(false);
    if (chats.includes(chat) || dutyRuns.includes(chat)) selectSession(chat.id);
    else setStartedId(chat.id);
  };

  if (!bot) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-chat">
        <TitleStrip sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} inset={titlebarInset} />
        <p className="px-6 py-8 text-sm text-muted-foreground">
          {!bots.loaded ? "Reading the bots…" : bots.error ? `The bots cannot be read: ${bots.error}` : bots.unreadable > 0 ? "This bot cannot be read by this version of TerminalX." : "This bot is no longer here."}
        </p>
      </main>
    );
  }

  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    action().then(() => setError(null), (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  const newChat = () => act(async () => {
    const chat = await startBotChat(bot.id);
    upsertSession(chat);
    selectSession(chat.id);
  });

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-chat" aria-label={`${bot.name}, ${bot.roleTitle}`}>
      <TitleStrip sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} inset={titlebarInset} />
      <BotHeader bot={bot} working={working} asking={asking} spent={spentTodayLabel(spent?.usd ?? null)} busy={busy} onPause={() => act(() => pauseBot(bot.id))} onResume={() => act(() => resumeBot(bot.id))} harnessName={store.harnesses.find((harness) => harness.id === bot.harness)?.name ?? bot.harness} />
      <div role="tablist" aria-label={`${bot.name}'s view`} className="flex shrink-0 items-center gap-1 border-b border-hairline px-5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id);
              if (id === "home") setItem(null);
            }}
            className={cn("-mb-px flex h-9 items-center gap-1.5 border-b-2 px-2 text-[13px]", tab === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            <Icon className="size-3.5" /> {label}
            {id === "home" && trouble && <span className="text-[11px] font-medium text-destructive" title={`Couldn't read what needs you: ${trouble}`} data-testid="bot-home-count-error">!</span>}
            {id === "home" && !trouble && asking > 0 && <span className="text-[11px] font-medium text-accent" aria-label={`${asking} need you`} data-testid="bot-home-count">{asking}</span>}
          </button>
        ))}
      </div>
      {error && <MachineHostError error={error} onRestarted={() => setError(null)} onFailed={setError} className="shrink-0 px-5 py-2 text-xs" />}
      {tab === "chat" ? (
        <div role="tabpanel" aria-label="Chat" className="flex min-h-0 flex-1">
          <ChatList bot={bot} chats={chats} startedBy={startedBy} dutyRuns={dutyRuns} openId={briefOpen ? null : open?.id ?? null} onOpen={select} onNewChat={newChat} busy={busy} briefOpen={briefOpen} onOpenBrief={() => setBriefOpen(true)} />
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {bot.paused && (
              <PausedBanner bot={bot} busy={busy} onResume={() => act(() => resumeBot(bot.id))} onDismiss={() => act(() => botsApi.dismissResume(bot.id))} />
            )}
            {briefOpen ? (
              <ErrorBoundary label="the team brief"><TeamBriefEditor /></ErrorBoundary>
            ) : open ? (
              <ErrorBoundary key={open.id} label="the chat">
                <HandoffCards bot={bot} chatId={open.id} />
                <RunPlanCards bot={bot} chatId={open.id} chats={chats} />
                <SessionView session={open} sidebarOpen onToggleSidebar={onToggleSidebar} chrome={{ compact: true, leading: <span className="truncate px-1 text-sm text-foreground">{conversationTitle(open)}</span> }} />
              </ErrorBoundary>
            ) : (
              homeFailed ? (
                <p className="px-6 py-8 text-sm text-muted-foreground">The home chat could not be opened. Start a new chat, or open the bot again.</p>
              ) : (
                <p className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Opening the home chat…</p>
              )
            )}
          </section>
        </div>
      ) : tab === "home" ? (
        <div role="tabpanel" aria-label="Home" className="flex min-h-0 flex-1 flex-col">
          {item !== null ? <BotItemPage bot={bot} number={item} onBack={() => setItem(null)} /> : <BotHome bot={bot} onOpenItem={setItem} />}
        </div>
      ) : tab === "duties" ? (
        <div role="tabpanel" aria-label="Duties" className="flex min-h-0 flex-1 flex-col">
          {/* A duty's run opens on Chat, among the bot's duty runs. */}
          <BotDuties key={bot.id} bot={bot} onOpenSession={(sessionId) => { selectSession(sessionId); setTab("chat"); }} />
        </div>
      ) : tab === "role" ? (
        <div role="tabpanel" aria-label="Role and memory" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <ErrorBoundary key={bot.id} label="the role and memory">
            <BotRoleMemory bot={bot} bots={bots.bots} unreadable={bots.unreadable} />
          </ErrorBoundary>
        </div>
      ) : (
        <div role="tabpanel" aria-label="Settings" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-testid="bot-view-settings">
          <div className="px-8 py-4">
            <BotSettings bot={bot} />
          </div>
        </div>
      )}
    </main>
  );
}

function TitleStrip({ sidebarOpen, onToggleSidebar, inset }: { sidebarOpen: boolean; onToggleSidebar: () => void; inset: number }) {
  if (sidebarOpen) return null;
  return (
    <header data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center px-2" style={{ paddingLeft: inset }}>
      <WithTooltip label="Show sidebar" shortcut="app.toggleSidebar">
        <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}><PanelLeft /></Button>
      </WithTooltip>
    </header>
  );
}

/** "Working on 2 things · 2 need you", or Ready. */
function workLine(working: number, asking: number): string {
  const parts = [working > 0 ? `Working on ${working === 1 ? "1 thing" : `${working} things`}` : "", asking > 0 ? `${asking} need${asking === 1 ? "s" : ""} you` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Ready";
}

/** "Paused 18 minutes ago · 2 workers stopped": when, and what it holds, as its sidebar row says it (PRO-474). */
function pausedWorkLine(bot: Bot, held: PauseHeld | null): string {
  const status = pausedStatus(bot, held).replace(/^Paused( · )?/, "");
  return [`Paused ${relativeTime(bot.paused!.at)}`, status].filter(Boolean).join(" · ");
}

function BotHeader({ bot, working, asking, spent, busy, harnessName, onPause, onResume }: { bot: Bot; working: number; asking: number; spent: string; busy: boolean; harnessName: string; onPause: () => void; onResume: () => void }) {
  const full = effectiveAccess(bot.access) === "full";
  const held = usePauseHeld();
  return (
    <div data-tauri-drag-region="deep" className="flex shrink-0 flex-wrap items-center gap-3 px-5 pt-4 pb-3">
      <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-well text-primary hairline"><BotIcon className="size-5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-lg font-semibold text-foreground">{bot.name}</h1>
          <span className="truncate text-[13px] text-muted-foreground">{bot.roleTitle}</span>
        </div>
        <p className={cn("flex min-w-0 items-center gap-1.5 text-[12.5px]", bot.paused || asking > 0 ? "text-warning" : "text-muted-foreground")}>
          {bot.paused ? <Pause className="size-3.5 shrink-0" /> : working > 0 ? <Loader2 className="size-3.5 shrink-0" /> : <CircleDot className="size-3.5 shrink-0" />}
          <span className="truncate" data-testid="bot-work-line">{bot.paused ? pausedWorkLine(bot, held) : workLine(working, asking)}</span>
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Chip title="Agent and model"><Sparkles className="size-3" /> {harnessName}{bot.model ? ` · ${bot.model}` : ""}</Chip>
        <Chip title="Where it runs"><Laptop className="size-3" /> {runsOnLabel(bot)}</Chip>
        <Chip title="What it may do without asking" className={cn(full && "text-warning")}><ShieldOff className="size-3" /> {accessLabel(bot)}</Chip>
        <Chip title="What its sessions spent today, at Stats' prices, for information: bots have no budget">{spent}</Chip>
        {bot.paused ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={onResume}><Play /> Resume</Button>
        ) : (
          <Button size="xs" variant="outline" disabled={busy} onClick={onPause}><Pause /> Pause</Button>
        )}
        <BotMenu bot={bot} onDeleted={() => showBotsTeam(true)} />
      </div>
    </div>
  );
}

/**
 * A paused bot still answers a direct message (23.12), in plan mode, and the reply view says so. A resume asked for
 * from the `terminalx` CLI waits here for the owner: only this Resume applies it (PRO-468).
 */
function PausedBanner({ bot, busy, onResume, onDismiss }: { bot: Bot; busy: boolean; onResume: () => void; onDismiss: () => void }) {
  const asked = !!bot.resumeRequest;
  const bots = useBotStore().bots;
  const held = usePauseHeld();
  // Who paused it, from where and when, and what it held (PRO-474): "You paused it from your phone at 13:42, …".
  const by = pausedBySentence([bot], bots);
  const was = bot.paused?.stopped?.was;
  const holding = heldLine(bot, held);
  return (
    <div role="status" className="mx-4 mt-3 flex shrink-0 items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
      <Pause className="size-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 text-[12.5px] text-foreground">
        {asked ? (
          <>
            <span className="font-medium">Resume {bot.name}?</span> The terminalx command line asked to resume it. Only you can, here.
          </>
        ) : (
          <>
            <span className="font-medium">Paused.</span> <span data-testid="bot-paused-by">{by}</span>
            {was && was !== "was quiet" ? ` It ${was}.` : ""}
            {holding !== "Nothing held" ? <span data-testid="bot-paused-held"> {holding}.</span> : null} {bot.name} still answers you here, in plan mode, and
            says it is paused: it changes nothing and starts no sessions or runs until you resume it.
          </>
        )}
      </p>
      {asked && <Button size="xs" variant="ghost" disabled={busy} onClick={onDismiss}>Not now</Button>}
      <Button size="xs" variant="outline" disabled={busy} onClick={onResume}><Play /> Resume</Button>
    </div>
  );
}

/**
 * "Started by <bot>" (PRO-476, 23.04): the runs led from the bot's sessions, each as one row with where it is, and the
 * other sessions its chats started with their state. A run's workers are under its run, not rows of their own.
 */
export function startedRows(startedBy: SessionEntry[], chats: SessionEntry[], runsByLead: Record<string, Run | null>): { runs: { run: Run; lead: SessionEntry }[]; sessions: SessionEntry[] } {
  const leads = [...chats, ...startedBy];
  const runs = leads.flatMap((lead) => {
    const run = runsByLead[lead.id];
    return run ? [{ run, lead }] : [];
  });
  const hidden = new Set<string>();
  for (const { run, lead } of runs) {
    for (const id of workerSessions(run)) hidden.add(id);
    hidden.add(lead.id);
  }
  return { runs, sessions: startedBy.filter((session) => !hidden.has(session.id)) };
}

function ChatList({ bot, chats, startedBy, dutyRuns = [], openId, onOpen, onNewChat, busy, briefOpen = false, onOpenBrief }: {
  bot: Bot;
  chats: SessionEntry[];
  startedBy: SessionEntry[];
  dutyRuns?: SessionEntry[];
  openId: string | null;
  onOpen: (chat: SessionEntry) => void;
  onNewChat: () => void;
  busy: boolean;
  briefOpen?: boolean;
  onOpenBrief?: () => void;
}) {
  // The runs only with Settings → Experimental → Orchestrator runs on, as the sidebar shows them.
  const runsByLead = useRunsByLead(useExperimentalSettings()?.orchestratorRuns === true);
  const started = startedRows(startedBy, chats, runsByLead);
  return (
    <nav aria-label={`${bot.name}'s chats`} className="flex w-[236px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-hairline px-2 py-3">
      <ChatGroup label={`Chats with ${bot.name}`} action={
        <WithTooltip label="New chat">
          <Button variant="ghost" size="icon-xs" aria-label={`New chat with ${bot.name}`} disabled={busy} onClick={onNewChat}><MessageSquarePlus /></Button>
        </WithTooltip>
      }>
        {chats.map((chat) => <ChatRow key={chat.id} chat={chat} selected={chat.id === openId} onOpen={onOpen} home={!!chat.bot?.home} />)}
      </ChatGroup>
      {(started.runs.length > 0 || started.sessions.length > 0) && (
        <ChatGroup label={`Started by ${bot.name}`}>
          {started.runs.map(({ run, lead }) => <StartedRunRow key={run.id} goal={run.goal} state={runStateLine(run)} selected={lead.id === openId && !chats.includes(lead)} onOpen={() => onOpen(lead)} />)}
          {started.sessions.map((chat) => <ChatRow key={chat.id} chat={chat} selected={chat.id === openId} onOpen={onOpen} home={false} sub={startedStateLine(chat)} />)}
        </ChatGroup>
      )}
      {dutyRuns.length > 0 && (
        <ChatGroup label="Duty runs">
          {dutyRuns.slice(0, 20).map((chat) => <ChatRow key={chat.id} chat={chat} selected={chat.id === openId} onOpen={onOpen} home={false} />)}
        </ChatGroup>
      )}
      {onOpenBrief && (
        <ChatGroup label="Every bot reads">
          <TeamBriefRow selected={briefOpen} onOpen={onOpenBrief} />
        </ChatGroup>
      )}
    </nav>
  );
}

function ChatGroup({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <div className="flex h-6 items-center justify-between px-2">
        <h2 className="truncate text-[11px] font-medium tracking-wide text-faint uppercase">{label}</h2>
        {action}
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}
