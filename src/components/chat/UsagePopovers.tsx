import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { AgentMark, agentName } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { Shrink, TriangleAlert } from "@/icons";
import { useStatus } from "@/lib/status";
import { checkAgentReadiness, type AgentReadiness } from "@/lib/agentReadiness";
import { agentAccounts } from "@/lib/agentAccounts";
import { accountFull, accountUsageNotice, agentAccountUsage, LOCAL_ACCOUNT, tabAccountFirst, windowIsStale, type AccountUsage } from "@/lib/accountUsage";
import { accountLabel, switchesIn, takesAccounts } from "@/lib/agentAccounts";
import { useAgentAccounts, useLaunchAccountChoice } from "@/lib/useSessionAgent";
import { tabAccount, type UsageWindow } from "@/lib/api";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { cn } from "@/lib/cn";
import { EFFORT_LABEL, modelLabel, pickerMode } from "@/lib/models";
import { formatResetCountdown, useCountdownNow } from "@/lib/statusTime";
import type { Turn } from "@/lib/transcript";
import type { TabEntry } from "@/types/session";

const panelBase = "z-(--z-menu) max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-auto rounded-xl bg-popover text-popover-foreground shadow-surface hairline outline-none";
/** At least or above this share of a window, its percentage and bar turn amber and the popover warns. */
const HIGH_USAGE = 80;
const count = (value?: number) => value == null ? "Unavailable" : value.toLocaleString();
const money = (value: number) => value > 0 && value < 0.01 ? "< $0.01" : `$${value.toFixed(2)}`;
/** 312000 → "312K", 1000000 → "1M". */
const compact = (value: number) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}K` : `${value}`;
const capital = (value: string) => value ? value[0]!.toUpperCase() + value.slice(1) : value;
const effortLabel = (effort: string) => EFFORT_LABEL[effort] ?? capital(effort);
const PROVIDERS: Record<string, string> = { claude: "Anthropic", codex: "OpenAI", cursor: "Cursor", opencode: "OpenCode" };
/** What a plan is called by the people who sell it: "max" → "Claude Max". */
const PLAN_BRANDS: Record<string, string> = { claude: "Claude", codex: "ChatGPT" };

function planLabel(agent: string, plan: string): string {
  const named = plan.split(/[\s_-]+/).map(capital).join(" ");
  const brand = PLAN_BRANDS[agent];
  return brand && !named.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${named}` : named;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-4 py-1"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-right tabular-nums">{children}</dd></div>;
}

function Bar({ percent, high, label }: { percent: number; high: boolean; label: string }) {
  return <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 w-full overflow-hidden rounded-full bg-hairline-strong">
    <div className={cn("h-full rounded-full", high ? "bg-warning" : "bg-accent")} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
  </div>;
}

/** Costs arrive priced per request by the same Rust table as Stats & Usage. */
export function sessionEstimate(turns: readonly Turn[]): { cost: number | null; partial: boolean } {
  const finished = turns.filter((turn) => turn.completed);
  const priced = finished.filter((turn) => turn.usage?.costUsd != null);
  return { cost: finished.length && !priced.length ? null : priced.reduce((sum, turn) => sum + turn.usage!.costUsd!, 0), partial: priced.length < finished.length };
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "Resets at 16:00 · in 1h 28m" within a day; "Resets Sat 11:00" further out. */
export function resetLabel(resetsAt: number, now: number): string {
  if (resetsAt - now < 24 * 3600_000) return `Resets at ${clock(resetsAt)} · in ${formatResetCountdown(resetsAt, now, "")}`;
  return `Resets ${new Date(resetsAt).toLocaleDateString(undefined, { weekday: "short" })} ${clock(resetsAt)}`;
}

function UsageWindows({ windows, now }: { windows: readonly UsageWindow[]; now: number }) {
  return <>{windows.map((window) => {
    const stale = windowIsStale(window, now);
    const percent = Math.round(window.usedPercent);
    const high = percent >= HIGH_USAGE;
    return <div key={window.key} className="py-1.5">
      <div className="mb-1.5 flex justify-between gap-3">
        <span>{window.label}</span>
        <span className={cn("tabular-nums", high ? "text-warning" : "text-muted-foreground")}>{percent}%{stale ? " · Last known" : ""}</span>
      </div>
      <Bar percent={percent} high={high} label={`${window.label} used`} />
      {window.resetsAt != null && <p className="mt-1.5 text-muted-foreground">{window.resetsAt <= now ? "Window expired; awaiting update" : resetLabel(window.resetsAt, now)}</p>}
    </div>;
  })}</>;
}

/** "Full" beside an account automatic switching would move tabs off (#981). */
function FullMark({ account, threshold, now }: { account: AccountUsage; threshold: number | null; now: number }) {
  if (threshold == null || !accountFull(account, threshold, now)) return null;
  return <span className="ml-1.5 shrink-0 rounded-sm bg-warning/15 px-1 text-xs text-warning" title={`At or past ${threshold}% of a window`} data-testid="account-full">Full</span>;
}

function AccountDetails({ agent, local, accountId, settings }: { agent: string; local: boolean; accountId: string | null; settings: ReactNode }) {
  const { usage } = useStatus();
  // Automatic switching (#981): full accounts are marked, and where new sessions start is said.
  const view = useAgentAccounts(local && takesAccounts(agent) ? agent : null);
  const switching = switchesIn(view, null);
  const threshold = switching ? view!.autoSwitch!.setting.threshold : null;
  const moved = useLaunchAccountChoice(switching ? agent : null, view, null, view?.defaultAccount ?? null);
  const newSessions = switching ? moved?.label ?? accountLabel(view, view?.defaultAccount) : null;
  const [account, setAccount] = useState<AgentReadiness | null>(null);
  // With several accounts (#980): the tab's own first, under its label, then the others.
  const accounts = local ? tabAccountFirst(agentAccountUsage(usage, agent), accountId) : [];
  const own = accounts[0];
  const readOwn = own && own.accountId !== LOCAL_ACCOUNT ? own.accountId : null;
  useEffect(() => {
    if (!local) return;
    let current = true;
    const read = readOwn ? agentAccounts.readiness(agent, readOwn) : checkAgentReadiness(agent);
    void read.then((answer) => { if (current) setAccount(answer); }, () => { if (current) setAccount(null); });
    return () => { current = false; };
  }, [agent, local, readOwn]);
  const windows = own ? own.windows : local ? usage.windows.filter((window) => window.agent === agent) : [];
  const now = useCountdownNow([...windows, ...accounts.slice(1).flatMap((other) => other.windows)].flatMap((window) => [window.resetsAt, window.updatedAt + 30 * 60_000]));
  const ownNotice = own ? accountUsageNotice(own) : null;
  const plan = local && account?.plan ? planLabel(agent, account.plan) : null;
  const refreshed = windows.length ? Math.max(...windows.map((window) => window.updatedAt)) : null;
  const close = windows.find((window) => window.usedPercent >= HIGH_USAGE && !(window.resetsAt != null && window.resetsAt <= now));
  const signedIn = !local ? "Unavailable in this workspace"
    : account?.state === "signed_out" ? "Signed out"
      : [own?.label && own.accountId !== LOCAL_ACCOUNT ? own.label : account?.account ?? account?.loginMethod, plan].filter(Boolean).join(" · ") || "Unavailable";
  return <>
    <section className="border-t border-hairline px-4 py-3 text-xs" aria-label={`${agentName(agent)} usage`}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <p className="font-medium">{own && own.accountId !== LOCAL_ACCOUNT ? `${agentName(agent)} usage · ${own.label}` : `${agentName(agent)} usage`}</p>
        {(plan || refreshed) && <p className="truncate text-faint">{[plan && `${plan.replace(/^(Claude|ChatGPT) /, "")} plan`, refreshed && `refreshed ${clock(refreshed)}`].filter(Boolean).join(" · ")}</p>}
      </div>
      {!windows.length && <p className="text-muted-foreground">{own ? ownNotice ?? "Usage windows unavailable" : local ? "Usage windows unavailable" : "Usage windows unavailable in this workspace"}</p>}
      <UsageWindows windows={windows} now={now} />
      {close && <p role="status" className="mt-1.5 flex items-center gap-1.5 text-warning"><TriangleAlert className="size-3.5 shrink-0" />You're close to your {close.label.replace(/ window$/i, "")} limit.</p>}
    </section>
    {accounts.length > 1 && <section className="border-t border-hairline px-4 py-3 text-xs" aria-label={`Other ${agentName(agent)} accounts`}>
      <p className="mb-1 font-medium">Other {agentName(agent)} accounts</p>
      {accounts.slice(1).map((other) => <section key={other.accountId} className="py-1" aria-label={other.label}>
        <p className="flex min-w-0 items-baseline text-muted-foreground" title={other.label}><span className="truncate">{other.label}</span><FullMark account={other} threshold={threshold} now={now} /></p>
        {accountUsageNotice(other) && <p className="text-muted-foreground">{accountUsageNotice(other)}</p>}
        <UsageWindows windows={other.windows} now={now} />
      </section>)}
    </section>}
    <dl className="border-t border-hairline px-4 py-2 text-xs">
      <Detail label="Signed in"><span className="inline-flex items-baseline">{signedIn}{own && <FullMark account={own} threshold={threshold} now={now} />}</span></Detail>
      {settings}
    </dl>
    {newSessions && <p className="border-t border-hairline px-4 py-3 text-xs text-muted-foreground" data-testid="new-sessions-account">
      New sessions start on {newSessions}{moved?.reason ? `: ${moved.reason}.` : "."}
    </p>}
  </>;
}

/** A model by its name, its id beside it in mono: "Opus 5.5 claude-opus-5-5[1m]". Never the id alone. */
function ModelName({ harness, id }: { harness: string; id: string }) {
  const name = modelLabel(harness, id.replace(/\[[^\]]*\]$/, ""));
  return <span className="inline-flex min-w-0 items-baseline gap-1.5"><span>{name}</span>{name !== id && <span className="truncate font-mono text-faint">{id}</span>}</span>;
}

export function ContextPopover({ tab, used, max, reportedModel, local, turns, compacting, compactDisabled, onCompact }: {
  tab: TabEntry;
  used?: number;
  max?: number;
  reportedModel?: string | null;
  local: boolean;
  turns: readonly Turn[];
  compacting: boolean;
  compactDisabled: boolean;
  onCompact: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState(false);
  const estimate = useMemo(() => sessionEstimate(turns), [turns]);
  const percent = used != null && max != null && max > 0 ? Math.min(100, Math.max(0, Math.round(used / max * 100))) : null;
  const ring = (percent ?? 0) > 85 ? "var(--destructive)" : (percent ?? 0) > 65 ? "var(--warning)" : "var(--ink-muted)";
  const model = reportedModel || tab.requestedModel || tab.model;
  const effort = tab.requestedEffort ?? tab.effort;
  const fast = [...turns].reverse().find((turn) => turn.usage?.fast != null)?.usage?.fast;
  const runCompact = async () => {
    if (pending.current || compactDisabled || compacting) return;
    pending.current = true;
    setSending(true);
    setError(false);
    try { await onCompact(); setOpen(false); }
    catch { setError(true); }
    finally { pending.current = false; setSending(false); }
  };
  const settings = <>
    {PROVIDERS[tab.harness] && <Detail label="Provider">{PROVIDERS[tab.harness]}</Detail>}
    <Detail label="Model">{model ? <ModelName harness={tab.harness} id={model} /> : "Default"}</Detail>
    {fast == null
      ? <Detail label="Effort">{effort ? effortLabel(effort) : "Default"}</Detail>
      : <Detail label="Effort · Fast">{effort ? effortLabel(effort) : "Default"} · {fast ? "On" : "Off"}</Detail>}
    <Detail label="This session so far">{estimate.cost == null ? "Unavailable" : <>{money(estimate.cost)} <span className="text-faint">{estimate.partial ? "estimated · partial" : "estimated"}</span></>}</Detail>
  </>;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" aria-label={percent == null ? "Context details" : `Context ${percent}% used`} title={percent == null ? "No context data yet · Context and session details" : "Context and session details"}
        className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground hover:bg-veil-raised focus-visible:outline focus-visible:outline-ring data-[state=open]:bg-veil-strong data-[state=open]:text-foreground">
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--hairline-strong)" strokeWidth="2" />
          <circle cx="8" cy="8" r="6" fill="none" stroke={ring} strokeWidth="2" strokeDasharray={`${((percent ?? 0) / 100) * 37.7} 37.7`} strokeLinecap="round" />
        </svg>
        {percent != null && <span aria-hidden="true">{percent}%</span>}
      </button>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content side="top" align="end" sideOffset={8} className={cn(panelBase, "w-[390px]")} aria-label="Context and session details">
      <section className="px-4 py-3 text-xs" aria-label="Context">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="font-medium">Context</span>
          <span className="font-mono tabular-nums text-muted-foreground">{used != null && max != null ? `${compact(used)} of ${compact(max)}${percent != null ? ` · ${percent}%` : ""}` : "No context data yet"}</span>
        </div>
        <Bar percent={percent ?? 0} high={(percent ?? 0) > 85} label="Context used" />
        {used != null && max != null && <p className="sr-only">{count(used)} of {count(max)} tokens</p>}
        {(tab.harness === "claude" || tab.harness === "codex") && <div className="mt-3 flex items-center gap-2.5">
          <Button size="sm" disabled={compactDisabled || compacting || sending} onClick={() => void runCompact()}><Shrink />{compacting ? "Compacting…" : sending ? "Sending…" : "Compact now"}</Button>
          <span className="min-w-0 text-muted-foreground">Types /compact into {cloudAgentLabel(tab.harness)}</span>
        </div>}
        {error && <p role="alert" className="mt-2 text-destructive">Could not send /compact. Try again.</p>}
      </section>
      <AccountDetails key={`${local}:${tab.harness}`} agent={tab.harness} local={local} accountId={tabAccount(tab)} settings={settings} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const second = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** "Thu 5 Nov · 14:21:04 → 14:22:16"; the second day is named when the turn ran past midnight. */
export function turnRange(start: string, end: string): string | null {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from)) return null;
  if (!Number.isFinite(to)) return `${day(from)} · ${second(from)}`;
  return `${day(from)} · ${second(from)} → ${day(to) === day(from) ? "" : `${day(to)} · `}${second(to)}`;
}

/** A settled turn's cache hit (whole percent) and average output rate (whole tokens a second), when it reported them. */
export function turnStats(turn: Turn): { cacheHit: number | null; tokensPerSecond: number | null } {
  const usage = turn.usage;
  const prompt = usage?.inputTokens != null && usage.cacheReadTokens != null && usage.cacheWriteTokens != null ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : null;
  const ms = turn.completed?.durationMs;
  return {
    cacheHit: prompt != null && prompt > 0 ? Math.round((usage!.cacheReadTokens! / prompt) * 100) : null,
    tokensPerSecond: ms != null && ms > 0 && usage?.outputTokens != null ? Math.round(usage.outputTokens / (ms / 1000)) : null,
  };
}


/** What a turn ran with when its own record does not say: the tab's settings, unless they changed after it. */
export interface TurnFallback {
  effort?: string | null;
  permissionMode?: string | null;
  /** Settings a later change makes unknown for turns without their own record. */
  changed?: { effort?: boolean; permissionMode?: boolean };
}

function Tile({ value, label }: { value: string; label: string }) {
  return <div className="flex min-w-0 flex-col items-center rounded-lg bg-veil-raised px-1 py-2 text-center">
    <span className="font-mono text-[13px] tabular-nums">{value}</span>
    <span className="whitespace-nowrap text-xs text-muted-foreground">{label}</span>
  </div>;
}

export function TurnDetailsPopover({ turn, fallback, label, children }: { turn: Turn; fallback?: TurnFallback; label?: string; children: ReactNode }) {
  if (!turn.completed || turn.live) return null;
  const usage = turn.usage;
  const input = usage?.inputTokens;
  const read = usage?.cacheReadTokens;
  const write = usage?.cacheWriteTokens;
  // The same figures as the footer beside it (PRO-378).
  const stats = turnStats(turn);
  const hit = stats.cacheHit != null ? `${stats.cacheHit}%` : "–";
  const speed = stats.tokensPerSecond != null ? `${stats.tokensPerSecond}/s` : "–";
  const cost = usage?.costUsd != null ? money(usage.costUsd) : "–";
  const harness = turn.agent ?? "";
  const model = usage?.model ?? turn.model;
  const effort = usage?.effort ?? turn.settings?.effort ?? (fallback?.changed?.effort ? null : fallback?.effort);
  const mode = turn.settings?.permissionMode ?? (fallback?.changed?.permissionMode ? null : fallback?.permissionMode);
  const range = turnRange(turn.ts, turn.completed.ts);
  return <Popover.Root>
    <Popover.Trigger asChild><button type="button" aria-label={label ? `Turn details: ${label}` : "Turn details"} className="-ml-1 flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-veil-raised hover:text-muted-foreground focus-visible:outline focus-visible:outline-ring data-[state=open]:bg-veil-strong data-[state=open]:text-foreground">{children}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content side="top" align="start" sideOffset={6} className={cn(panelBase, "w-[320px] p-4")} aria-label="Turn details">
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
        {harness && <AgentMark id={harness} decorative className="size-4" />}
        <span className="truncate">{[harness ? cloudAgentLabel(harness) : "Agent", model ? modelLabel(harness, model) : null].filter(Boolean).join(" · ")}</span>
      </div>
      {(range || model) && <p className="mt-1 truncate font-mono text-xs text-faint" title={model ?? undefined}>{range ?? model}</p>}
      <dl className="mt-3 border-t border-hairline pt-2 text-xs">
        <Detail label="Effort">{effort ? effortLabel(effort) : "Not recorded"}</Detail>
        <Detail label="Fast mode">{usage?.fast == null ? "Not recorded" : usage.fast ? "On" : "Off"}</Detail>
        <Detail label="Permission mode">{mode ? pickerMode(mode)?.label ?? mode : "Not recorded"}</Detail>
      </dl>
      <div className="mt-2 border-t border-hairline pt-3 text-xs">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">Tokens this turn</p>
        <dl>
          <Detail label="Input">{count(input)}</Detail>
          <Detail label="Output">{count(usage?.outputTokens)}</Detail>
          <Detail label="Cache read">{count(read)}</Detail>
          <Detail label="Cache write">{count(write)}</Detail>
        </dl>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-hairline pt-3">
        <Tile value={hit} label="cache hit" />
        <Tile value={speed} label="output tokens" />
        <Tile value={cost} label="estimated" />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Cost is an estimate at API prices, not your bill.</p>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
