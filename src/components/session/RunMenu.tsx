import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Globe, Loader2, Play, RotateCw, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, MenuShortcut } from "@/components/ui/menu";
import { RepositoryIcon } from "@/components/ui/IconPicker";
import { useShortcut, useShortcutKeys } from "@/lib/hotkeys";
import { latestByAction, runAction, watchActionStates, type ActionRun } from "@/lib/actionRunner";
import { expandPreviewUrl, visibleActions, type RepositoryAction, type RepositoryPreviewUrl } from "@/lib/repositoryActions";
import { openBrowserTab } from "@/lib/browser";
import { selectSessionTab } from "@/lib/terminal";
import { showError } from "@/lib/errorToasts";
import { cn } from "@/lib/cn";
import type { Project, SessionEntry } from "@/types/session";

/**
 * The workspace header's Run menu and Open button (PRO-155, PRO-363).
 *
 * Run lists the project's visible actions in their saved order, each with the
 * state of its latest run in this session. ⌘R runs the first one, or opens
 * the menu as a picker when there are several. Open opens the first preview
 * URL in a TerminalX browser tab, and its menu lists the others. A
 * non-concurrent action that is already running is not started twice: its
 * tab is shown, with an offer to restart it (`RunRestartOffer`).
 *
 * Local sessions only: a cloud session's actions and ports are its runtime's.
 */

type Place = Pick<SessionEntry, "id" | "cwd">;

// ---------------------------------------------------------------- the session's ports

/**
 * The session's port block: $PORT is `ports[0]`, $PORT_n is `ports[n]`.
 * Read through the backend's `workspace_ports` command (the block the
 * runtime gives the workspace's terminals as TERMINALX_PORTS). Null when it
 * is not known: then a template that names a port cannot be opened, and a
 * literal URL still can.
 */
export async function loadSessionPorts(sessionId: string): Promise<number[] | null> {
  try {
    const ports = await invoke<unknown>("workspace_ports", { sessionId });
    return Array.isArray(ports) && ports.length && ports.every((port) => Number.isInteger(port)) ? (ports as number[]) : null;
  } catch {
    return null;
  }
}

function useSessionPorts(sessionId: string, enabled: boolean): number[] | null {
  const [ports, setPorts] = useState<{ sessionId: string; ports: number[] | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadSessionPorts(sessionId).then((found) => { if (live) setPorts({ sessionId, ports: found }); });
    return () => { live = false; };
  }, [sessionId, enabled]);
  return ports?.sessionId === sessionId ? ports.ports : null;
}

const NO_PORTS = "This session's ports are not known yet.";

/** Where a preview URL goes in this session, or why it cannot be opened. */
export function previewTarget(preview: RepositoryPreviewUrl, ports: readonly number[] | null): { url: string; error?: never } | { url?: never; error: string } {
  const expanded = expandPreviewUrl(preview.url, ports ?? []);
  if (expanded.url) return { url: expanded.url };
  return { error: !ports && /\$PORT/.test(preview.url) ? NO_PORTS : expanded.error! };
}

/** Open a preview URL in a TerminalX browser tab of the session, with its ports put in. */
export async function openPreview(session: Place, preview: RepositoryPreviewUrl, ports?: readonly number[] | null): Promise<void> {
  const known = ports === undefined ? await loadSessionPorts(session.id) : ports;
  const target = previewTarget(preview, known);
  if (!target.url) {
    showError(`Couldn't open ${preview.name}`, target.error, { key: `preview:${session.id}:${preview.id}` });
    return;
  }
  try {
    await openBrowserTab(session.id, session.cwd, target.url);
  } catch (cause) {
    showError(`Couldn't open ${preview.name}`, cause, { key: `preview:${session.id}:${preview.id}` });
  }
}

// ---------------------------------------------------------------- runs

/** An already running action whose tab was shown instead of starting it again. */
export interface RestartOffer {
  sessionId: string;
  action: RepositoryAction;
  paneId: string;
}

let offers: Record<string, RestartOffer> = {};
const offerListeners = new Set<() => void>();
function setOffer(sessionId: string, offer: RestartOffer | null) {
  const next = { ...offers };
  if (offer) next[sessionId] = offer;
  else delete next[sessionId];
  offers = next;
  for (const listener of offerListeners) listener();
}

export function useRestartOffer(sessionId: string): RestartOffer | null {
  return useSyncExternalStore(
    (listener) => { offerListeners.add(listener); return () => { offerListeners.delete(listener); }; },
    () => offers[sessionId] ?? null,
    () => offers[sessionId] ?? null,
  );
}

export function dismissRestartOffer(sessionId: string) {
  setOffer(sessionId, null);
}

const focusRun = (sessionId: string, run: ActionRun) => selectSessionTab(sessionId, { kind: "terminal", id: run.paneId });

/**
 * Run a saved action in a terminal tab of the session and show that tab. A
 * non-concurrent action that is already running is shown instead, with an
 * offer to restart it; `restart` replaces that run.
 */
export async function startAction(session: Place, action: RepositoryAction, options: { restart?: boolean } = {}): Promise<void> {
  dismissRestartOffer(session.id);
  try {
    const outcome = await runAction(session.id, action.id, { restart: options.restart });
    focusRun(session.id, outcome.run);
    if (!outcome.started) setOffer(session.id, { sessionId: session.id, action, paneId: outcome.run.paneId });
  } catch (cause) {
    showError(`Couldn't run ${action.name}`, cause, { key: `action:${session.id}:${action.id}` });
  }
}

/** The latest run of each action in the session, kept up to date while `enabled`. */
export function useActionRuns(sessionId: string, enabled: boolean): Map<string, ActionRun> {
  const [runs, setRuns] = useState<{ sessionId: string; runs: Map<string, ActionRun> } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stop: (() => void) | null = null;
    let live = true;
    void watchActionStates(sessionId, (list) => { if (live) setRuns({ sessionId, runs: latestByAction(list) }); })
      .then((unwatch) => { if (live) stop = unwatch; else unwatch(); })
      .catch(() => undefined);
    return () => { live = false; stop?.(); };
  }, [sessionId, enabled]);
  return runs?.sessionId === sessionId ? runs.runs : EMPTY_RUNS;
}
const EMPTY_RUNS = new Map<string, ActionRun>();

/** "Running", "Exited 0", "Exited 1"; "Exited" when a signal ended it or its code was not heard. */
export function runStateText(run: ActionRun | undefined): string | null {
  if (!run) return null;
  if (run.state === "running") return "Running";
  return run.exitCode == null ? "Exited" : `Exited ${run.exitCode}`;
}

/** The project's Run menu and Open button apply to this session: a local one, in its own checkout. */
export function offersRunMenu(session: SessionEntry, project: Project | undefined | null): project is Project {
  return !!project && !session.worktreeRemoved && (visibleActions(project.actions ?? []).length > 0 || (project.previewUrls?.length ?? 0) > 0);
}

// ---------------------------------------------------------------- the header controls

function RunState({ run }: { run: ActionRun | undefined }) {
  const text = runStateText(run);
  if (!text || !run) return null;
  return (
    <span
      className={cn("ml-auto flex shrink-0 items-center gap-1 pl-3 text-[11px]", run.state === "running" ? "text-success" : run.exitCode ? "text-destructive" : "text-faint")}
      data-testid="run-state"
    >
      {run.state === "running" && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {text}
    </span>
  );
}

export function RunMenu({ session, project, className }: { session: SessionEntry; project: Project; className?: string }) {
  const actions = visibleActions(project.actions ?? []);
  const previews = project.previewUrls ?? [];
  const runs = useActionRuns(session.id, actions.length > 0);
  const ports = useSessionPorts(session.id, previews.length > 0);
  const [open, setOpen] = useState(false);
  const keys = useShortcutKeys("session.runAction");
  const first = actions[0];

  // ⌘R: the one action, or the menu as a picker for several. With none it is not this menu's key.
  const onRunKey = useCallback(() => {
    if (!first) return false;
    if (actions.length === 1) void startAction(session, first);
    else setOpen(true);
  }, [actions.length, first, session]);
  useShortcut("session.runAction", onRunKey);

  const runningCount = actions.filter((action) => runs.get(action.id)?.state === "running").length;
  return (
    <div className={cn("flex items-stretch", className)} data-testid="run-controls">
      {actions.length > 0 && (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <WithTooltip label="Run an action" shortcut="session.runAction">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 px-2.5" aria-label={runningCount ? `Run, ${runningCount} running` : "Run"} data-testid="run-menu-trigger">
                <Play className="size-4" />
                <span className="@max-[560px]/session-header:hidden">Run</span>
                {runningCount > 0 && <span aria-hidden className="size-1.5 rounded-full bg-success" data-testid="run-menu-running" />}
                <ChevronDown className="size-3 text-faint" />
              </Button>
            </DropdownMenuTrigger>
          </WithTooltip>
          <DropdownMenuContent align="end" className="min-w-56 max-w-80" aria-label="Run" data-testid="run-menu">
            {/* ⌘R opens this menu as a picker when there are several actions, so the key is shown here, not on one of them. */}
            <DropdownMenuLabel className={cn(actions.length > 1 && "flex items-center")}>
              Run
              {actions.length > 1 && <span className="ml-auto flex" data-testid="run-menu-picker-key"><MenuShortcut keys={keys} /></span>}
            </DropdownMenuLabel>
            {actions.map((action, index) => {
              const run = runs.get(action.id);
              return (
                <DropdownMenuItem key={action.id} onSelect={() => void startAction(session, action)} data-action-id={action.id}>
                  <RepositoryIcon value={action.icon} />
                  <span className="min-w-0 truncate" title={action.command}>{action.name}</span>
                  <RunState run={run} />
                  {index === 0 && actions.length === 1 && !run && <MenuShortcut keys={keys} />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {previews.length > 0 && <OpenButton session={session} previews={previews} ports={ports} />}
    </div>
  );
}

function OpenButton({ session, previews, ports }: { session: SessionEntry; previews: RepositoryPreviewUrl[]; ports: number[] | null }) {
  const [first, ...rest] = previews;
  const target = previewTarget(first, ports);
  return (
    <div className="flex items-stretch" data-testid="open-controls">
      <WithTooltip label={target.url ? `Open ${first.name} · ${target.url}` : `${first.name}: ${target.error}`}>
        <Button
          variant="ghost"
          size="sm"
          className={cn("gap-1.5 px-2.5", !target.url && "opacity-50")}
          aria-label={`Open ${first.name}`}
          aria-disabled={!target.url || undefined}
          onClick={() => void openPreview(session, first, ports)}
          data-testid="open-preview"
        >
          <Globe className="size-4" />
          <span className="@max-[560px]/session-header:hidden">Open</span>
        </Button>
      </WithTooltip>
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="px-1" aria-label="More preview URLs" data-testid="open-menu-trigger">
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56 max-w-80" aria-label="Open" data-testid="open-menu">
            <DropdownMenuLabel>More previews</DropdownMenuLabel>
            {rest.map((preview) => {
              const shown = previewTarget(preview, ports);
              return (
                <DropdownMenuItem key={preview.id} disabled={!shown.url} onSelect={() => void openPreview(session, preview, ports)} data-preview-id={preview.id}>
                  <Globe />
                  <span className="min-w-0 truncate">{preview.name}</span>
                  <span className="ml-auto min-w-0 truncate pl-3 text-[11px] text-faint" title={shown.url ?? shown.error}>{shown.url ?? shown.error}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Under the header: an action that was already running had its tab shown; offer to restart it. */
export function RunRestartOffer({ session }: { session: Place }) {
  const offer = useRestartOffer(session.id);
  const [busy, setBusy] = useState(false);
  if (!offer) return null;
  return (
    <div className="flex items-center gap-2 border-b border-hairline px-3 py-1.5 text-xs" role="status" data-testid="run-restart-offer">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span className="text-foreground">{offer.action.name}</span> is already running; its tab is shown.
      </span>
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void startAction(session, offer.action, { restart: true }).finally(() => setBusy(false));
        }}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
        Restart
      </Button>
      <Button size="xs" variant="ghost" aria-label="Dismiss" onClick={() => dismissRestartOffer(session.id)}>
        <X className="size-3" />
      </Button>
    </div>
  );
}
