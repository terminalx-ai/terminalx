import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { agentName } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { useStatus } from "@/lib/status";
import { checkAgentReadiness, type AgentReadiness } from "@/lib/agentReadiness";
import { agentAccounts } from "@/lib/agentAccounts";
import { accountFull, accountUsageNotice, agentAccountUsage, LOCAL_ACCOUNT, tabAccountFirst, windowIsStale, type AccountUsage } from "@/lib/accountUsage";
import { accountLabel, switchesIn, takesAccounts } from "@/lib/agentAccounts";
import { useAgentAccounts, useLaunchAccountChoice } from "@/lib/useSessionAgent";
import { tabAccount, type UsageWindow } from "@/lib/api";
import { formatResetCountdown, useCountdownNow } from "@/lib/statusTime";
import type { Turn } from "@/lib/transcript";
import type { TabEntry } from "@/types/session";

const panel = "z-(--z-menu) w-80 max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-auto rounded-xl bg-popover p-4 text-popover-foreground shadow-surface hairline outline-none";
const count = (value?: number) => value == null ? "Unavailable" : value.toLocaleString();
const money = (value: number) => value > 0 && value < 0.01 ? "< $0.01" : `$${value.toFixed(2)}`;

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-4 py-1"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-right tabular-nums">{children}</dd></div>;
}

/** Costs arrive priced per request by the same Rust table as Stats & Usage. */
export function sessionEstimate(turns: readonly Turn[]): { cost: number | null; partial: boolean } {
  const finished = turns.filter((turn) => turn.completed);
  const priced = finished.filter((turn) => turn.usage?.costUsd != null);
  return { cost: finished.length && !priced.length ? null : priced.reduce((sum, turn) => sum + turn.usage!.costUsd!, 0), partial: priced.length < finished.length };
}

function UsageWindows({ windows, now }: { windows: readonly UsageWindow[]; now: number }) {
  return <>{windows.map((window) => {
    const stale = windowIsStale(window, now);
    return <div key={window.key} className="py-1">
      <div className="flex justify-between gap-3"><span>{window.label}</span><span className="tabular-nums">{Math.round(window.usedPercent)}% used{stale ? " · Last known" : ""}</span></div>
      {window.resetsAt != null && <p className="mt-0.5 text-muted-foreground">{window.resetsAt <= now ? "Window expired; awaiting update" : `Resets ${formatResetCountdown(window.resetsAt, now, "")}`}</p>}
    </div>;
  })}</>;
}

/** "Full" beside an account automatic switching would move tabs off (#981). */
function FullMark({ account, threshold, now }: { account: AccountUsage; threshold: number | null; now: number }) {
  if (threshold == null || !accountFull(account, threshold, now)) return null;
  return <span className="ml-1.5 shrink-0 rounded-sm bg-warning/15 px-1 text-[11px] text-warning" title={`At or past ${threshold}% of a window`} data-testid="account-full">Full</span>;
}

function AccountDetails({ agent, local, accountId }: { agent: string; local: boolean; accountId: string | null }) {
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
  return <>
    <dl className="text-xs">
      {own && <Detail label="Account"><span className="inline-flex items-baseline">{own.label}<FullMark account={own} threshold={threshold} now={now} /></span></Detail>}
      <Detail label="Login method">{local ? account?.loginMethod ?? (account?.state === "signed_out" ? "Signed out" : "Unavailable") : "Unavailable in this workspace"}</Detail>
      <Detail label="Plan">{local ? account?.plan ?? "Unavailable" : "Unavailable"}</Detail>
    </dl>
    <div className="mt-3 border-t border-hairline pt-3 text-xs">
      <p className="mb-1 font-medium">{own ? `${agentName(agent)} usage · ${own.label}` : `${agentName(agent)} account usage`}</p>
      {!windows.length && <p className="text-muted-foreground">{own ? ownNotice ?? "Usage windows unavailable" : local ? "Usage windows unavailable" : "Usage windows unavailable in this workspace"}</p>}
      <UsageWindows windows={windows} now={now} />
    </div>
    {accounts.length > 1 && <div className="mt-3 border-t border-hairline pt-3 text-xs" aria-label={`Other ${agentName(agent)} accounts`}>
      <p className="mb-1 font-medium">Other {agentName(agent)} accounts</p>
      {accounts.slice(1).map((other) => <section key={other.accountId} className="py-1" aria-label={other.label}>
        <p className="flex min-w-0 items-baseline text-muted-foreground" title={other.label}><span className="truncate">{other.label}</span><FullMark account={other} threshold={threshold} now={now} /></p>
        {accountUsageNotice(other) && <p className="text-muted-foreground">{accountUsageNotice(other)}</p>}
        <UsageWindows windows={other.windows} now={now} />
      </section>)}
    </div>}
    {newSessions && <p className="mt-3 border-t border-hairline pt-3 text-xs text-muted-foreground" data-testid="new-sessions-account">
      New sessions start on {newSessions}{moved?.reason ? `: ${moved.reason}.` : "."}
    </p>}
  </>;
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
  const compact = async () => {
    if (pending.current || compactDisabled || compacting) return;
    pending.current = true;
    setSending(true);
    setError(false);
    try { await onCompact(); setOpen(false); }
    catch { setError(true); }
    finally { pending.current = false; setSending(false); }
  };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" aria-label={percent == null ? "Context details" : `Context ${percent}% used`} title={percent == null ? "No context data yet · Context and session details" : "Context and session details"} className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-veil-raised focus-visible:outline focus-visible:outline-ring">
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--hairline-strong)" strokeWidth="2" />
          <circle cx="8" cy="8" r="6" fill="none" stroke={(percent ?? 0) > 85 ? "var(--destructive)" : (percent ?? 0) > 65 ? "var(--warning)" : "var(--ink-muted)"} strokeWidth="2" strokeDasharray={`${((percent ?? 0) / 100) * 37.7} 37.7`} strokeLinecap="round" />
        </svg>
      </button>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content side="top" align="end" sideOffset={8} className={panel} aria-label="Context and session details">
      <h3 className="mb-2 text-sm font-medium">Context and session</h3>
      <dl className="text-xs">
        <Detail label="Context used">{count(used)} / {count(max)}</Detail>
        <Detail label="Requested model">{tab.requestedModel || tab.model || "Default"}</Detail>
        <Detail label="Reported model">{reportedModel || "Not reported"}</Detail>
        <Detail label="Effort">{tab.requestedEffort ?? tab.effort ?? "Default"}</Detail>
        <Detail label="Session cost (estimate)">{estimate.cost == null ? "Unavailable" : `${money(estimate.cost)}${estimate.partial ? " · Partial" : ""}`}</Detail>
      </dl>
      <p className="mt-1 text-[11px] text-muted-foreground">Recorded finished turns for the main agent only, at API prices. Subscription charges may differ.{estimate.partial ? " Some turns have no price or usage data." : ""}</p>
      <AccountDetails key={`${local}:${tab.harness}`} agent={tab.harness} local={local} accountId={tabAccount(tab)} />
      {(tab.harness === "claude" || tab.harness === "codex") && <Button size="sm" variant="outline" className="mt-4 w-full" disabled={compactDisabled || compacting || sending} onClick={() => void compact()}>{compacting ? "Compacting…" : sending ? "Sending…" : "Compact now"}</Button>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">Could not send /compact. Try again.</p>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

function time(value: string) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "Unavailable";
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

export function TurnDetailsPopover({ turn, children }: { turn: Turn; children: ReactNode }) {
  if (!turn.completed || turn.live) return null;
  const usage = turn.usage;
  const input = usage?.inputTokens;
  const read = usage?.cacheReadTokens;
  const write = usage?.cacheWriteTokens;
  const prompt = input != null && read != null && write != null ? input + read + write : null;
  const hit = prompt != null && prompt > 0 ? `${((read! / prompt) * 100).toFixed(1)}%` : "Unavailable";
  const ms = turn.completed.durationMs;
  const speed = ms != null && ms > 0 && usage?.outputTokens != null ? `${(usage.outputTokens / (ms / 1000)).toFixed(1)} tokens/s` : "Unavailable";
  return <Popover.Root>
    <Popover.Trigger asChild><button type="button" aria-label="Turn details" className="flex items-center gap-1.5 rounded px-1 -ml-1 hover:bg-veil-raised focus-visible:outline focus-visible:outline-ring">{children}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content side="top" align="start" sideOffset={6} className={panel} aria-label="Turn details">
      <h3 className="mb-2 text-sm font-medium">Turn details</h3>
      <dl className="text-xs">
        <Detail label="Agent">{turn.agent ? agentName(turn.agent) : "Unavailable"}</Detail>
        <Detail label="Model">{usage?.model ?? turn.model ?? "Not reported"}</Detail>
        <Detail label="Started">{time(turn.ts)}</Detail>
        <Detail label="Ended">{time(turn.completed.ts)}</Detail>
        <Detail label="Input (uncached)">{count(input)}</Detail>
        <Detail label="Output">{count(usage?.outputTokens)}</Detail>
        <Detail label="Cache read">{count(read)}</Detail>
        <Detail label="Cache write">{count(write)}</Detail>
        <Detail label="Cache hit rate">{hit}</Detail>
        <Detail label="Avg output rate">{speed}</Detail>
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">Average output rate uses the full turn duration, including tool calls.</p>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
