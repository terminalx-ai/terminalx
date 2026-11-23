import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { joinKeycaps } from "@/lib/shortcuts";
import { useShortcutKeys } from "@/lib/hotkeys";
import { ChevronDown, ChevronUp, Plus, Smartphone, X } from "@/icons";
import { ConnectedDevices, useConnectedDevices } from "@/components/pairing/ConnectedDevices";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { closeTerminal, dockPanes, openDockTerminal, selectSessionTab, useTerminals } from "@/lib/terminal";
import { useSessionStore } from "@/lib/sessions";
import { visibleActions, type RepositoryAction } from "@/lib/repositoryActions";
import type { ActionRun } from "@/lib/actionRunner";
import { RepositoryIcon } from "@/components/ui/IconPicker";
import { runStateText, startAction, useActionRuns } from "@/components/session/RunMenu";
import { TerminalView } from "./TerminalView";
import { useWorkspaceSetups, type WorkspaceSetup } from "@/lib/workspaceSetup";
import { WorkspaceSetupPane, setupStatus } from "./WorkspaceSetupPane";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 800;
const clampHeight = (h: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));

/** Where the project's run actions are saved, for the Run tab's empty state. */
const RUN_ACTIONS_PLACE = "Settings → Projects → Actions";

export const dockTabClass = (selected: boolean) => cn("flex shrink-0 items-center border-b text-xs", selected ? "border-foreground/60 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground");

export function DockDot({ label, className }: { label: string; className: string }) {
  return <span role="img" aria-label={label} title={label} className={cn("ml-1.5 inline-block size-1.5 shrink-0 rounded-full", className)} />;
}

export function setupDot(setup: Pick<WorkspaceSetup, "status" | "exitCode"> | undefined) {
  if (!setup) return { label: "Setup not run", className: "ring-1 ring-muted-foreground/60 ring-inset" };
  const className = setup.status === "failed" ? "bg-destructive" : setup.status === "succeeded" ? "bg-add" : setup.status === "stopped" ? "bg-muted-foreground" : "bg-warning animate-pulse";
  return { label: setupStatus(setup), className };
}

/** Running when any action runs; else the latest exit; hollow when nothing has run. */
export function runDot(runs: ActionRun[]) {
  if (runs.some((run) => run.state === "running")) return { label: "Running", className: "bg-add" };
  const last = [...runs].sort((a, b) => (a.ended ?? a.started).localeCompare(b.ended ?? b.started)).at(-1);
  if (!last) return { label: "Not running", className: "ring-1 ring-muted-foreground/60 ring-inset" };
  return { label: runStateText(last) ?? "Exited", className: last.exitCode ? "bg-destructive" : "bg-muted-foreground" };
}

/**
 * The right panel's terminals: shells in the session's folder, below the
 * panel's tabs. Any number of them, one shown at a time; folded, only the
 * tab row stays. They are the session's, so each window lists the same ones
 * and they close with the session.
 */
export function TerminalDock({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const prefs = usePrefs();
  const open = prefs.panelTerminalOpen;
  const connected = useConnectedDevices();
  const deviceCount = connected.devices.length;
  const deviceTabId = useId();
  const devicePanelId = useId();
  const showConnectedDevices = !open && deviceCount > 0;
  const toggleLabel = open ? "Hide terminal" : showConnectedDevices
    ? `Show Device tab (${deviceCount} connected ${deviceCount === 1 ? "phone" : "phones"})`
    : "Show terminal";
  const terminals = useTerminals();
  const panes = dockPanes(sessionId, terminals.panes);
  const moved = panes.find((pane) => pane.id === terminals.active[sessionId])?.id;
  const setups = useWorkspaceSetups();
  const setup = setups.runs.find((run) => run.sessionId === sessionId);
  const store = useSessionStore();
  const session = store.sessions.find((entry) => entry.id === sessionId);
  const project = store.projects.find((entry) => entry.path === session?.projectPath);
  const actions = visibleActions(project?.actions ?? []);
  const actionRuns = useActionRuns(sessionId, actions.length > 0);
  const runs = actions.map((action) => actionRuns.get(action.id)).filter((run): run is ActionRun => !!run);
  // A workspace's own checkout runs setup; the project's folder does not.
  const setupHere = !!session && session.cwd !== session.projectPath;
  /** A fixed tab or a docked shell's pane id. */
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const current = panes.find((pane) => pane.id === picked) ?? panes.at(-1);
  const view = picked === "setup" || picked === "run" || picked === "device" ? picked : current ? "terminal" : "setup";
  const showingSetup = view === "setup";
  const showingRun = view === "run";
  useEffect(() => {
    if (setups.shown?.sessionId === sessionId) setPicked("setup");
  }, [sessionId, setups.shown]);
  const [height, setHeight] = useState(() => clampHeight(prefs.panelTerminalHeight));
  useLayoutEffect(() => {
    if (moved) setPicked(moved);
  }, [moved, sessionId]);
  const dragging = useRef<{ y: number; h: number } | null>(null);

  const add = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    setPrefs({ panelTerminalOpen: true });
    try {
      const pane = await openDockTerminal(sessionId, cwd);
      setPicked(pane.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }, [sessionId, cwd, starting]);

  const show = (tab: string) => {
    setPicked(tab);
    setPrefs({ panelTerminalOpen: true });
  };
  const toggle = () => {
    if (open) return setPrefs({ panelTerminalOpen: false });
    if (showConnectedDevices) return show("device");
    if (!panes.length && !setup && view !== "device") return void add();
    setPrefs({ panelTerminalOpen: true });
  };
  const setupMark = setupDot(setup);
  const runMark = runDot(runs);

  // Exited shells keep their output until explicitly closed, including a
  // shell moved here from a tab to inspect its final error.

  const onDown = (e: React.PointerEvent) => {
    dragging.current = { y: e.clientY, h: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragging.current;
    if (d) setHeight(clampHeight(d.h - (e.clientY - d.y)));
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = null;
    setPrefs({ panelTerminalHeight: height });
  };

  return (
    <section
      aria-label="Terminal"
      data-testid="panel-terminal"
      className="relative flex shrink-0 flex-col border-t border-hairline bg-background"
      style={open ? { height, maxHeight: "75%" } : undefined}
    >
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          className="absolute -top-1 left-0 z-10 h-2 w-full cursor-row-resize hover:bg-ring/30"
        />
      )}
      <div className="flex h-8 shrink-0 items-center gap-1 px-1.5">
        <Button variant="ghost" size="icon-xs" aria-label={toggleLabel} title={showConnectedDevices ? toggleLabel : undefined} aria-expanded={open} onClick={toggle} className="relative shrink-0 text-muted-foreground">
          {open ? <ChevronDown /> : <ChevronUp />}
          {showConnectedDevices && (
            <span className="absolute -right-0.5 -top-0.5 rounded-sm bg-background text-add" aria-hidden="true">
              <Smartphone className="size-3" />
            </span>
          )}
        </Button>
        <div role="tablist" aria-label="Terminals" className="flex h-full min-w-0 flex-1 items-stretch gap-3 overflow-x-auto pr-2">
          <button type="button" role="tab" aria-selected={open && showingSetup} title={setup ? setupStatus(setup) : "Setup"} onClick={() => show("setup")} className={dockTabClass(open && showingSetup)}>
            Setup<DockDot {...setupMark} />
          </button>
          <button type="button" role="tab" aria-selected={open && showingRun} title={runMark.label} onClick={() => show("run")} className={dockTabClass(open && showingRun)}>
            Run<DockDot {...runMark} />
          </button>
          {!panes.length && (
            <button type="button" role="tab" aria-selected={false} onClick={() => void add()} className={dockTabClass(false)}>
              Terminal
            </button>
          )}
          {panes.map((pane) => {
            const selected = open && view === "terminal" && pane.id === current?.id;
            const label = panes.length === 1 ? "Terminal" : pane.title;
            return (
              <div key={pane.id} className="group relative flex shrink-0 items-stretch">
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => show(pane.id)}
                  className={dockTabClass(selected)}
                >
                  {label}
                </button>
                {/* Over the label's end on hover, so it takes no room and the underline is the label's alone. */}
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={() => void closeTerminal(pane.id)}
                  className="absolute top-1/2 right-0 flex size-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-sm bg-background text-muted-foreground opacity-0 ring-1 ring-hairline hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <button
            id={deviceTabId}
            type="button"
            role="tab"
            aria-selected={open && view === "device"}
            aria-controls={open && view === "device" ? devicePanelId : undefined}
            onClick={() => show("device")}
            className={dockTabClass(open && view === "device")}
          >
            {deviceCount > 0 ? `Device · ${deviceCount}` : "Device"}
          </button>
        </div>
        <WithTooltip label="New terminal">
          <Button variant="ghost" size="icon-xs" aria-label="New terminal" disabled={starting} onClick={() => void add()} className="text-muted-foreground">
            <Plus />
          </Button>
        </WithTooltip>
      </div>
      {open && (
        <div className="relative min-h-0 flex-1">
          {error && (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {showingSetup && (setup
            ? <WorkspaceSetupPane key={setup.paneId} run={setup} />
            : <WorkspaceSetupPane sessionId={setupHere ? sessionId : undefined} script={project?.scripts?.setup} />)}
          {showingRun && <DockRun sessionId={sessionId} cwd={cwd} actions={actions} runs={actionRuns} />}
          {view === "device" && (
            <div id={devicePanelId} role="tabpanel" aria-labelledby={deviceTabId} className="h-full">
              <ConnectedDevices {...connected} />
            </div>
          )}
          {panes.map((pane) => (
            <div key={pane.id} className={cn("absolute inset-0", (view !== "terminal" || pane.id !== current?.id) && "invisible")}>
              {/* The terminal's own header row (title, Move to tab, Clear); the dock's row has no Move button of its own. */}
              <TerminalView id={pane.id} visible={view === "terminal" && pane.id === current?.id} redraw={false} moveToTab />
              {pane.exited && <span className="absolute bottom-2 left-3 rounded bg-popover px-2 py-1 text-[11px] text-muted-foreground">Process exited{pane.exitCode != null ? ` (${pane.exitCode})` : ""}.</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The dock's Run tab: the project's run actions (Settings → Projects →
 * Actions), each with its latest run's state. Run and Restart go through the
 * Run menu's own `startAction`; a run's output is its terminal tab, which
 * Show brings forward.
 */
function DockRun({ sessionId, cwd, actions, runs }: { sessionId: string; cwd: string; actions: RepositoryAction[]; runs: Map<string, ActionRun> }) {
  const runKeys = joinKeycaps(useShortcutKeys("session.runAction"));
  if (!actions.length) {
    return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="run-empty">
      <h3 className="text-[10.5px] font-medium tracking-[0.08em] text-faint uppercase">Run</h3>
      <p className="text-xs text-muted-foreground">No run script yet. Add one in <span className="text-foreground">{RUN_ACTIONS_PLACE}</span>: it starts the project's dev server or app{runKeys ? <>, and {runKeys} runs it</> : null}.</p>
    </div>;
  }
  return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="run-pane">
    <h3 className="text-[10.5px] font-medium tracking-[0.08em] text-faint uppercase">Run</h3>
    <ul className="flex flex-col gap-1.5">
      {actions.map((action) => {
        const run = runs.get(action.id);
        const running = run?.state === "running";
        const state = runStateText(run);
        return <li key={action.id} data-action-id={action.id} className="flex min-w-0 items-center gap-2 rounded-md border border-hairline bg-veil-card px-2.5 py-1.5">
          <RepositoryIcon value={action.icon} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs text-foreground">{action.name}</span>
            <code className="truncate font-mono text-[11px] text-muted-foreground" title={action.command}>{action.command}</code>
          </div>
          {state && <span className={cn("shrink-0 text-[11px]", running ? "text-add" : run?.exitCode ? "text-destructive" : "text-faint")}>{state}</span>}
          {run && <Button size="xs" variant="ghost" onClick={() => selectSessionTab(sessionId, { kind: "terminal", id: run.paneId })}>Show</Button>}
          <Button size="xs" variant="outline" onClick={() => void startAction({ id: sessionId, cwd }, action, { restart: running && !action.concurrent })}>
            {running && !action.concurrent ? "Restart" : "Run"}
          </Button>
        </li>;
      })}
    </ul>
  </div>;
}
