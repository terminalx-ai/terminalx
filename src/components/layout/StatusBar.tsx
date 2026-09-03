import { useEffect, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Cpu, RefreshCw, SquareTerminal, Trash2, TriangleAlert } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
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
export function StatusBar() {
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
            <UsageCluster tier={tier} />
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

function canonicalWindow(windows: UsageWindow[], kind: CanonicalWindowKind, exactKeys: string[]): UsageWindow | null {
  const candidates = windows.filter((window) => windowKind(window) === kind);
  const exact = candidates.filter((window) => exactKeys.includes(window.key));
  return candidates.length ? tightestWindow(exact.length ? exact : candidates) : null;
}

/** The full strip reserves one independent value for each canonical account window. */
function barWindows(windows: UsageWindow[]): UsageWindow[] {
  const canonical = [
    canonicalWindow(windows, "5h", ["five_hour"]),
    canonicalWindow(windows, "7d", ["seven_day", "weekly"]),
    canonicalWindow(windows, "fable", ["fable_weekly"]),
  ].filter((window): window is UsageWindow => window != null);
  return canonical.length ? canonical : [tightestWindow(windows)];
}

function UsageCluster({ tier }: { tier: StatusTier }) {
  const { settings, usage, usageRefreshing } = useStatus();
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
  });
  const usageLabel = groups.length
    ? groups.flatMap(({ agent, windows: agentWindows }) => barWindows(agentWindows).map((window) =>
      `${agentName(agent)} ${windowLabel(window)} ${Math.round(shownPercent(window, settings.percent))}% ${settings.percent}, resets ${formatResetCountdown(window.resetsAt, now, windowLabel(window))}`,
    )).join("; ")
    : "Usage unavailable";

  return (
    <PopoverPrimitive.Root>
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
                const shown = tier === "full" ? barWindows(agentWindows) : [tightest];
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
          data-status-context-exempt
          onContextMenu={(event) => event.stopPropagation()}
          className="z-(--z-menu) w-[360px] rounded-xl bg-popover p-3 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in"
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
          {windows.length ? (
            <ul className="flex flex-col gap-1.5">
              {windows.map((window) => {
                const percent = Math.round(shownPercent(window, settings.percent));
                return (
                  <li key={`${window.agent}:${window.key}`} className="grid grid-cols-[16px_72px_1fr_auto] items-center gap-2 rounded-lg bg-well/60 px-2 py-2">
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
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="rounded-lg bg-well/60 px-3 py-5 text-center text-[11px] text-faint">
              Usage appears after a Claude turn or a Codex refresh.
            </div>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
