import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  Activity,
  Bot,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  Database,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Sparkles,
} from "@/icons";
import { AgentMark, agentName } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { RegisteredSetting } from "@/components/settings/settingsRegistry";
import { SettingsHeaderActions } from "@/components/settings/settingsHeaderActions";
import { WithTooltip } from "@/components/ui/tooltip";
import type { AppStats, ProviderUsage, StatsUsageSnapshot } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatAgentTime, formatCost, formatTokens, heatmapDays } from "@/lib/stats";
import { statsUsageStore } from "@/lib/statsUsageStore";
import { useStatus } from "@/lib/status";
import { formatResetCountdown, useCountdownNow } from "@/lib/statusTime";
import { accountUsageNotice, usageByAgent, windowIsStale, type AccountUsage } from "@/lib/accountUsage";

const LEVELS = ["bg-veil-raised", "bg-muted-foreground/25", "bg-muted-foreground/45", "bg-muted-foreground/70", "bg-foreground/85"];

/**
 * Settings → Stats & usage (PRO-463, design 09.44): the activity totals, each account's usage limits and the
 * local usage analytics. Settings draws the page's title and description; Refresh sits beside them.
 */
export function StatsUsageView() {
  const { snapshot, activity: currentActivity, refreshing: loading, error, activityError, initialized } = useSyncExternalStore(
    statsUsageStore.subscribe, statsUsageStore.getSnapshot,
  );
  const activity = currentActivity ?? snapshot?.app;
  const activityNotice = activityError ?? activity?.accountingError;
  // Reading again can fix a failed read, never an accounting notice: the
  // runtime takes back a held lease, or retries a save, by itself (#767).
  const retryable = Boolean(error || activityError);
  const load = statsUsageStore.refresh;
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="@container">
      <SettingsHeaderActions>
        <span role="status" aria-live="polite" className="self-center text-xs text-muted-foreground empty:hidden">
          {loading ? "Refreshing…" : ""}
        </span>
        <WithTooltip label="Refresh local analytics">
          <Button variant="outline" size="sm" aria-label="Refresh local analytics" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
          </Button>
        </WithTooltip>
      </SettingsHeaderActions>

      {(error || activityNotice) && (
        <div role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error && <p>Could not refresh local usage: {error}</p>}
          {activityNotice && <p>{activityNotice}</p>}
          {retryable && <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()} disabled={loading}>Retry</Button>}
        </div>
      )}
      <RegisteredSetting setting="stats.activity">
        <section aria-label="Activity" className="outline-none">
          {activity && <>
            {(activityError || (error && !currentActivity)) && <p className="mb-3 text-xs text-muted-foreground">Saved activity — could not refresh; values may be out of date.</p>}
            <ActivityContents activity={activity} />
          </>}
        </section>
      </RegisteredSetting>
      <RegisteredSetting setting="stats.accountLimits">
        <div className="outline-none"><AccountsUsage /></div>
      </RegisteredSetting>
      <RegisteredSetting setting="stats.analytics">
        <section aria-label="Usage analytics" className="outline-none">
          {snapshot && error && <p className="mt-6 text-xs text-muted-foreground">Saved usage — could not refresh; values may be out of date.</p>}
          {snapshot && loading && <p className="mt-6 text-xs text-muted-foreground">Saved usage — refresh in progress; values may be out of date.</p>}
          {snapshot && <StatsContents snapshot={snapshot} />}
          {!snapshot && initialized && loading ? <LoadingState /> : null}
        </section>
      </RegisteredSetting>
    </div>
  );
}

/** Each subscription account's windows under its label (#980); nothing with one account per agent. */
function AccountsUsage() {
  const { usage } = useStatus();
  const groups = usageByAgent(usage);
  const now = useCountdownNow(groups.flatMap((group) => group.accounts.flatMap((account) => account.windows.flatMap((window) => [window.resetsAt, window.updatedAt + 30 * 60_000]))));
  if (!groups.length) return null;
  return (
    <section className="mt-7" aria-labelledby="account-usage-heading">
      <h2 id="account-usage-heading" className="text-sm font-semibold">Usage limits by account</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Each signed-in account&apos;s current windows, read with that account&apos;s own login.</p>
      {groups.map((group) => (
        <div key={group.agent} className="mt-4">
          <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <AgentMark id={group.agent} className="size-3.5" decorative /> {agentName(group.agent)}
          </h3>
          <div className="mt-2 grid gap-3 @min-[760px]:grid-cols-2">
            {group.accounts.map((account) => <AccountCard key={account.accountId} account={account} now={now} />)}
          </div>
        </div>
      ))}
    </section>
  );
}

function AccountCard({ account, now }: { account: AccountUsage; now: number }) {
  const notice = accountUsageNotice(account);
  return (
    <article className="min-w-0 rounded-xl bg-background/30 p-4 hairline" aria-label={account.label}>
      <h4 className="truncate text-sm font-semibold" title={account.label}>{account.label}</h4>
      {notice && <p className="mt-2 text-xs text-muted-foreground">{notice}</p>}
      {account.windows.map((window) => {
        const stale = windowIsStale(window, now);
        return (
          <div key={window.key} className="mt-3 text-xs">
            <div className="flex justify-between gap-3">
              <span>{window.label}</span>
              <span className="tabular-nums">{Math.round(window.usedPercent)}% used{stale ? " · Last known" : ""}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-veil-raised">
              <div className="h-full rounded-full bg-foreground/75" style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
            </div>
            {window.resetsAt != null && <p className="mt-0.5 text-[11px] text-faint">{window.resetsAt <= now ? "Window expired; awaiting update" : `Resets ${formatResetCountdown(window.resetsAt, now, "")}`}</p>}
          </div>
        );
      })}
    </article>
  );
}

function LoadingState() {
  return (
    <div className="mt-6 flex min-h-64 items-center justify-center rounded-2xl bg-well/50 hairline" aria-busy="true">
      <div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-faint" />
        <span>Reading local transcripts…</span>
        <span className="max-w-sm text-xs text-faint">The first scan can take a moment. Later visits show your saved data while refreshing.</span>
      </div>
    </div>
  );
}

function ActivityContents({ activity }: { activity: AppStats }) {
  return (
    <>
        <div className="grid gap-3 @min-[520px]:grid-cols-3">
          <MetricCard icon={<Bot />} value={activity.agentsSpawned.toLocaleString()} label="Agents spawned" />
          <MetricCard icon={<Clock3 />} value={formatAgentTime(activity.agentTimeMs)} label="Time agents worked" />
          <MetricCard icon={<GitPullRequest />} value={activity.prsCreated.toLocaleString()} label="PRs created" />
        </div>
        <p className="mt-4 px-1 text-xs text-muted-foreground">
          {activity.trackingSince ? `Tracking since ${formatDate(activity.trackingSince)}` : "Tracking starts with the first recorded activity"}
        </p>
        <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
          Lifetime activity on this installation. Agents spawned counts each live start of work, including another turn or resuming after a wait in the same conversation. Working time excludes waits and idle time. PRs include those discovered on tracked workspace branches, including merged and closed PRs.
        </p>
        <p className="mt-2 px-1 text-[11px] leading-relaxed text-faint">
          Earlier activity is recovered from surviving local history. Deleted history and unrecorded work cannot be fully reconstructed.
        </p>
    </>
  );
}

function StatsContents({ snapshot }: { snapshot: StatsUsageSnapshot }) {
  const heatmap = useMemo(() => heatmapDays(snapshot.daily, snapshot.rangeEnd ? new Date(`${snapshot.rangeEnd}T12:00:00`) : new Date(snapshot.updatedAt), 30), [snapshot.daily, snapshot.updatedAt, snapshot.rangeEnd]);
  const best = heatmap.reduce((winner, day) => day.totalTokens > winner.totalTokens ? day : winner, heatmap[0]);
  const incompleteScope = !!snapshot.discoveryWarnings?.length;
  const enabled = snapshot.providers.filter((provider) => provider.enabled);
  const withData = enabled.filter((provider) => provider.hasData).length;
  const sessions = enabled.reduce((total, provider) => total + provider.sessions, 0);

  return (
    <>
        <div className="mb-3 mt-7 flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-sm font-semibold">Usage analytics</h2>
          <span className="text-xs text-muted-foreground">local Claude and Codex histories</span>
        </div>

        <section className="rounded-xl bg-background/35 p-4 hairline @min-[760px]:p-5" aria-labelledby="usage-overview-heading">
          <div className="flex items-start gap-3">
            <div>
              <h3 id="usage-overview-heading" className="text-sm font-semibold">Usage overview</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Latest 30 local calendar dates as of the saved refresh · Known TerminalX projects and worktrees, including non-Git folders · Last successful refresh {formatTimestamp(snapshot.updatedAt)}</p>
            </div>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">{formatDate(snapshot.rangeStart ?? heatmap[0].day)} – {formatDate(snapshot.rangeEnd ?? heatmap.at(-1)!.day)} · Local transcripts and previously recorded usage; deleting history does not erase recorded totals or refund provider usage. Unrecorded deleted history cannot be recovered.</p>
          {!!snapshot.discoveryWarnings?.length && <div role="alert" className="mt-3 text-sm text-destructive">
            <p>Incomplete location coverage — some worktrees could not be discovered. Available locations were refreshed.</p>
            {snapshot.discoveryWarnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>}
          <div className="mt-4 grid gap-3 @min-[540px]:grid-cols-2 @min-[940px]:grid-cols-4">
            <MetricCard compact icon={<Sparkles />} value={formatTokens(snapshot.totalTokens)} label="Total tokens" />
            <MetricCard
              compact
              icon={<CircleDollarSign />}
              value={formatCost(snapshot.estimatedCostUsd)}
              label={snapshot.hasPartialCost || incompleteScope ? "Partial estimated cost" : "Estimated cost"}
            />
            <MetricCard compact icon={<CalendarDays />} value={snapshot.activeDays.toLocaleString()} label="Active days" />
            <MetricCard compact icon={<Database />} value={snapshot.cacheShare == null ? "—" : `${Math.round(snapshot.cacheShare * 100)}%`} label="Cache share" />
          </div>

          {snapshot.hasPartialCost && <p className="mt-2 text-xs text-muted-foreground">Partial estimate: usage with unknown model prices, unsupported service tiers, or missing request detail is omitted from dollars, but included in tokens.</p>}
          <div className="mt-4 grid gap-3 @min-[780px]:grid-cols-[1.45fr_1fr]">
            <DailyIntensity days={heatmap} bestDay={best?.totalTokens ? best.day : null} />
            <TokenMix snapshot={snapshot} />
          </div>
        </section>

        <section className="mt-5" aria-labelledby="providers-heading">
          <div className="mb-3 flex items-center gap-3">
            <div>
              <h3 id="providers-heading" className="text-sm font-semibold">Providers</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{enabled.length} enabled · {withData} with data</p>
            </div>
            <span className="ml-auto flex items-center gap-1.5 rounded-full bg-background/40 px-2.5 py-1 text-xs tabular-nums hairline">
              <Activity className="size-3.5 text-faint" /> {sessions.toLocaleString()} sessions
            </span>
          </div>
          <div className="grid gap-3 @min-[760px]:grid-cols-2">
            {snapshot.providers.map((provider) => (
              <ProviderCard key={provider.id} provider={provider} allTokens={snapshot.totalTokens} incompleteScope={incompleteScope} />
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-faint">
            Costs use the included standard API price table, not provider bills. Subscription billing, discounts, taxes, and unrecorded pricing modifiers are not included. Legacy Claude cache writes without duration detail assume five minutes.
          </p>
        </section>
    </>
  );
}

function MetricCard({ icon, value, label, compact = false }: { icon: ReactNode; value: string; label: string; compact?: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3 rounded-xl bg-background/35 hairline", compact ? "px-3 py-3" : "px-4 py-4")}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-veil-raised text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <strong className={cn("block truncate font-semibold tabular-nums", compact ? "text-lg" : "text-xl")}>{value}</strong>
        <span className="block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function DailyIntensity({ days, bestDay }: { days: ReturnType<typeof heatmapDays>; bestDay: string | null }) {
  return (
    <article className="min-w-0 rounded-xl bg-background/30 p-4 hairline">
      <div className="flex items-start gap-3">
        <div>
          <h4 className="text-sm font-semibold">Daily intensity</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">Recent combined Claude and Codex token activity.</p>
        </div>
        {bestDay && <span className="ml-auto shrink-0 rounded-full bg-well px-2 py-0.5 text-[11px] hairline">Best: {shortDate(bestDay)}</span>}
      </div>
      <div className="mt-4 grid grid-flow-col grid-rows-2 gap-1.5" aria-label="Token activity over the 30-day reporting range">
        {days.map((day) => (
          <span
            key={day.day}
            className={cn("aspect-square min-w-2 rounded-[3px]", LEVELS[day.level])}
            title={`${formatDate(day.day)}: ${day.totalTokens.toLocaleString()} tokens`}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center text-[11px] text-faint">
        <span>{shortDate(days[0]?.day)}</span>
        <span className="ml-auto mr-2">Less</span>
        <span className="flex gap-1" aria-hidden>{LEVELS.map((level) => <i key={level} className={cn("size-2.5 rounded-[2px]", level)} />)}</span>
        <span className="ml-2">More</span>
        <span className="ml-auto">{shortDate(days.at(-1)?.day)}</span>
      </div>
    </article>
  );
}

function TokenMix({ snapshot }: { snapshot: StatsUsageSnapshot }) {
  const parts = [
    { label: "New input", value: snapshot.newInputTokens, className: "bg-foreground" },
    { label: "Output", value: snapshot.outputTokens, className: "bg-muted-foreground" },
    { label: "Cache", value: snapshot.cacheTokens, className: "bg-veil-strong" },
  ];
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  return (
    <article className="min-w-0 rounded-xl bg-background/30 p-4 hairline">
      <div className="flex items-start gap-3">
        <div>
          <h4 className="text-sm font-semibold">Token mix</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">Combined input, output, and cache tokens.</p>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-well px-2 py-0.5 text-[11px] tabular-nums hairline">
          {formatTokens(snapshot.reasoningTokens)} reasoning
        </span>
      </div>
      <div className="mt-6 flex h-2 overflow-hidden rounded-full bg-veil-raised">
        {parts.map((part) => (
          <span key={part.label} className={part.className} style={{ width: `${total ? part.value / total * 100 : 0}%` }} />
        ))}
      </div>
      <div className="mt-4 grid gap-2 text-[11px] @min-[1000px]:grid-cols-3">
        {parts.map((part) => (
          <span key={part.label} className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <i className={cn("size-2 shrink-0 rounded-full", part.className)} />
            <span className="truncate">{part.label}: {formatTokens(part.value)}</span>
          </span>
        ))}
      </div>
    </article>
  );
}

function ProviderCard({ provider, allTokens, incompleteScope }: { provider: ProviderUsage; allTokens: number; incompleteScope: boolean }) {
  const share = allTokens ? provider.totalTokens / allTokens : 0;
  return (
    <article className={cn("rounded-xl bg-background/30 p-4 hairline", !provider.enabled && "opacity-55")}>
      <div className="flex items-center gap-2">
        <AgentMark id={provider.id} className="size-4" decorative />
        <h4 className="text-sm font-semibold">{provider.label}</h4>
        <span className="rounded-full bg-veil-raised px-2 py-0.5 text-[10px] text-muted-foreground">
          {provider.enabled ? "Enabled" : "Off"}
        </span>
        {!provider.enabled && <Button variant="outline" size="xs" className="ml-auto" disabled title="Provider support is not available yet">Enable</Button>}
      </div>
      <p className="mt-2 min-h-4 truncate text-xs text-muted-foreground" title={[provider.lastModel, provider.lastProject].filter(Boolean).join(" · ")}>
        {provider.lastModel ? `${provider.lastModel}${provider.lastProject ? ` · ${provider.lastProject}` : ""}` : "No model yet"}
      </p>
      <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
        <Detail value={formatTokens(provider.totalTokens)} label="tokens" />
        <Detail value={provider.sessions.toLocaleString()} label={`sessions · ${provider.activityCount.toLocaleString()} ${provider.activityLabel}`} />
        <Detail value={formatCost(provider.estimatedCostUsd)} label={provider.hasPartialCost || incompleteScope ? "partial estimate" : "estimated"} />
      </div>
      {provider.hasPartialCost && <p className="mt-2 text-xs text-muted-foreground">Some usage has no supported price or request detail; its cost is unknown and excluded{provider.unpricedModels?.length ? `: ${provider.unpricedModels.join(", ")}` : ""}.</p>}
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-veil-raised">
        <div className="h-full rounded-full bg-foreground/75" style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
    </article>
  );
}

function Detail({ value, label }: { value: string; label: string }) {
  return (
    <span className="min-w-0">
      <strong className="block truncate font-medium tabular-nums">{value}</strong>
      <span className="mt-0.5 block truncate text-[11px] text-faint" title={label}>{label}</span>
    </span>
  );
}

function formatDate(value: string): string {
  const date = value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function shortDate(value?: string): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
