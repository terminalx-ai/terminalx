import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  CalendarDays,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Database,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { api, errorMessage, type ProviderUsage, type StatsUsageSnapshot } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatAgentTime, formatCost, formatTokens, heatmapDays } from "@/lib/stats";

const LEVELS = ["bg-veil-raised", "bg-muted-foreground/25", "bg-muted-foreground/45", "bg-muted-foreground/70", "bg-foreground/85"];

export function StatsUsageView() {
  const [snapshot, setSnapshot] = useState<StatsUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await api.statsUsageSnapshot());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1240px] px-5 pb-8 pt-1 @min-[1000px]:px-8">
        <header className="flex items-start gap-3 border-b border-hairline pb-5">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Stats &amp; Usage</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              TerminalX activity plus local Claude and Codex token analytics.
            </p>
          </div>
          <WithTooltip label="Refresh local analytics">
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Refresh local analytics"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </WithTooltip>
        </header>

        {error ? (
          <div role="alert" className="mt-6 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <p>Could not read local usage: {error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>Try again</Button>
          </div>
        ) : null}
        {snapshot ? (
          <StatsContents snapshot={snapshot} refreshing={loading} />
        ) : !error ? <LoadingState /> : null}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="mt-6 flex min-h-64 items-center justify-center rounded-2xl bg-well/50 hairline" aria-busy="true">
      <div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-faint" />
        <span>Reading local transcripts…</span>
        <span className="max-w-sm text-xs text-faint">The first scan can take a moment. Later visits only revisit changed files.</span>
      </div>
    </div>
  );
}

function StatsContents({ snapshot, refreshing }: { snapshot: StatsUsageSnapshot; refreshing: boolean }) {
  const heatmap = useMemo(() => heatmapDays(snapshot.daily), [snapshot.daily]);
  const best = heatmap.reduce((winner, day) => day.totalTokens > winner.totalTokens ? day : winner, heatmap[0]);
  const enabled = snapshot.providers.filter((provider) => provider.enabled);
  const withData = enabled.filter((provider) => provider.hasData).length;
  const sessions = enabled.reduce((total, provider) => total + provider.sessions, 0);

  return (
    <div className={cn("transition-opacity", refreshing && "opacity-70")} aria-busy={refreshing}>
      <section className="mt-6 rounded-2xl bg-well/35 p-4 hairline @min-[760px]:p-5">
        <div className="grid gap-3 @min-[620px]:grid-cols-3">
          <MetricCard icon={<Bot />} value={snapshot.app.agentsSpawned.toLocaleString()} label="Agents spawned" />
          <MetricCard icon={<Clock3 />} value={formatAgentTime(snapshot.app.agentTimeMs)} label="Time agents worked" />
          <MetricCard icon={<GitPullRequest />} value={snapshot.app.prsCreated.toLocaleString()} label="PRs created" />
        </div>
        <p className="mt-4 px-1 text-xs text-muted-foreground">
          {snapshot.app.trackingSince ? `Tracking since ${formatDate(snapshot.app.trackingSince)}` : "Tracking starts with the first recorded activity"}
        </p>
        <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
          Lifetime activity on this installation. Agents spawned counts each live start of work, including another turn or resuming after a wait in the same conversation. Working time excludes waits and idle time. PRs include those discovered on tracked workspace branches, including merged and closed PRs.
        </p>
        <p className="mt-2 px-1 text-[11px] leading-relaxed text-faint">
          Earlier activity is recovered from surviving local history. Deleted history and unrecorded work cannot be fully reconstructed.
        </p>
        {snapshot.app.accountingError && <p role="alert" className="mt-3 px-1 text-xs text-destructive">{snapshot.app.accountingError}</p>}

        <div className="mb-3 mt-7 flex items-center gap-3">
          <h2 className="text-sm font-semibold">Usage Analytics</h2>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="ml-auto min-w-32 justify-between">
                <BarChart3 /> Overview <ChevronDown className="ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>✓ Overview</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <section className="rounded-xl bg-background/35 p-4 hairline @min-[760px]:p-5" aria-labelledby="usage-overview-heading">
          <div className="flex items-start gap-3">
            <div>
              <h3 id="usage-overview-heading" className="text-sm font-semibold">Usage Overview</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Latest 30 local calendar dates, including today · Known TerminalX projects and worktrees · Updated {formatTimestamp(snapshot.updatedAt)}</p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 @min-[540px]:grid-cols-2 @min-[940px]:grid-cols-4">
            <MetricCard compact icon={<Sparkles />} value={formatTokens(snapshot.totalTokens)} label="Total tokens" />
            <MetricCard
              compact
              icon={<CircleDollarSign />}
              value={formatCost(snapshot.estimatedCostUsd)}
              label={`Estimated cost${snapshot.hasPartialCost ? "*" : ""}`}
            />
            <MetricCard compact icon={<CalendarDays />} value={snapshot.activeDays.toLocaleString()} label="Active days" />
            <MetricCard compact icon={<Database />} value={snapshot.cacheShare == null ? "—" : `${Math.round(snapshot.cacheShare * 100)}%`} label="Cache share" />
          </div>

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
              <ProviderCard key={provider.id} provider={provider} allTokens={snapshot.totalTokens} />
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-faint">
            * Costs are estimates from the included per-token model price table. Subscription billing, discounts, and taxes are not included.
          </p>
        </section>
      </section>
    </div>
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
      <div className="mt-4 grid grid-flow-col grid-rows-2 gap-1.5" aria-label="Token activity over the last 42 days">
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

function ProviderCard({ provider, allTokens }: { provider: ProviderUsage; allTokens: number }) {
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
        <Detail value={formatCost(provider.estimatedCostUsd)} label={`estimated${provider.hasPartialCost ? "*" : ""}`} />
      </div>
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
