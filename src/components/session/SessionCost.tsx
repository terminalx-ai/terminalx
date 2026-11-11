import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { invoke } from "@tauri-apps/api/core";
import { BarChart3, Gauge, Terminal } from "@/icons";
import { agentName } from "@/components/AgentMark";
import { checkAgentReadiness } from "@/lib/agentReadiness";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { modelLabel } from "@/lib/models";
import { openStats, upsertSession } from "@/lib/sessions";
import { useStatus } from "@/lib/status";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import type { UsageWindow } from "@/lib/api";
import type { ModelUsage, SessionEntry, SessionUsageReport, UsageTotals } from "@/types/session";

/**
 * The session's estimated cost in its header, with its tokens by model in a
 * popover (PRO-273, design 18.06). Behind Settings → Experimental → Session
 * cost. The totals are the agents' own usage records, priced by the same
 * table as Stats & Usage; on a subscription login nothing is billed per
 * token, so the figure is labelled API-equivalent there.
 */

/** Which agent a model id belongs to, for its label and its dot. */
export function modelAgent(model: string): "claude" | "codex" {
  return model.toLowerCase().startsWith("claude") ? "claude" : "codex";
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

export function formatCost(value: number | null): string {
  if (value == null) return "—";
  if (value > 0 && value < 0.01) return "< $0.01";
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

/** Sum rows the way the runtime does (`session_usage::total`): priced models' cost, `null` with tokens and no price at all. */
export function totals(rows: readonly ModelUsage[]): UsageTotals {
  const sum: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpricedModels: [] };
  let priced = false;
  let tokens = false;
  for (const row of rows) {
    sum.inputTokens += row.inputTokens;
    sum.outputTokens += row.outputTokens;
    sum.cacheReadTokens += row.cacheReadTokens;
    sum.cacheWriteTokens += row.cacheWriteTokens;
    tokens ||= row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0;
    if (row.costUsd == null) {
      if (!sum.unpricedModels.includes(row.model)) sum.unpricedModels.push(row.model);
    } else {
      sum.costUsd = (sum.costUsd ?? 0) + row.costUsd;
      priced = true;
    }
  }
  if (!priced && tokens) sum.costUsd = null;
  return sum;
}

/** A session's models merged across its tabs, costliest first, as the runtime reports them. */
export function sessionModels(session: SessionEntry): ModelUsage[] {
  const merged = new Map<string, ModelUsage>();
  for (const row of session.tabs.flatMap((tab) => tab.usage?.models ?? [])) {
    const held = merged.get(row.model);
    if (!held) {
      merged.set(row.model, { ...row });
      continue;
    }
    held.inputTokens += row.inputTokens;
    held.outputTokens += row.outputTokens;
    held.cacheReadTokens += row.cacheReadTokens;
    held.cacheWriteTokens += row.cacheWriteTokens;
    held.costUsd = held.costUsd == null || row.costUsd == null ? null : held.costUsd + row.costUsd;
  }
  return [...merged.values()].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.model.localeCompare(b.model));
}

type Billing = "subscription" | "api" | "unknown";

/** What the figure means for these agents' logins: none billed per token, all billed, or not known. */
export function billingOf(methods: readonly (string | null | undefined)[]): Billing {
  if (!methods.length) return "unknown";
  const kinds = methods.map((method) => method === "Claude account" || method === "ChatGPT account" ? "subscription" : method === "API key" ? "api" : "unknown");
  return kinds.every((kind) => kind === kinds[0]) ? kinds[0] : "unknown";
}

const SUBTITLE: Record<Billing, string> = {
  subscription: "subscriptions · nothing billed per token",
  api: "API key · billed per token",
  unknown: "at API list prices",
};

const COLUMNS = { gridTemplateColumns: "minmax(0,1fr) 54px 54px 62px 54px" };

function windowName(window: UsageWindow): string {
  const kind = window.key === "five_hour" || (window.windowMinutes != null && Math.abs(window.windowMinutes - 300) <= 1) ? "5h"
    : window.key === "seven_day" || window.key === "weekly" ? "weekly" : window.label;
  return `${agentName(window.agent)} · ${kind}`;
}

export function resetLabel(resetsAt: number, now: number): string {
  const at = new Date(resetsAt);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return `resets ${sameDay ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : at.toLocaleDateString([], { weekday: "short" })}`;
}

function WindowRow({ window, now }: { window: UsageWindow; now: number }) {
  const percent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
  return <div className="flex items-center gap-2" data-testid="session-usage-window">
    <span className="w-[104px] shrink-0 truncate text-muted-foreground">{windowName(window)}</span>
    <span className="h-1 flex-1 overflow-hidden rounded-full bg-veil-strong"><span className="block h-1 bg-accent" style={{ width: `${percent}%` }} /></span>
    <span className="w-9 text-right font-mono tabular-nums">{percent}%</span>
    <span className="w-[76px] text-right text-faint">{window.resetsAt != null && window.resetsAt > now ? resetLabel(window.resetsAt, now) : window.stale ? "last known" : ""}</span>
  </div>;
}

function UsagePopover({ session, models, total, onClose }: { session: SessionEntry; models: ModelUsage[]; total: UsageTotals; onClose: () => void }) {
  const { usage } = useStatus();
  const agents = useMemo(() => [...new Set(models.map((row) => modelAgent(row.model)))], [models]);
  const [methods, setMethods] = useState<(string | null | undefined)[] | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all(agents.map((agent) => checkAgentReadiness(agent).then((answer) => answer.loginMethod))).then((found) => { if (live) setMethods(found); });
    return () => { live = false; };
  }, [agents]);
  const billing = methods ? billingOf(methods) : "unknown";
  const now = Date.now();
  const windows = usage.windows.filter((window) => agents.includes(window.agent as "claude" | "codex"));
  const tabs = session.tabs.filter((tab) => tab.usage?.models.length);
  const command = `terminalx sessions usage ${session.id} --json`;
  return <>
    <div className="flex items-center gap-2 px-3.5 pt-3 pb-2.5">
      <span className="font-medium">Session usage</span>
      <span className="truncate text-[11px] text-faint" data-testid="session-usage-billing">{SUBTITLE[billing]}</span>
      <span className="ml-auto shrink-0 text-right leading-4">
        <span className="font-mono text-[15px] font-semibold" data-testid="session-usage-total">{formatCost(total.costUsd)}</span>
        <span className="block text-[10.5px] text-faint">{billing === "subscription" ? "API-equivalent" : "estimate"}</span>
      </span>
    </div>
    <div className="mx-3 rounded-lg border border-hairline bg-(--surface-raised)" role="table" aria-label="Tokens by model">
      <div role="row" className="grid h-7 items-center gap-x-3 border-b border-hairline px-3 text-[10.5px] font-medium uppercase tracking-[.08em] text-faint" style={COLUMNS}>
        <span role="columnheader">Model</span><span role="columnheader" className="text-right">In</span><span role="columnheader" className="text-right">Out</span><span role="columnheader" className="text-right">Cache</span><span role="columnheader" className="text-right">Cost</span>
      </div>
      {models.map((row) => <div key={row.model} role="row" className="grid h-8 items-center gap-x-3 border-b border-hairline px-3 font-mono text-[12px] last:border-b-0" style={COLUMNS} data-testid="session-usage-model">
        <span role="cell" className="flex min-w-0 items-center gap-1.5 font-sans" title={row.model}>
          <span className={cn("size-1.5 shrink-0 rounded-full", modelAgent(row.model) === "claude" ? "bg-(--accent-add)" : "bg-accent")} />
          <span className="truncate">{modelLabel(modelAgent(row.model), row.model)}</span>
        </span>
        <span role="cell" className="text-right text-muted-foreground" title={`${row.inputTokens.toLocaleString()} uncached input tokens`}>{formatTokens(row.inputTokens)}</span>
        <span role="cell" className="text-right text-muted-foreground" title={`${row.outputTokens.toLocaleString()} output tokens`}>{formatTokens(row.outputTokens)}</span>
        <span role="cell" className="text-right text-muted-foreground" title={`${row.cacheReadTokens.toLocaleString()} read from cache · ${row.cacheWriteTokens.toLocaleString()} written to cache`}>{formatTokens(row.cacheReadTokens + row.cacheWriteTokens)}</span>
        <span role="cell" className={cn("text-right", row.costUsd == null ? "text-faint" : "text-foreground")} title={row.costUsd == null ? "No price for this model: its tokens are counted, its cost is not" : undefined}>{formatCost(row.costUsd)}</span>
      </div>)}
    </div>
    {(tabs.length > 1 || total.unpricedModels.length > 0) && <div className="grid gap-1.5 px-3.5 py-2.5 text-[12px]">
      {tabs.length > 1 && tabs.map((tab) => <div key={tab.id} className="flex items-center gap-2" data-testid="session-usage-tab">
        <span className="min-w-0 truncate text-muted-foreground">Tab “{tab.title || agentName(tab.harness)}”</span>
        <span className="ml-auto font-mono">{formatCost(totals(tab.usage!.models).costUsd)}</span>
      </div>)}
      {total.unpricedModels.length > 0 && <p className="text-[11px] text-faint">No price for {total.unpricedModels.join(", ")}: its tokens are counted, its cost is not.</p>}
    </div>}
    {windows.length > 0 && <div className="grid gap-2 border-t border-hairline px-3.5 py-2.5 text-[12px]">
      <div className="text-[10.5px] font-medium uppercase tracking-[.08em] text-faint">Usage windows</div>
      {windows.map((window) => <WindowRow key={`${window.agent}:${window.key}`} window={window} now={now} />)}
    </div>}
    <div className="flex h-10 items-center gap-2 border-t border-hairline px-3.5 text-[12px] text-muted-foreground">
      <button type="button" className="flex min-w-0 items-center gap-2 hover:text-foreground" title={copied ? "Copied" : `Copy ${command}`} aria-label={copied ? "Copied" : `Copy ${command}`} onClick={() => void copyText(command).then(() => setCopied(true))}>
        <Terminal className="size-[13px] shrink-0" />
        <span className="truncate font-mono text-[11.5px]">terminalx sessions usage</span>
      </button>
      <button type="button" className="ml-auto flex shrink-0 items-center gap-1.5 hover:text-foreground" onClick={() => { onClose(); openStats(); }}>
        <BarChart3 className="size-[13px]" />Open Stats
      </button>
    </div>
  </>;
}

/** Read the session's totals again and take the session as it is now. */
async function refresh(sessionId: string): Promise<SessionUsageReport | null> {
  try {
    const answer = await invoke<{ usage: SessionUsageReport; session: SessionEntry }>("session_usage", { sessionId });
    if (answer?.session) upsertSession(answer.session);
    return answer?.usage ?? null;
  } catch {
    return null;
  }
}

export function SessionCost({ session, className }: { session: SessionEntry; className?: string }) {
  const settings = useExperimentalSettings();
  const enabled = settings?.sessionCost === true;
  const [open, setOpen] = useState(false);
  const models = useMemo(() => sessionModels(session), [session]);
  const total = useMemo(() => totals(models), [models]);
  // A session last worked on before totals were kept has none until its next
  // turn: read them once, so the header is not empty in the meantime.
  const backfilled = useRef<string | null>(null);
  const unread = session.tabs.some((tab) => tab.providerSessionId) && session.tabs.every((tab) => !tab.usage);
  useEffect(() => {
    if (!enabled || !unread || backfilled.current === session.id) return;
    backfilled.current = session.id;
    void refresh(session.id);
  }, [enabled, unread, session.id]);
  useEffect(() => {
    if (open) void refresh(session.id);
  }, [open, session.id]);
  if (!enabled || !models.length) return null;
  const label = total.costUsd == null ? "≈ —" : `≈ ${formatCost(total.costUsd)}`;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button
        type="button"
        aria-label={total.costUsd == null ? "Session usage: no price for its models" : `Session usage: estimated ${formatCost(total.costUsd)}`}
        title="Estimated session cost"
        className={cn("flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-veil-raised px-2 font-mono text-[12px] text-foreground hover:bg-veil-strong focus-visible:outline focus-visible:outline-ring", className)}
        data-testid="session-cost"
      >
        <Gauge className="size-3 text-muted-foreground" />
        {label}
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} aria-label="Session usage"
        className="z-(--z-menu) w-[400px] max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-auto rounded-xl border border-hairline bg-(--surface-card) text-sm text-popover-foreground shadow-surface outline-none">
        <UsagePopover session={session} models={models} total={total} onClose={() => setOpen(false)} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
