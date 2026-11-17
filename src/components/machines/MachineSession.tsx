import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, LoaderCircle, Plus, RotateCw, Unplug, X } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { CloudTerminalPane } from "@/components/cloud/CloudTerminalPane";
import { Button } from "@/components/ui/button";
import { KbdGroup, WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { syncLiveTabs } from "@/lib/cloudAgents";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { closeCloudTerminal, selectCloudTerminal, useCloudTerminals, type CloudTerminal } from "@/lib/cloudTerminals";
import { shortcutKeys } from "@/lib/hotkeys";
import { isMachineDisconnected, reconnectMachine, refreshPairedMachines } from "@/lib/machineConnections";
import { machineAgentScope } from "@/lib/machineCatalog";
import { machineVersionView, useThisVersion } from "@/lib/machineUpdate";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { selectSessionTab, type SelectedSessionTab } from "@/lib/terminal";
import { selectCloudWorkspace } from "@/lib/sessions";
import { TAB_STATUS_LABEL, type SessionEntry, type TabStatus } from "@/types/session";
import { machineSectionKey, parseMachineKey } from "@/types/target";
import type { MachineConnectionState } from "@/types/machines";
import type { MachineSetupRun } from "@terminalx/portable/workspace";
import { setupSettling, type MachineScriptRun, type MachineSessionScripts } from "@/lib/machineSessionRuns";
import { MachineRunRestartOffer, machineRunsByAction, runStateText, showMachineRun, startMachineAction } from "@/components/session/RunMenu";
import { Dot, RUN_ACTIONS_PLACE, tabClass } from "@/components/terminal/TerminalDock";
import { SETUP_SCRIPT_PLACE } from "@/components/terminal/WorkspaceSetupPane";
import { RepositoryIcon } from "@/components/ui/IconPicker";
import { MachineChip, MachineLocation, tryingText, useTick } from "./connectionStatus";
import { MachineHiddenFeatures } from "./MachineFeatureNotice";
import { MachineMessage } from "./MachineMessage";
import { AddMachineDialog } from "./AddMachineDialog";

export { MACHINE_LOCAL_ONLY } from "./MachineMessage";

/** The header's first mark for a machine session: the machine, its state and route (21.08, 21.09). */
export function MachineSessionChip({ cloud }: { cloud: CloudSessionModel }) {
  const machine = cloud.machine!;
  const view = machineVersionView(machine.record, machine.state, cloud.client, cloud.ports.state, useThisVersion());
  return <MachineChip machine={machine.record} name={machine.name} state={view.shownState} />;
}

const STATUS_DOT: Partial<Record<TabStatus, string>> = {
  waiting: "bg-warning",
  completed: "bg-add",
  in_progress: "bg-info animate-pulse-soft",
};

/**
 * Under a machine session's title bar (21.08): its agent tabs with the "+"
 * that adds one, the terminal view switch, then where it runs and how that
 * machine is reached, and what it hides or why it cannot be reached (21.09).
 */
export function MachineSessionStrips({
  session,
  selected,
  cloud,
  newTab,
  terminalView,
}: {
  session: SessionEntry;
  selected: SelectedSessionTab | null;
  cloud: CloudSessionModel;
  /** The "+" that opens a tab (the cloud session's tab actions). */
  newTab: ReactNode;
  /** The chat or terminal switch of the open tab, when it has one. */
  terminalView: { on: boolean; disabled: boolean; toggle: () => void } | null;
}) {
  const machine = cloud.machine!;
  const view = machineVersionView(machine.record, machine.state, cloud.client, cloud.ports.state, useThisVersion());
  const [closeError, setCloseError] = useState<string | null>(null);
  const close = async (tabId: string) => {
    setCloseError(null);
    const client = cloud.client;
    try {
      if (!client) throw new Error(`Tabs close once ${machine.name} is connected.`);
      const runtimeId = parseMachineKey(session.id)?.sessionId;
      if (!runtimeId) return;
      await client.closeAgentTab(runtimeId, tabId, true);
      await syncLiveTabs(machineAgentScope(machine.machineId), client).catch(() => undefined);
    } catch (error) {
      setCloseError(errorMessage(error));
    }
  };
  return (
    <>
      <div className="flex h-9 shrink-0 items-stretch border-b border-hairline pl-2" role="tablist" aria-label="Tabs" data-testid="machine-tab-strip">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {session.tabs.map((tab) => {
            const on = selected?.kind === "agent" && selected.id === tab.id;
            const dot = tab.status ? STATUS_DOT[tab.status] : undefined;
            return (
              <div key={tab.id} className={cn("group relative flex min-w-[4.75rem] max-w-56 shrink items-center", on && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-t-full after:bg-foreground")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => selectSessionTab(session.id, { kind: "agent", id: tab.id })}
                  className={cn("flex h-full min-w-0 items-center gap-1.5 pr-6 pl-2 text-[12.5px]", on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                  title={tab.title ?? undefined}
                >
                  <AgentMark id={tab.harness} className="size-3.5 shrink-0" decorative />
                  <span className="truncate">{tab.title || tab.harness}</span>
                  {dot && <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-label={TAB_STATUS_LABEL[tab.status!]} />}
                </button>
                {cloud.manage && (
                  <button
                    type="button"
                    aria-label={`Close ${tab.title || tab.harness}`}
                    onClick={() => void close(tab.id)}
                    className="absolute right-1 flex size-4 items-center justify-center rounded-sm text-faint opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
          <div className="flex shrink-0 items-center [&_button]:size-7">{newTab}</div>
        </div>
        {terminalView && (
          <WithTooltip label={terminalView.on ? "Back to chat" : "Show terminal view"} shortcut="session.toggleTerminalView">
            <button
              type="button"
              aria-pressed={terminalView.on}
              disabled={terminalView.disabled}
              onClick={terminalView.toggle}
              className={cn("flex shrink-0 items-center gap-1.5 px-3 text-[12px]", terminalView.on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
              data-testid="machine-terminal-view"
            >
              <KbdGroup keys={shortcutKeys("session.toggleTerminalView")} />
              {terminalView.on ? "chat view" : "terminal view"}
            </button>
          </WithTooltip>
        )}
      </div>
      {closeError && (
        <p role="alert" className="border-b border-hairline px-3 py-1 text-xs text-destructive">
          {closeError}
        </p>
      )}
      {/* Under the header, as a local session's: an action already running on the machine, with the offer to restart it there. */}
      <MachineRunRestartOffer cloud={cloud} />
      <MachineLocation machine={machine.record} name={machine.name} state={machine.state} />
      <MachineHiddenFeatures machineId={machine.machineId} view={view} />
      <MachineConnectionNotice machineId={machine.machineId} name={machine.name} state={machine.state} />
    </>
  );
}

/**
 * The session while its machine is not there (21.09, "Session while
 * reconnecting" and the inline messages): what is happening, and that the
 * agent keeps working on the machine. The composer keeps what is typed and
 * says it cannot send until the machine is back.
 */
export function MachineConnectionNotice({ machineId, name, state }: { machineId: string; name: string; state: MachineConnectionState }) {
  useTick(state.state === "reconnecting");
  const [pairing, setPairing] = useState(false);
  if (state.state === "connecting" || state.state === "reconnecting" || state.state === "updating") {
    const title = state.state === "updating" ? `${name} is updating` : state.state === "connecting" ? `Connecting to ${name}` : `Reconnecting to ${name}`;
    const trying = state.state === "updating" ? "Back in under a minute." : tryingText(state.trying);
    const detail = [trying, "The agent keeps working there."].filter(Boolean).join(" ");
    return (
      <div className="flex shrink-0 items-start gap-2.5 border-b border-hairline px-4 py-2.5 text-[12.5px]" role="status" data-testid="machine-session-reconnecting">
        <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-warning" aria-hidden />
        <div className="min-w-0">
          <div className="text-foreground">{title}</div>
          <div className="text-muted-foreground">{detail}</div>
        </div>
      </div>
    );
  }
  if (state.state === "offline") {
    return (
      <div className="shrink-0 border-b border-hairline px-3 py-2" data-testid="machine-session-unreachable" data-state="offline">
        <MachineMessage
          kind="unreachable"
          name={name}
          action={
            <Button size="xs" variant="outline" onClick={() => void reconnectMachine(machineId)}>
              <RotateCw /> Try again
            </Button>
          }
        />
      </div>
    );
  }
  if (state.state === "accessRemoved") {
    // Revoked on the machine: pairing again is the way back (AC: "offers pairing again").
    return (
      <div className="shrink-0 border-b border-hairline px-3 py-2" data-testid="machine-session-unreachable" data-state="accessRemoved">
        <MachineMessage
          kind="accessRemoved"
          name={name}
          action={
            <>
              <Button size="xs" variant="outline" onClick={() => setPairing(true)}>
                Pair again
              </Button>
              <Button size="xs" variant="ghost" onClick={() => selectCloudWorkspace(machineSectionKey(machineId))}>
                Machine settings
              </Button>
            </>
          }
        />
        <AddMachineDialog open={pairing} onOpenChange={setPairing} onPaired={() => void refreshPairedMachines().then(() => reconnectMachine(machineId))} />
      </div>
    );
  }
  if (state.state === "disconnected") {
    // The person on the machine pressed Disconnect (PRO-357): nothing retries until Try again, which works once they let this Mac back.
    return (
      <div className="flex shrink-0 items-center gap-2.5 border-b border-hairline px-4 py-2 text-[12.5px]" role="status" data-testid="machine-session-unreachable" data-state="disconnected">
        <Unplug className="size-3.5 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0 flex-1 text-foreground">{name} disconnected this Mac. Try again once it lets this Mac back.</span>
        <Button size="xs" variant="outline" onClick={() => void reconnectMachine(machineId)}>
          <RotateCw /> Try again
        </Button>
      </div>
    );
  }
  if (state.state === "idle" && isMachineDisconnected(machineId)) {
    // Let go of with Disconnect: nothing reconnects until Try again. (Idle before the first read at launch says nothing.)
    return (
      <div className="flex shrink-0 items-center gap-2.5 border-b border-hairline px-4 py-2 text-[12.5px]" role="status" data-testid="machine-session-disconnected">
        <Unplug className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 text-foreground">Not connected to {name}. Sessions there keep running.</span>
        <Button size="xs" variant="outline" onClick={() => void reconnectMachine(machineId)}>
          <RotateCw /> Try again
        </Button>
      </div>
    );
  }
  return null;
}


const MIN_HEIGHT = 120;
const MAX_HEIGHT = 800;
const clampHeight = (h: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));

const SETUP_STATUS: Record<MachineSetupRun["status"], string> = {
  pending: "Setup queued",
  running: "Setup running",
  stopping: "Stopping setup…",
  stopped: "Setup stopped",
  succeeded: "Setup succeeded",
  failed: "Setup failed",
};

/** "✓ Last setup finished · exit 0", "✗ Last setup failed · exit 7": the machine reports no timings. */
export function machineSetupOutcome(setup: MachineSetupRun): string {
  const exit = setup.exitCode == null ? "" : ` · exit ${setup.exitCode}`;
  switch (setup.status) {
    case "succeeded": return `✓ Last setup finished${exit}`;
    case "failed": return `✗ Last setup failed${exit}`;
    case "stopped": return `Last setup stopped${exit}`;
    case "running": return "Setup running…";
    default: return SETUP_STATUS[setup.status];
  }
}

function setupMark(setup: MachineSetupRun | null | undefined) {
  if (!setup) return { label: "Setup not run", className: "ring-1 ring-muted-foreground/60 ring-inset" };
  const className = setup.status === "failed" ? "bg-destructive" : setup.status === "succeeded" ? "bg-add" : setup.status === "stopped" ? "bg-muted-foreground" : "bg-warning animate-pulse";
  return { label: SETUP_STATUS[setup.status], className };
}

/** Running when any action runs on the machine; else the latest exit; hollow when nothing has run. */
function runMark(runs: readonly MachineScriptRun[]) {
  if (runs.some((run) => run.state === "running")) return { label: "Running", className: "bg-add" };
  const last = runs.at(-1);
  if (!last) return { label: "Not running", className: "ring-1 ring-muted-foreground/60 ring-inset" };
  return { label: runStateText(last) ?? "Exited", className: last.exitCode ? "bg-destructive" : "bg-muted-foreground" };
}

/** Which of the dock's views shows: a fixed tab the person picked, else what the selected terminal is. */
type DockView = "setup" | "run" | "terminal";

/**
 * The right panel's dock for a machine session (21.08): Setup and Run, then
 * shells on the machine in the session's folder, named after the machine
 * ("Mac mini terminal 1"), one shown at a time. All of it is the machine's:
 * Setup and Run read and start the session's scripts there (`scripts`,
 * `machine/7`), each run's output is its terminal on the machine, and the
 * shells keep running when this Mac closes the view.
 */
export function MachineTerminalDock({ cloud }: { cloud: CloudSessionModel }) {
  const machine = cloud.machine!;
  const scripts = cloud.scripts;
  const prefs = usePrefs();
  const open = prefs.panelTerminalOpen;
  const { selected } = useCloudTerminals(cloud.workspaceKey);
  const terminals = cloud.terminals;
  // A script run is shown under Setup or Run, not as a numbered shell.
  const shells = terminals.filter((terminal) => !terminal.run);
  const selectedTerminal = terminals.find((terminal) => terminal.id === selected);
  const [picked, setPicked] = useState<DockView | null>(null);
  const derived: DockView = selectedTerminal?.run ? (selectedTerminal.run.kind === "setup" ? "setup" : "run") : selectedTerminal || shells.length ? "terminal" : "setup";
  const view: DockView = scripts ? (picked ?? derived) : "terminal";
  const currentShell: CloudTerminal | undefined = (selectedTerminal && !selectedTerminal.run ? selectedTerminal : undefined) ?? shells.at(-1);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [height, setHeight] = useState(() => clampHeight(prefs.panelTerminalHeight));
  const dragging = useRef<{ y: number; h: number } | null>(null);
  const label = (terminal: CloudTerminal) => `${machine.name} terminal ${terminal.number}`;

  const add = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    setPrefs({ panelTerminalOpen: true });
    try {
      await cloud.openTerminal();
      setPicked(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };
  const show = (tab: DockView) => {
    setPicked(tab);
    setPrefs({ panelTerminalOpen: true });
  };
  const toggle = () => {
    if (open) return setPrefs({ panelTerminalOpen: false });
    if (!shells.length && !scripts?.info?.setup && !scripts?.runs.length && cloud.connected && cloud.manage) return void add();
    setPrefs({ panelTerminalOpen: true });
  };
  const closeOne = (terminal: CloudTerminal) => void closeCloudTerminal(cloud.workspaceKey, cloud.client, terminal.id).catch((e: unknown) => setError(errorMessage(e)));
  // A terminal another surface opened or showed (the "+" menu, the Run menu, a shortcut) shows here, in the open dock.
  const shown = useRef(selected);
  useLayoutEffect(() => {
    if (selected && selected !== shown.current && terminals.some((terminal) => terminal.id === selected)) {
      setPicked(null);
      setPrefs({ panelTerminalOpen: true });
    }
    shown.current = selected;
  }, [selected, terminals]);
  useEffect(() => setError(null), [cloud.connected]);

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

  const setupDot = setupMark(scripts?.info?.setup);
  const runDot = runMark(scripts?.runs ?? []);
  return (
    <section aria-label="Terminal" data-testid="machine-terminal-dock" className="relative flex shrink-0 flex-col border-t border-hairline bg-background" style={open ? { height, maxHeight: "75%" } : undefined}>
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
        <Button variant="ghost" size="icon-xs" aria-label={open ? "Hide terminal" : "Show terminal"} aria-expanded={open} onClick={toggle} className="text-muted-foreground">
          {open ? <ChevronDown /> : <ChevronUp />}
        </Button>
        <div role="tablist" aria-label="Terminals" className="flex h-full min-w-0 flex-1 items-stretch gap-3 overflow-x-auto pr-2">
          {scripts && (
            <>
              <button type="button" role="tab" aria-selected={open && view === "setup"} title={setupDot.label} onClick={() => show("setup")} className={tabClass(open && view === "setup")}>
                Setup<Dot {...setupDot} />
              </button>
              <button type="button" role="tab" aria-selected={open && view === "run"} title={runDot.label} onClick={() => show("run")} className={tabClass(open && view === "run")}>
                Run<Dot {...runDot} />
              </button>
            </>
          )}
          {!shells.length && (
            <button type="button" onClick={() => void add()} disabled={!cloud.connected || !cloud.manage} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
              {machine.name} terminal
            </button>
          )}
          {shells.map((terminal) => {
            const on = open && view === "terminal" && terminal.id === currentShell?.id;
            return (
              <div key={terminal.id} className="group relative flex shrink-0 items-stretch">
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => {
                    selectCloudTerminal(cloud.workspaceKey, terminal.id);
                    show("terminal");
                  }}
                  className={tabClass(on)}
                >
                  {label(terminal)}
                </button>
                {cloud.manage && (
                  <button
                    type="button"
                    aria-label={`Close ${label(terminal)}`}
                    onClick={() => closeOne(terminal)}
                    className="absolute top-1/2 right-0 flex size-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-sm bg-background text-muted-foreground opacity-0 ring-1 ring-hairline hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <WithTooltip label={`New terminal on ${machine.name}`}>
          <Button variant="ghost" size="icon-xs" aria-label={`New terminal on ${machine.name}`} disabled={starting || !cloud.connected || !cloud.manage} onClick={() => void add()} className="text-muted-foreground">
            <Plus />
          </Button>
        </WithTooltip>
      </div>
      {open && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {error && (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {view === "setup" && scripts && <MachineSetupPane cloud={cloud} scripts={scripts} />}
          {view === "run" && scripts && <MachineRunPane cloud={cloud} scripts={scripts} selected={selectedTerminal?.run?.kind === "action" ? selectedTerminal.id : null} />}
          {view === "terminal" && (
            <>
              {!cloud.connected && !shells.length && <p className="px-3 py-2 text-xs text-muted-foreground">Terminals open once {machine.name} is connected.</p>}
              {currentShell && <MachinePane cloud={cloud} terminal={currentShell} />}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** One of the session's terminals on the machine, streamed into this window. */
function MachinePane({ cloud, terminal }: { cloud: CloudSessionModel; terminal: CloudTerminal }) {
  if (!cloud.client) return null;
  return (
    <CloudTerminalPane
      key={terminal.id}
      workspace={cloud.workspaceKey}
      terminal={terminal}
      client={cloud.client}
      connected={cloud.connected}
      manage={cloud.manage}
      mayControl={cloud.mayControlTerminals}
      base={cloud.terminalBase}
    />
  );
}

const PaneLabel = ({ children }: { children: ReactNode }) => <h3 className="text-[10.5px] font-medium tracking-[0.08em] text-faint uppercase">{children}</h3>;

/** Before the first read of the machine's scripts: why there is nothing yet. */
function ScriptsUnread({ scripts, name }: { scripts: MachineSessionScripts; name: string }) {
  if (scripts.error) return <p role="alert" className="text-xs text-destructive">{scripts.error}</p>;
  return <p className="text-xs text-muted-foreground">{scripts.blocked ?? `Reading ${name}'s scripts…`}</p>;
}

/**
 * The dock's Setup tab in a machine session: the setup script saved on the
 * machine, its latest attempt there, Stop and Rerun (`scripts.stopSetup`,
 * `scripts.rerunSetup`), and that attempt's terminal on the machine.
 */
export function MachineSetupPane({ cloud, scripts }: { cloud: CloudSessionModel; scripts: MachineSessionScripts }) {
  const name = cloud.machine!.name;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = scripts.info;
  const setup = info?.setup ?? null;
  const text = setup?.command || info?.setupScript?.trim() || "";
  const going = setupSettling(setup);
  const terminal = scripts.setupTerminalId ? cloud.terminals.find((item) => item.id === scripts.setupTerminalId) : undefined;
  const act = async (step: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!info) {
    return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="setup-pane">
      <PaneLabel>After setup</PaneLabel>
      <ScriptsUnread scripts={scripts} name={name} />
    </div>;
  }
  if (!setup && !text) {
    return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="setup-empty">
      <PaneLabel>After setup</PaneLabel>
      <p className="text-xs text-muted-foreground">No setup script on {name} yet. Add one to this project on {name}, in <span className="text-foreground">{SETUP_SCRIPT_PLACE}</span>: it runs once when a workspace is created there.</p>
    </div>;
  }
  return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="setup-pane">
    <div className="flex shrink-0 items-center gap-2">
      <div className="flex-1"><PaneLabel>After setup on {name}</PaneLabel></div>
      {going && setup && (
        <Button size="xs" variant="outline" disabled={busy || setup.status === "stopping" || !!scripts.blocked} title={scripts.blocked ?? undefined} onClick={() => void act(() => scripts.stopSetup())}>
          {setup.status === "stopping" ? "Stopping…" : "Stop"}
        </Button>
      )}
      {info.setupApplies && text && (
        <Button size="xs" variant="outline" disabled={busy || going || !!scripts.blocked} title={scripts.blocked ?? undefined} onClick={() => void act(() => scripts.rerunSetup())}>
          {setup ? "Rerun" : "Run setup"}
        </Button>
      )}
    </div>
    {text && <pre data-testid="setup-script" className="max-h-32 shrink-0 overflow-auto rounded-md border border-hairline bg-veil-card px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-foreground">{text}</pre>}
    {setup ? (
      <p role="status" data-testid="setup-outcome" className={cn("shrink-0 text-xs", setup.status === "succeeded" ? "text-add" : setup.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{machineSetupOutcome(setup)}</p>
    ) : (
      <p role="status" data-testid="setup-outcome" className="shrink-0 text-xs text-muted-foreground">
        {info.setupApplies ? "Not run in this workspace yet." : "Setup runs in a workspace's own worktree; this session works in the project's folder."}
      </p>
    )}
    {(error || setup?.error || scripts.error) && <p role="alert" className="shrink-0 text-xs text-destructive">{error ?? setup?.error ?? scripts.error}</p>}
    {setup && (
      <>
        <PaneLabel>Output</PaneLabel>
        <div className="relative flex min-h-32 flex-1 flex-col overflow-hidden rounded-md border border-hairline" data-testid="setup-output">
          {terminal ? <MachinePane cloud={cloud} terminal={terminal} /> : <p className="px-3 py-2 text-xs text-muted-foreground">{name} no longer keeps this setup's output.</p>}
        </div>
      </>
    )}
  </div>;
}

/**
 * The dock's Run tab in a machine session: the actions saved in the machine's
 * project, each with its latest run there. Run and Restart go through the Run
 * menu's `startMachineAction` (`scripts.run` on the machine); Show brings a
 * run's terminal forward, and the shown run's output is under the list.
 */
export function MachineRunPane({ cloud, scripts, selected }: { cloud: CloudSessionModel; scripts: MachineSessionScripts; selected: string | null }) {
  const name = cloud.machine!.name;
  const place = { sessionKey: cloud.session.id, workspaceKey: cloud.workspaceKey, name, scripts };
  const runs = machineRunsByAction(scripts);
  const actions = scripts.actions;
  // The run the person showed; else one still running; else the latest.
  const shownRun = scripts.runs.find((run) => run.terminalId === selected) ?? scripts.latestRuns.filter((run) => run.state === "running").at(-1) ?? scripts.runs.at(-1);
  const terminal = shownRun ? cloud.terminals.find((item) => item.id === shownRun.terminalId) : undefined;

  if (!scripts.info && !actions.length) {
    return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="run-pane">
      <PaneLabel>Run</PaneLabel>
      <ScriptsUnread scripts={scripts} name={name} />
    </div>;
  }
  if (!actions.length) {
    return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="run-empty">
      <PaneLabel>Run</PaneLabel>
      <p className="text-xs text-muted-foreground">
        {scripts.info?.available === false
          ? "This session's worktree was removed; nothing runs in it."
          : <>No run script on {name} yet. Add one to this project on {name}, in <span className="text-foreground">{RUN_ACTIONS_PLACE}</span>: it starts the project's dev server or app there, and ⌘R runs it.</>}
      </p>
    </div>;
  }
  return <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="run-pane">
    <PaneLabel>Run on {name}</PaneLabel>
    {scripts.blocked && <p className="text-xs text-muted-foreground" data-testid="run-blocked">{scripts.blocked}</p>}
    {scripts.error && <p role="alert" className="text-xs text-destructive">{scripts.error}</p>}
    <ul className="flex shrink-0 flex-col gap-1.5">
      {actions.map((action) => {
        const run = runs.get(action.id);
        const running = run?.state === "running";
        const restart = running && !action.concurrent;
        const state = runStateText(run);
        return <li key={action.id} data-action-id={action.id} className="flex min-w-0 items-center gap-2 rounded-md border border-hairline bg-veil-card px-2.5 py-1.5">
          <RepositoryIcon value={action.icon} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs text-foreground">{action.name}</span>
            <code className="truncate font-mono text-[11px] text-muted-foreground" title={action.command}>{action.command}</code>
          </div>
          {state && <span className={cn("shrink-0 text-[11px]", running ? "text-add" : run?.exitCode ? "text-destructive" : "text-faint")}>{state}</span>}
          {run && <Button size="xs" variant="ghost" onClick={() => showMachineRun(cloud.workspaceKey, run.ptyId)}>Show</Button>}
          <Button size="xs" variant="outline" disabled={!!scripts.blocked} title={scripts.blocked ?? undefined} onClick={() => void startMachineAction(place, action, { restart })}>
            {restart ? "Restart" : "Run"}
          </Button>
        </li>;
      })}
    </ul>
    {shownRun && (
      <>
        <PaneLabel>Output · {shownRun.name}</PaneLabel>
        <div className="relative flex min-h-32 flex-1 flex-col overflow-hidden rounded-md border border-hairline" data-testid="run-output" data-terminal-id={shownRun.terminalId}>
          {terminal && <MachinePane cloud={cloud} terminal={terminal} />}
        </div>
      </>
    )}
  </div>;
}
