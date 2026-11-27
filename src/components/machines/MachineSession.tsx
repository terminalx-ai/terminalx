import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { thisComputer } from "@/lib/platform";
import { ChevronDown, ChevronUp, LoaderCircle, Plus, RotateCw, SquareTerminal, Unplug, X } from "@/icons";
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
import { DockDot, dockTabClass, runDot, setupDot } from "@/components/terminal/TerminalDock";
import { useMachineSessionRuns } from "@/lib/machineRuns";
import { MachineChip, MachineLocation, tryingText, useTick } from "./connectionStatus";
import { MachineRunPane, MachineSetupPane } from "./MachineRunPanes";
import { MachineHiddenFeatures } from "./MachineFeatureNotice";
import { MachineMessage } from "./MachineMessage";
import { TabAccountMark } from "@/components/session/TabStrip";
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
  const terminalViewLabel = terminalView?.on ? "Back to chat" : "Show terminal view";
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
                  {/* Which of the machine's accounts its agent runs on, when it has several there (PRO-408). */}
                  <TabAccountMark tab={tab} />
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
          <WithTooltip label={terminalViewLabel} shortcut="session.toggleTerminalView">
            <button
              type="button"
              aria-label={terminalViewLabel}
              aria-pressed={terminalView.on}
              disabled={terminalView.disabled}
              onClick={terminalView.toggle}
              className={cn("flex shrink-0 items-center gap-1.5 px-3 text-[12px]", terminalView.on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
              data-testid="machine-terminal-view"
            >
              <KbdGroup keys={shortcutKeys("session.toggleTerminalView")} />
              {terminalView.on ? "chat view" : <SquareTerminal className="size-3.5" aria-hidden />}
            </button>
          </WithTooltip>
        )}
      </div>
      {closeError && (
        <p role="alert" className="border-b border-hairline px-3 py-1 text-xs text-destructive">
          {closeError}
        </p>
      )}
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
        <span className="min-w-0 flex-1 text-foreground">{name} disconnected {thisComputer}. Try again once it lets {thisComputer} back.</span>
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

/**
 * The right panel's terminals for a machine session (21.08): shells on the
 * machine in the session's folder, named after the machine ("Mac mini
 * terminal 1"), one shown at a time. They are the machine's: they keep
 * running when this Mac closes the view, and every paired computer lists
 * them.
 */
export function MachineTerminalDock({ cloud }: { cloud: CloudSessionModel }) {
  const machine = cloud.machine!;
  const prefs = usePrefs();
  const open = prefs.panelTerminalOpen;
  const { selected } = useCloudTerminals(cloud.workspaceKey);
  // Setup and Run (PRO-403): the machine's scripts for this session, and their runs there.
  const runs = useMachineSessionRuns(cloud);
  // Its shells, then each action's run, named by its action; the setup's terminal shows under Setup.
  const terminals = cloud.terminals.filter((terminal) => terminal.run?.kind !== "setup");
  const [fixed, setFixed] = useState<"setup" | "run" | null>(null);
  const current: CloudTerminal | undefined = terminals.find((terminal) => terminal.id === selected) ?? terminals.at(-1);
  const view = fixed ?? "terminal";
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [height, setHeight] = useState(() => clampHeight(prefs.panelTerminalHeight));
  const dragging = useRef<{ y: number; h: number } | null>(null);
  const label = (terminal: CloudTerminal) => (terminal.run?.kind === "action" ? terminal.run.name : `${machine.name} terminal ${terminal.number}`);
  const shells = terminals.filter((terminal) => !terminal.run);
  const setupMark = setupDot(runs?.info?.setup ?? undefined);
  const runMark = runDot([...(runs?.source.runs.values() ?? [])]);
  const showTerminal = (id: string) => {
    selectCloudTerminal(cloud.workspaceKey, id);
    setFixed(null);
    setPrefs({ panelTerminalOpen: true });
  };
  const showFixed = (tab: "setup" | "run") => {
    setFixed(tab);
    setPrefs({ panelTerminalOpen: true });
  };

  const add = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    setPrefs({ panelTerminalOpen: true });
    try {
      await cloud.openTerminal();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };
  const toggle = () => {
    if (open) return setPrefs({ panelTerminalOpen: false });
    if (!terminals.length && cloud.connected) return void add();
    setPrefs({ panelTerminalOpen: true });
  };
  const closeOne = (terminal: CloudTerminal) => void closeCloudTerminal(cloud.workspaceKey, cloud.client, terminal.id).catch((e: unknown) => setError(errorMessage(e)));
  // A terminal another surface opened (the "+" menu, a shortcut) shows here, in the open dock.
  const shown = useRef(selected);
  useLayoutEffect(() => {
    if (selected && selected !== shown.current && terminals.some((terminal) => terminal.id === selected)) {
      setFixed(null);
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
          {runs && (
            <>
              <button type="button" role="tab" aria-selected={open && view === "setup"} title={setupMark.label} onClick={() => showFixed("setup")} className={dockTabClass(open && view === "setup")}>
                Setup<DockDot {...setupMark} />
              </button>
              <button type="button" role="tab" aria-selected={open && view === "run"} title={runMark.label} onClick={() => showFixed("run")} className={dockTabClass(open && view === "run")}>
                Run<DockDot {...runMark} />
              </button>
            </>
          )}
          {!shells.length && (
            <button type="button" onClick={() => (terminals.length ? void add() : toggle())} disabled={!cloud.connected} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
              {machine.name} terminal
            </button>
          )}
          {terminals.map((terminal) => {
            const on = open && view === "terminal" && terminal.id === current?.id;
            return (
              <div key={terminal.id} className="group relative flex shrink-0 items-stretch">
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => showTerminal(terminal.id)}
                  className={cn("border-b text-xs", on ? "border-foreground/60 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
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
          {view === "setup" && runs && <MachineSetupPane cloud={cloud} runs={runs} />}
          {view === "run" && runs && <MachineRunPane cloud={cloud} runs={runs} onShow={showTerminal} />}
          {view === "terminal" && !cloud.connected && !terminals.length && <p className="px-3 py-2 text-xs text-muted-foreground">Terminals open once {machine.name} is connected.</p>}
          {view === "terminal" && current && cloud.client && (
            <CloudTerminalPane
              key={current.id}
              workspace={cloud.workspaceKey}
              terminal={current}
              client={cloud.client}
              connected={cloud.connected}
              manage={cloud.manage}
              mayControl={cloud.mayControlTerminals}
              base={cloud.terminalBase}
            />
          )}
        </div>
      )}
    </section>
  );
}
