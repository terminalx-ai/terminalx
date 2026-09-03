import { useEffect, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ChevronRight, Cpu, History, Loader2, RefreshCw, RotateCcw, SquareTerminal, Trash2, TriangleAlert } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WithTooltip } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import {
  refreshResourceSample,
  refreshUsage,
  removeResourceOptimistically,
  resetCodexUsage,
  setStatusSettings,
  useStatus,
} from "@/lib/status";
import { selectSession, setActiveTab, useSessionStore } from "@/lib/sessions";
import { formatResetCountdown, useCountdownNow } from "@/lib/statusTime";
import { useResourceSampling } from "@/lib/statusPolling";
import { errorMessage, statusBar, type ProcSample, type StatusBarSettings, type UsageWindow } from "@/lib/api";

const COMPACT_AT = 900;
const ICON_ONLY_AT = 500;
type StatusTier = "full" | "compact" | "icon";

/** The quiet, app-wide chrome beneath every column. */
export function StatusBar({
  onOpenAgentSettings,
  onOpenUsageDetails,
}: {
  onOpenAgentSettings?: () => void;
  onOpenUsageDetails?: () => void;
} = {}) {
  const { settings } = useStatus();
  const ref = useRef<HTMLDivElement>(null);
  const [tier, setTier] = useState<StatusTier>("full");

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setTier(width < ICON_ONLY_AT ? "icon" : width < COMPACT_AT ? "compact" : "full");
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!settings.visible) return null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          data-status-bar
          data-tier={tier}
          className="flex h-[22px] shrink-0 items-center justify-between gap-1 overflow-hidden border-t border-hairline bg-background/70 px-2 text-[11px] leading-none text-muted-foreground"
        >
          <div className="flex min-w-0 flex-1 items-center overflow-hidden">
            <UsageCluster tier={tier} onOpenAgentSettings={onOpenAgentSettings} onOpenUsageDetails={onOpenUsageDetails} />
          </div>
          <div className="flex shrink-0 items-center">
            <ResourceCluster narrow={tier !== "full"} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void setStatusSettings({ usage: !settings.usage })}>
          <span className="w-3 text-center">{settings.usage ? "✓" : ""}</span> Usage
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void setStatusSettings({ resources: !settings.resources })}>
          <span className="w-3 text-center">{settings.resources ? "✓" : ""}</span> Resources
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatCpu(cpu: number | null): string {
  return cpu == null ? "—" : `${cpu.toFixed(cpu >= 10 ? 0 : 1)}%`;
}

interface ResourceGroup {
  key: string;
  name: string;
  sessions: Array<{ key: string; name: string; processes: ProcSample[] }>;
}

function groupProcesses(processes: ProcSample[]): ResourceGroup[] {
  const projects = new Map<string, ResourceGroup>();
  for (const process of processes) {
    const projectKey = process.projectPath ?? "unbound";
    let project = projects.get(projectKey);
    if (!project) {
      project = { key: projectKey, name: process.projectName ?? "Unbound", sessions: [] };
      projects.set(projectKey, project);
    }
    const sessionKey = process.sessionId ?? `orphan:${process.paneId}`;
    let session = project.sessions.find((entry) => entry.key === sessionKey);
    if (!session) {
      session = { key: sessionKey, name: process.sessionTitle ?? "Orphaned process", processes: [] };
      project.sessions.push(session);
    }
    session.processes.push(process);
  }
  return [...projects.values()];
}

function ResourceCluster({ narrow }: { narrow: boolean }) {
  const { settings, resources, resourceSample, resourcesRefreshing } = useStatus();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{ process: ProcSample; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  useResourceSampling(open, refreshResourceSample);
  if (!settings.resources) return null;

  const pressureClass = resources.pressure != null && resources.pressure >= 0.8
    ? "text-destructive"
    : resources.pressure != null && resources.pressure >= 0.6
      ? "text-warning"
      : "text-muted-foreground";
  const groups = groupProcesses(resourceSample?.processes ?? []);

  const navigate = (process: ProcSample) => {
    if (!process.sessionId) return;
    selectSession(process.sessionId);
    if (process.tabId) void setActiveTab(process.sessionId, process.tabId);
    setOpen(false);
  };

  const finishKill = async (process: ProcSample, confirmed: boolean) => {
    setError(null);
    setKilling(process.paneId);
    removeResourceOptimistically(process.paneId);
    try {
      const result = await statusBar.killResource(process.paneId, confirmed);
      if (result.confirmation) {
        setPending({ process, message: result.confirmation });
      }
      if (result.killed) await refreshResourceSample();
    } catch (reason) {
      setError(errorMessage(reason));
      await refreshResourceSample();
    } finally {
      setKilling(null);
    }
  };

  const requestKill = async (process: ProcSample) => {
    if (process.killRule === "confirm") {
      setKilling(process.paneId);
      try {
        const result = await statusBar.killResource(process.paneId, false);
        if (result.confirmation) setPending({ process, message: result.confirmation });
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setKilling(null);
      }
      return;
    }
    await finishKill(process, false);
  };

  return (
    <>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className="h-[19px] rounded px-1.5 leading-[18px] text-muted-foreground outline-none hover:bg-veil-raised focus-visible:ring-1 focus-visible:ring-ring/50"
            aria-label={`${resources.agentCount} live agents using ${formatBytes(resources.rssBytes)}`}
          >
            <span className="tabular-nums">{resources.agentCount} {resources.agentCount === 1 ? "agent" : "agents"}</span>
            {resources.orphanCount > 0 ? <span className="ml-1 text-warning">({resources.orphanCount})</span> : null}
            {!narrow ? <span className={cn("tabular-nums", pressureClass)}> · {formatBytes(resources.rssBytes)}</span> : null}
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="top"
            align="end"
            sideOffset={5}
            data-status-context-exempt
            onContextMenu={(event) => event.stopPropagation()}
            className="z-(--z-menu) w-[26rem] rounded-xl bg-popover p-3 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in"
          >
            <div className="mb-2.5 flex items-center gap-2">
              <div>
                <div className="text-xs font-medium">App resources</div>
                <div className="mt-0.5 text-[10.5px] text-faint">Processes started by this window</div>
              </div>
              <button
                type="button"
                aria-label="Refresh resources"
                onClick={() => void refreshResourceSample()}
                className="ml-auto rounded-md p-1 text-faint hover:bg-veil-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
              >
                <RefreshCw className={cn("size-3.5", resourcesRefreshing && "animate-spin")} />
              </button>
            </div>

            <div className="mb-2 grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-hairline">
              <div className="bg-well px-2 py-1.5">
                <div className="text-[9.5px] uppercase tracking-wide text-faint">Agents</div>
                <div className="mt-0.5 text-xs tabular-nums">{resources.agentCount}</div>
              </div>
              <WithTooltip label="CPU can exceed 100% when work spans more than one core.">
                <div className="bg-well px-2 py-1.5">
                  <div className="text-[9.5px] uppercase tracking-wide text-faint">CPU</div>
                  <div className="mt-0.5 text-xs tabular-nums">{formatCpu(resourceSample?.totalCpuPercent ?? null)}</div>
                </div>
              </WithTooltip>
              <div className="bg-well px-2 py-1.5">
                <div className="text-[9.5px] uppercase tracking-wide text-faint">Σ RSS</div>
                <div className="mt-0.5 text-xs tabular-nums">{formatBytes(resourceSample?.totalRssBytes ?? null)}</div>
              </div>
            </div>

            <div className="grid grid-cols-[1fr_48px_62px_24px] gap-2 border-b border-hairline px-2 pb-1 text-[9.5px] uppercase tracking-wide text-faint">
              <span>Process</span><span className="text-right">CPU</span><span className="text-right">RSS</span><span />
            </div>
            <div className="h-[420px] overflow-y-auto py-1 scrollbar-thin">
              {groups.map((project) => (
                <div key={project.key} className="mb-1.5">
                  <div className="truncate px-2 py-1 text-[11px] font-medium text-foreground">{project.name}</div>
                  {project.sessions.map((session) => (
                    <div key={session.key}>
                      <div className="truncate border-l border-hairline py-0.5 pl-4 pr-2 text-[10.5px] text-muted-foreground">{session.name}</div>
                      {session.processes.map((process) => (
                        <div
                          key={process.paneId}
                          role={process.sessionId ? "button" : undefined}
                          tabIndex={process.sessionId ? 0 : undefined}
                          onClick={() => navigate(process)}
                          onKeyDown={(event) => event.key === "Enter" && navigate(process)}
                          className={cn(
                            "group/process grid grid-cols-[1fr_48px_62px_24px] items-center gap-2 rounded-md py-1 pl-7 pr-1 text-[10.5px]",
                            process.sessionId && "hover:bg-veil-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40",
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            {process.kind === "agent" ? <AgentMark id={process.harness ?? ""} className="size-3 text-faint" /> : <SquareTerminal className="size-3 text-faint" />}
                            <span className="truncate">{process.tabTitle}</span>
                            {process.childCount != null && process.childCount > 0 ? <span className="text-[9px] text-faint">+{process.childCount}</span> : null}
                          </span>
                          <span className="text-right tabular-nums text-faint">{formatCpu(process.cpuPercent)}</span>
                          <span className="text-right tabular-nums text-faint">{formatBytes(process.rssBytes)}</span>
                          {process.killRule !== "none" ? (
                            <button
                              type="button"
                              aria-label={`Kill ${process.tabTitle}`}
                              disabled={killing === process.paneId}
                              onClick={(event) => {
                                event.stopPropagation();
                                void requestKill(process);
                              }}
                              className="rounded p-1 text-faint opacity-0 hover:bg-destructive/15 hover:text-destructive focus:opacity-100 group-hover/process:opacity-100"
                            >
                              <Trash2 className="size-3" />
                            </button>
                          ) : <span />}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}

              <div className="mt-2 border-t border-hairline pt-1">
                <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-foreground"><Cpu className="size-3 text-faint" /> App</div>
                <ResourceLeaf label={`Main · pid ${resourceSample?.app.mainPid ?? "—"}`} cpu={resourceSample?.app.mainCpuPercent ?? null} rss={resourceSample?.app.mainRssBytes ?? null} />
                <ResourceLeaf
                  label={`Webview${resourceSample?.app.webviewProcessCount ? ` · ${resourceSample.app.webviewProcessCount} processes` : ""}`}
                  cpu={resourceSample?.app.webviewCpuPercent ?? null}
                  rss={resourceSample?.app.webviewRssBytes ?? null}
                />
              </div>
              {!resourceSample?.processes.length ? <div className="px-3 py-6 text-center text-[11px] text-faint">No live tab or terminal processes.</div> : null}
            </div>

            <div className="mt-1 flex items-center justify-between border-t border-hairline px-2 pt-2 text-[10px] text-faint">
              <span>
                Host {formatBytes(resourceSample?.host.totalBytes ?? null)}
                {resourceSample?.host.availableBytes != null ? ` · ${formatBytes(resourceSample.host.availableBytes)} available` : ""}
              </span>
              <span>{resourceSample?.host.cores ?? "—"} cores</span>
            </div>
            {error ? <div className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-[10.5px] text-destructive"><TriangleAlert className="mt-px size-3 shrink-0" /> {error}</div> : null}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      <Dialog open={pending != null} onOpenChange={(next) => !next && setPending(null)}>
        <DialogContent width="max-w-sm">
          <DialogHeader>
            <DialogTitle>Kill process?</DialogTitle>
            <DialogDescription>{pending?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!pending) return;
                const process = pending.process;
                setPending(null);
                void finishKill(process, true);
              }}
            >
              Kill process
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ResourceLeaf({ label, cpu, rss }: { label: string; cpu: number | null; rss: number | null }) {
  return (
    <div className="grid grid-cols-[1fr_48px_62px_24px] items-center gap-2 py-1 pl-7 pr-1 text-[10.5px]">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums text-faint">{formatCpu(cpu)}</span>
      <span className="text-right tabular-nums text-faint">{formatBytes(rss)}</span>
      <span />
    </div>
  );
}

function urgency(used: number): string {
  return used >= 80 ? "bg-destructive" : used >= 60 ? "bg-warning" : "bg-muted-foreground/55";
}

function urgencyText(used: number): string {
  return used >= 80 ? "text-destructive" : used >= 60 ? "text-warning" : "text-muted-foreground";
}

function shownPercent(window: UsageWindow, preference: StatusBarSettings["percent"]): number {
  return preference === "remaining" ? 100 - window.usedPercent : window.usedPercent;
}

type UsageAgent = UsageWindow["agent"];

const AGENTS: UsageAgent[] = ["claude", "codex"];

function agentName(agent: UsageAgent): string {
  return agent === "claude" ? "Claude" : "Codex";
}

type CanonicalWindowKind = "5h" | "7d" | "fable";

function windowKind(window: UsageWindow): CanonicalWindowKind | null {
  if (window.key === "fable_weekly") return "fable";
  if (window.key === "five_hour" || window.windowMinutes != null && Math.abs(window.windowMinutes - 300) <= 1) return "5h";
  if (window.key === "seven_day" || window.key === "weekly" || window.windowMinutes != null && Math.abs(window.windowMinutes - 10_080) <= 1) return "7d";
  return null;
}

function windowLabel(window: UsageWindow): string {
  if (window.key === "five_hour") return "5h";
  if (window.key === "seven_day" || window.key === "weekly") return "7d";
  return window.label;
}

function tightestWindow(windows: UsageWindow[]): UsageWindow {
  return windows.reduce((tightest, window) => window.usedPercent > tightest.usedPercent ? window : tightest);
}

function windowOrder(window: UsageWindow): number {
  if (window.key === "five_hour") return 0;
  if (window.key === "seven_day" || window.key === "weekly") return 1;
  if (window.key === "fable_weekly") return 2;
  return 3;
}

function orderedWindows(windows: UsageWindow[]): UsageWindow[] {
  return windows.slice().sort((a, b) => windowOrder(a) - windowOrder(b) || (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0) || a.key.localeCompare(b.key));
}

function nextReset(windows: UsageWindow[]): number | null {
  const resets = windows.map((window) => window.resetsAt).filter((value): value is number => value != null);
  return resets.length ? Math.min(...resets) : null;
}

function detailWindowLabel(window: UsageWindow): string {
  if (window.key === "five_hour") return "Session";
  if (window.key === "seven_day" || window.key === "weekly") return "Weekly";
  return window.label;
}

function formatUpdatedAgo(updatedAt: number, now: number): string {
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 60_000) return "Updated just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

function formatCreditBalance(balance: string): string {
  const value = Number(balance);
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : balance;
}

interface UsageClusterProps {
  tier: StatusTier;
  onOpenAgentSettings?: () => void;
  onOpenUsageDetails?: () => void;
}

function UsageCluster({ tier, onOpenAgentSettings, onOpenUsageDetails }: UsageClusterProps) {
  const { settings, usage, usageRefreshing } = useStatus();
  const [open, setOpen] = useState(false);
  const [detailAgent, setDetailAgent] = useState<UsageAgent | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const harnesses = useSessionStore().harnesses;
  const available = new Set(harnesses.filter((harness) => harness.available).map((harness) => harness.id));
  const providerProbePending = harnesses.length === 0;
  const windows = usage.windows
    .filter((window) => providerProbePending || available.has(window.agent))
    .sort((a, b) => b.usedPercent - a.usedPercent);
  const now = useCountdownNow(windows.map((window) => window.resetsAt));
  if (!settings.usage || (!providerProbePending && !available.has("claude") && !available.has("codex"))) return null;

  const groups = AGENTS.flatMap((agent) => {
    const agentWindows = windows.filter((window) => window.agent === agent);
    return agentWindows.length ? [{ agent, windows: agentWindows, tightest: tightestWindow(agentWindows) }] : [];
  }).sort((a, b) => b.tightest.usedPercent - a.tightest.usedPercent);
  const usageLabel = groups.length
    ? groups.flatMap(({ agent, windows: agentWindows }) => orderedWindows(agentWindows).map((window) =>
      `${agentName(agent)} ${windowLabel(window)} ${Math.round(shownPercent(window, settings.percent))}% ${settings.percent}, resets ${formatResetCountdown(window.resetsAt, now, windowLabel(window))}`,
    )).join("; ")
    : "Usage unavailable";
  const detailGroup = groups.find(({ agent }) => agent === detailAgent) ?? null;

  const closeAnd = (action?: () => void) => {
    setOpen(false);
    setDetailAgent(null);
    action?.();
  };

  const confirmReset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      await resetCodexUsage();
      setResetConfirmOpen(false);
    } catch (reason) {
      setResetError(errorMessage(reason));
    } finally {
      setResetting(false);
    }
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setDetailAgent(null);
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="h-[19px] min-w-0 max-w-full overflow-hidden rounded px-1 leading-[18px] text-muted-foreground outline-none hover:bg-veil-raised focus-visible:ring-1 focus-visible:ring-ring/50"
          aria-label={usageLabel}
        >
          {groups.length ? (
            <span className="flex min-w-0 items-center whitespace-nowrap tabular-nums">
              {groups.map(({ agent, windows: agentWindows, tightest }, index) => {
                const plan = agentWindows.find((window) => window.plan)?.plan;
                const shown = tier === "full" ? orderedWindows(agentWindows) : [tightest];
                return (
                  <span
                    key={agent}
                    data-usage-agent={agent}
                    className={cn(
                      "flex min-w-0 items-center gap-1.5",
                      index < groups.length - 1 && "mr-1.5 border-r border-hairline pr-2",
                    )}
                  >
                    <span className="flex shrink-0 items-center gap-1">
                      <AgentMark id={agent} className="size-3 text-faint" />
                      {tier !== "icon" ? <span className="font-medium text-foreground">{agentName(agent)}</span> : null}
                      {tier === "full" && plan ? <span className="capitalize text-faint">· {plan}</span> : null}
                    </span>
                    {tier === "icon" ? (
                      <i
                        aria-hidden
                        className={cn("size-1.5 shrink-0 rounded-full", urgency(tightest.usedPercent))}
                      />
                    ) : shown.map((window, windowIndex) => (
                      <span
                        key={window.key}
                        data-usage-window={windowKind(window) ?? window.key}
                        className={cn(
                          "flex shrink-0 items-center gap-1",
                          urgencyText(window.usedPercent),
                          tier === "full" && windowIndex > 0 && "border-l border-hairline pl-1.5",
                        )}
                      >
                        {window.stale ? <TriangleAlert className="size-3" aria-label="Stale usage data" /> : null}
                        <span className="font-medium">{windowLabel(window)} {Math.round(shownPercent(window, settings.percent))}%</span>
                        {tier === "full" ? <span className="text-faint">· {formatResetCountdown(window.resetsAt, now, windowLabel(window))}</span> : null}
                      </span>
                    ))}
                  </span>
                );
              })}
            </span>
          ) : (
            "Usage —"
          )}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={5}
          data-usage-popover
          data-status-context-exempt
          onContextMenu={(event) => event.stopPropagation()}
          className="relative z-(--z-menu) w-[410px] rounded-xl bg-popover p-3 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in"
        >
          <div className="mb-2.5 flex items-center gap-2">
            <div>
              <div className="text-xs font-medium">Agent usage</div>
              <div className="mt-0.5 text-[10.5px] text-faint">All rolling windows, closest limit first</div>
            </div>
            <div className="ml-auto flex rounded-md bg-well p-0.5 text-[10px]">
              {(["used", "remaining"] as const).map((percent) => (
                <button
                  key={percent}
                  type="button"
                  onClick={() => void setStatusSettings({ percent })}
                  className={cn("rounded px-1.5 py-1 capitalize", settings.percent === percent ? "bg-raised text-foreground shadow-button" : "text-faint")}
                >
                  {percent}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label="Refresh usage"
              onClick={() => void refreshUsage(true)}
              className="rounded-md p-1 text-faint hover:bg-veil-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
            >
              <RefreshCw className={cn("size-3.5", usageRefreshing && "animate-spin")} />
            </button>
          </div>
          <Segmented
            aria-label="Usage layout"
            value={settings.usageMode}
            onChange={(usageMode) => void setStatusSettings({ usageMode })}
            className="mb-2.5 w-full"
            options={[
              { value: "detailed", label: "Detailed" },
              { value: "compact", label: "Compact" },
            ]}
          />
          {windows.length ? (
            settings.usageMode === "detailed" ? (
              <ul className="flex flex-col gap-1.5">
                {groups.map(({ agent, windows: agentWindows, tightest }) => {
                  const reset = nextReset(agentWindows);
                  return (
                    <li key={agent}>
                      <button
                        type="button"
                        aria-expanded={detailAgent === agent}
                        aria-label={`${agentName(agent)}, Resets in ${formatResetCountdown(reset, now, "—")}`}
                        onClick={() => setDetailAgent((current) => current === agent ? null : agent)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg bg-well/60 px-2.5 py-2.5 text-left outline-none transition-colors hover:bg-veil-raised focus-visible:ring-1 focus-visible:ring-ring/50",
                          detailAgent === agent && "bg-selected",
                        )}
                      >
                        <AgentMark id={agent} className="size-4 shrink-0 text-faint" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-[12px] font-medium">{agentName(agent)}</span>
                            <span className="truncate text-[10px] tabular-nums text-faint">
                              Resets in {formatResetCountdown(reset, now, "—")}
                            </span>
                          </div>
                          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                            {orderedWindows(agentWindows).map((window) => {
                              const isTightest = window.key === tightest.key;
                              return (
                                <span key={window.key} className="flex min-w-0 items-center gap-1.5 text-[10px] tabular-nums">
                                  <span className="shrink-0 text-faint">{windowLabel(window)}</span>
                                  <span className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-hairline-strong">
                                    <span
                                      className={cn("block h-full rounded-full", isTightest ? urgency(window.usedPercent) : "bg-muted-foreground/45")}
                                      style={{ width: `${shownPercent(window, settings.percent)}%` }}
                                    />
                                  </span>
                                  <span className={cn("shrink-0", isTightest ? urgencyText(window.usedPercent) : "text-muted-foreground")}>
                                    {Math.round(shownPercent(window, settings.percent))}%
                                  </span>
                                </span>
                              );
                            })}
                          </div>
                        </div>
                        <ChevronRight className="size-3.5 shrink-0 text-faint" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {windows.map((window) => {
                  const percent = Math.round(shownPercent(window, settings.percent));
                  return (
                    <li key={`${window.agent}:${window.key}`}>
                      <button
                        type="button"
                        data-usage-compact-window={`${window.agent}:${window.key}`}
                        onClick={() => setDetailAgent(window.agent)}
                        className="grid w-full grid-cols-[16px_72px_1fr_auto] items-center gap-2 rounded-lg bg-well/60 px-2 py-2 text-left outline-none hover:bg-veil-raised focus-visible:ring-1 focus-visible:ring-ring/50"
                      >
                        <AgentMark id={window.agent} className="size-3.5 text-faint" />
                        <div className="min-w-0">
                          <div className="truncate text-[11px] font-medium">{windowLabel(window)}</div>
                          <div className="capitalize text-[9.5px] text-faint">{window.agent}{window.plan ? ` · ${window.plan}` : ""}</div>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-hairline-strong">
                          <div className={cn("h-full rounded-full", urgency(window.usedPercent))} style={{ width: `${shownPercent(window, settings.percent)}%` }} />
                        </div>
                        <div className="flex min-w-[68px] flex-col items-end gap-0.5 tabular-nums">
                          <span className={cn("flex items-center gap-1 text-[11px]", urgencyText(window.usedPercent))}>
                            {window.stale ? <TriangleAlert className="size-3" aria-label="Stale usage data" /> : null}
                            {percent}%
                          </span>
                          <span className="text-[9.5px] text-faint">resets {formatResetCountdown(window.resetsAt, now, windowLabel(window))}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            <div className="rounded-lg bg-well/60 px-3 py-5 text-center text-[11px] text-faint">
              Usage appears after a Claude turn or a Codex refresh.
            </div>
          )}
          <div className="mt-2.5 border-t border-hairline pt-1.5">
            <button
              type="button"
              disabled={!onOpenUsageDetails}
              onClick={() => closeAnd(onOpenUsageDetails)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[11px] text-muted-foreground outline-none hover:bg-veil-raised hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60"
            >
              <History className="size-3.5" />
              <span>Usage details &amp; history</span>
              <ChevronRight className="ml-auto size-3.5 text-faint" />
            </button>
          </div>
          {detailGroup ? (
            <AgentUsageDetail
              agent={detailGroup.agent}
              windows={detailGroup.windows}
              now={now}
              percent={settings.percent}
              codex={usage.codex}
              resetError={resetError}
              onReset={() => {
                setResetError(null);
                setResetConfirmOpen(true);
              }}
              onOpenAgentSettings={() => closeAnd(onOpenAgentSettings)}
            />
          ) : null}
          <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
            <DialogContent width="max-w-[26rem]" data-status-context-exempt>
              <DialogHeader>
                <DialogTitle>Reset Codex limits?</DialogTitle>
                <DialogDescription>
                  This uses one rate-limit reset and immediately resets every eligible Codex usage window.
                </DialogDescription>
              </DialogHeader>
              {resetError ? <div role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{resetError}</div> : null}
              <DialogFooter>
                <Button variant="outline" onClick={() => setResetConfirmOpen(false)} disabled={resetting}>Cancel</Button>
                <Button onClick={() => void confirmReset()} disabled={resetting}>
                  {resetting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  {resetting ? "Resetting…" : "Reset now"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function AgentUsageDetail({
  agent,
  windows,
  now,
  percent,
  codex,
  resetError,
  onReset,
  onOpenAgentSettings,
}: {
  agent: UsageAgent;
  windows: UsageWindow[];
  now: number;
  percent: StatusBarSettings["percent"];
  codex: ReturnType<typeof useStatus>["usage"]["codex"];
  resetError: string | null;
  onReset: () => void;
  onOpenAgentSettings: () => void;
}) {
  const updatedAt = Math.max(...windows.map((window) => window.updatedAt));
  const resetCredits = agent === "codex" ? codex?.resetCredits : undefined;
  const credits = agent === "codex" ? codex?.credits : undefined;
  return (
    <aside data-usage-detail={agent} className="absolute bottom-0 left-[calc(100%+6px)] w-[300px] rounded-xl bg-popover p-3 text-popover-foreground shadow-surface hairline max-[760px]:static max-[760px]:mt-2 max-[760px]:w-full">
      <div className="flex items-center gap-2">
        <AgentMark id={agent} className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-medium">{agentName(agent)}</span>
      </div>
      <div className="mt-0.5 text-[10.5px] text-faint">{formatUpdatedAgo(updatedAt, now)}</div>
      <div className="my-3 border-t border-hairline" />
      <div className="flex flex-col gap-3">
        {orderedWindows(windows).map((window) => {
          const shown = Math.round(shownPercent(window, percent));
          return (
            <div key={window.key}>
              <div className="mb-1.5 text-[12px] font-medium">{detailWindowLabel(window)}</div>
              <div className="h-1.5 overflow-hidden rounded-full bg-hairline-strong">
                <div className={cn("h-full rounded-full", urgency(window.usedPercent))} style={{ width: `${shownPercent(window, percent)}%` }} />
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-[10.5px] tabular-nums text-muted-foreground">
                <span>{shown}% {percent}</span>
                <span>Resets in {formatResetCountdown(window.resetsAt, now, "—")}</span>
              </div>
            </div>
          );
        })}
      </div>
      {credits ? (
        <div className="mt-3 border-t border-hairline pt-2.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Credits</span>
          <span className="ml-2">{credits.unlimited ? "Unlimited" : credits.balance ? formatCreditBalance(credits.balance) : credits.hasCredits ? "Available" : "None available"}</span>
        </div>
      ) : null}
      {resetCredits && resetCredits.availableCount > 0 ? (
        <div className="mt-3 border-t border-hairline pt-2.5">
          <div className="text-[11px] font-medium">
            {resetCredits.availableCount === 1 ? "1 rate-limit reset available" : `${resetCredits.availableCount} rate-limit resets available`}
          </div>
          {resetCredits.nextExpiresAt ? (
            <div className="mt-0.5 text-[10.5px] text-faint">Expires in {formatResetCountdown(resetCredits.nextExpiresAt, now, "—")}</div>
          ) : null}
          <button type="button" onClick={onReset} className="mt-2 text-[11px] font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50">
            Reset now
          </button>
          {resetError ? <div role="alert" className="mt-1.5 text-[10.5px] text-destructive">{resetError}</div> : null}
        </div>
      ) : null}
      <div className="mt-3 border-t border-hairline pt-2.5">
        <div className="text-[10px] font-medium text-faint">{agentName(agent)} Account</div>
        <button
          type="button"
          onClick={onOpenAgentSettings}
          className="mt-1 flex w-full items-center rounded-md px-0.5 py-1 text-left text-[11px] outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
        >
          <span>System default</span>
          <ChevronRight className="ml-auto size-3.5 text-faint" />
        </button>
      </div>
    </aside>
  );
}
