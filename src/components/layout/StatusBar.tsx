import { useEffect, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { refreshUsage, setStatusSettings, useStatus } from "@/lib/status";
import { useSessionStore } from "@/lib/sessions";
import { formatResetCountdown, useCountdownNow } from "@/lib/statusTime";
import type { StatusBarSettings, UsageWindow } from "@/lib/api";

const NARROW_AT = 900;

/** The quiet, app-wide chrome beneath every column. */
export function StatusBar() {
  const { settings } = useStatus();
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_AT));
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
          data-narrow={narrow || undefined}
          className="flex h-[22px] shrink-0 items-center justify-between border-t border-hairline bg-background/70 px-2 text-[11px] leading-none text-muted-foreground"
        >
          <div className="flex min-w-0 items-center">
            <UsageCluster narrow={narrow} />
          </div>
          <div className="flex min-w-0 items-center">
            {settings.resources ? (
              <div className="h-[18px] rounded px-1.5 leading-[18px]">
                0 agents<span className={cn(narrow && "hidden")}> · —</span>
              </div>
            ) : null}
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

function urgency(used: number): string {
  return used >= 80 ? "bg-destructive" : used >= 60 ? "bg-warning" : "bg-muted-foreground/55";
}

function urgencyText(used: number): string {
  return used >= 80 ? "text-destructive" : used >= 60 ? "text-warning" : "text-muted-foreground";
}

function shownPercent(window: UsageWindow, preference: StatusBarSettings["percent"]): number {
  return preference === "remaining" ? 100 - window.usedPercent : window.usedPercent;
}

function UsageCluster({ narrow }: { narrow: boolean }) {
  const { settings, usage, usageRefreshing } = useStatus();
  const harnesses = useSessionStore().harnesses;
  const available = new Set(harnesses.filter((harness) => harness.available).map((harness) => harness.id));
  const providerProbePending = harnesses.length === 0;
  const windows = usage.windows
    .filter((window) => providerProbePending || available.has(window.agent))
    .sort((a, b) => b.usedPercent - a.usedPercent);
  const now = useCountdownNow(windows.map((window) => window.resetsAt));
  const worst = windows[0];
  const pressuredProviders = new Set(windows.filter((window) => window.usedPercent >= 60).map((window) => window.agent));
  if (!settings.usage || (!providerProbePending && !available.has("claude") && !available.has("codex"))) return null;

  const display = worst ? Math.round(shownPercent(worst, settings.percent)) : null;
  const agent = worst?.agent === "claude" ? "Claude" : "Codex";
  const countdown = worst ? formatResetCountdown(worst.resetsAt, now, worst.label) : null;
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "relative h-[19px] min-w-0 rounded px-1.5 pb-px leading-[18px] outline-none hover:bg-veil-raised focus-visible:ring-1 focus-visible:ring-ring/50",
            worst ? urgencyText(worst.usedPercent) : "text-muted-foreground",
          )}
          aria-label={worst ? `${agent} usage ${display}% ${settings.percent}` : "Usage unavailable"}
        >
          {worst ? (
            <span className="flex min-w-0 items-center gap-1 tabular-nums">
              <span>{agent} {display}%{settings.percent === "remaining" ? " remaining" : ""}</span>
              {!narrow ? <span className="truncate text-faint">· resets {countdown}</span> : null}
              {pressuredProviders.size > 1 ? (
                <span aria-label="and one more agent near its limit" className="flex h-2.5 w-1 flex-col justify-center gap-px">
                  <i className="size-1 rounded-full bg-current" />
                  <i className="size-1 rounded-full bg-current" />
                </span>
              ) : null}
            </span>
          ) : (
            "Usage —"
          )}
          {worst ? (
            <span className="absolute inset-x-1.5 bottom-0 h-0.5 overflow-hidden rounded-full bg-hairline-strong">
              <span className={cn("block h-full rounded-full", urgency(worst.usedPercent))} style={{ width: `${shownPercent(worst, settings.percent)}%` }} />
            </span>
          ) : null}
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
                      <div className="truncate text-[11px] font-medium">{window.label}</div>
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
                      <span className="text-[9.5px] text-faint">resets {formatResetCountdown(window.resetsAt, now, window.label)}</span>
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
