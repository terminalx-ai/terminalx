import { useState } from "react";
import { thisComputer } from "@/lib/platform";
import { ChevronDown, Folder, FolderGit2, Plus, RotateCw, ShieldX, WifiOff } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { useFold } from "@/components/layout/useFold";
import { machineConnection, reconnectMachine, refreshPairedMachines, useMachineConnections } from "@/lib/machineConnections";
import { useMachineProjects, type MachineProjectNode } from "@/lib/machineCatalog";
import { useSidebarFilter } from "@/lib/sidebarFilter";
import { selectCloudWorkspace, useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";
import { machineSectionKey } from "@/types/target";
import type { MachineConnectionState, PairedMachine } from "@/types/machines";
import { MachineIcon, MachineStateMark, lastSeenSentence, machineStateHint, machineStateLabel, useTick } from "./connectionStatus";
import { AddMachineDialog } from "./AddMachineDialog";
import { MachineProjectGroup, shownMachineSessions } from "./MachineSidebarRows";
import { startMachineSession } from "./machineNewSession";

/**
 * The sidebar's machines (PRO-345, PRO-346, screen 21.01): one section per
 * paired machine. Its header is the machine's name with its live state
 * (`Direct`, `Relay`, `Offline · seen 14:02`), a + that starts a session in
 * one of its projects, and a fold; choosing the name opens the machine's view.
 * Under it come its projects, each with its sessions. A machine that cannot be
 * reached keeps its section, dimmed, with the sessions it last reported.
 * Nothing shows while no machine is paired.
 */
export function MachinesSection() {
  const store = useMachineConnections();
  const sessions = useSessionStore();
  if (!store.machines.length) return null;
  return (
    <div role="group" aria-label="Machines" className="min-w-0" data-testid="machines-section">
      {store.machines.map((machine) => {
        const { state, attachError } = machineConnection(store, machine.machineId);
        return (
          <MachineSection
            key={machine.machineId}
            machine={machine}
            state={state}
            attachError={attachError}
            selected={sessions.selectedCloudWorkspace === machineSectionKey(machine.machineId)}
          />
        );
      })}
    </div>
  );
}

function MachineSection({ machine, state, attachError, selected }: { machine: PairedMachine; state: MachineConnectionState; attachError: string | null; selected: boolean }) {
  const now = useTick(state.state === "reconnecting");
  const label = machineStateLabel(state, machine, { seen: true });
  const hint = attachError ? `Could not connect: ${attachError}` : machineStateHint(state, machine.name, now);
  const sectionKey = machineSectionKey(machine.machineId);
  const [open, toggle] = useFold(sectionKey, true);
  const store = useSessionStore();
  const filter = useSidebarFilter();
  const { entry, projects } = useMachineProjects(machine.machineId);
  // What it shows comes from the machine's live answers, or from what it last said.
  const reachable = entry?.source === "live";
  const showArchived = store.showArchived && filter.filter === "all";
  const groups = projects
    .map((node) => ({ node, sessions: shownMachineSessions(node.sessions, { showArchived, shows: filter.shows, selectedId: store.selectedSessionId }) }))
    // A filter shows only the projects it found something in.
    .filter(({ sessions }) => !filter.active || sessions.length > 0);
  const startable = projects.filter((node) => !node.project.archived);
  // The header's + and fold sit over the end of its row, beside the section rather than in it:
  // the section's own control is the header button that opens the machine.
  return (
    <div className="relative mb-5 min-w-0">
      <section
        aria-label={machine.name}
        className="min-w-0"
        data-testid="machine-section"
        data-machine={machine.machineId}
        data-state={state.state}
        data-reachable={reachable ? "true" : "false"}
      >
        <div className={cn("flex h-7 min-w-0 items-center rounded-md pr-14", selected ? "bg-selected" : "hover:bg-selected/40")}>
          <button
            type="button"
            onClick={() => selectCloudWorkspace(sectionKey)}
            aria-current={selected ? "page" : undefined}
            title={hint}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <MachineIcon machine={machine} className="size-3.5 shrink-0 text-muted-foreground" />
            {/* The name keeps its room; a long state ("Offline · seen 14:02") gives way first. */}
            <span className="min-w-0 max-w-[60%] shrink-0 truncate text-[13px] font-medium text-foreground">{machine.name}</span>
            <MachineStateMark state={state} className="ml-0.5" />
            <span className="min-w-0 shrink truncate text-[12px] text-faint" data-testid="machine-state-label">
              {label}
            </span>
          </button>
        </div>
        {attachError && (
          <p className="truncate px-2 pt-0.5 text-[12px] text-destructive" role="alert" title={attachError}>
            Could not connect: {attachError}
          </p>
        )}
        {open && groups.length > 0 && (
          <div
            className={cn("mt-0.5 flex flex-col gap-px pl-3.5 transition-opacity", !reachable && "opacity-60")}
            data-testid="machine-projects"
            title={reachable ? undefined : `${machine.name} cannot be reached: these are the sessions it last reported.`}
          >
            {groups.map(({ node, sessions }) => (
              <MachineProjectGroup key={node.key} node={node} sessions={sessions} reachable={reachable} filtered={filter.active} />
            ))}
          </div>
        )}
        {open && <MachineAwayCard machine={machine} state={state} />}
      </section>
      <div className="absolute right-1 top-0 flex h-7 items-center gap-0.5" data-testid="machine-header-actions" data-machine={machine.machineId}>
        <NewMachineSession machine={machine} projects={startable} />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${machine.name}` : `Expand ${machine.name}`}
          data-testid="machine-fold"
          className="text-faint"
        >
          <ChevronDown className={cn("transition-transform", !open && "-rotate-90")} />
        </Button>
      </div>
    </div>
  );
}

/** The header's +: straight into the new-agent form when the machine has one project, else a menu of them. */
function NewMachineSession({ machine, projects }: { machine: PairedMachine; projects: MachineProjectNode[] }) {
  const label = `New session on ${machine.name}`;
  const menu = useRowMenu();
  if (projects.length <= 1) {
    const only = projects[0];
    return (
      <WithTooltip label={only ? `New session in ${only.project.name}` : `${machine.name} lists no projects yet`}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={!only}
          className="text-faint"
          data-testid="machine-new-session"
          onClick={() => only && startMachineSession(machine.machineId, only.project.projectId)}
        >
          <Plus />
        </Button>
      </WithTooltip>
    );
  }
  return (
    <DropdownMenu {...menu.root}>
      <WithTooltip label={label}>
        <DropdownMenuTrigger asChild {...menu.trigger}>
          <Button variant="ghost" size="icon-xs" aria-label={label} className="text-faint" data-testid="machine-new-session">
            <Plus />
          </Button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end" className="w-[15rem]">
        <DropdownMenuLabel>New session in…</DropdownMenuLabel>
        {projects.map((node) => {
          const Glyph = node.project.kind === "git" ? FolderGit2 : Folder;
          return (
            <DropdownMenuItem key={node.key} onSelect={() => startMachineSession(machine.machineId, node.project.projectId)} title={node.project.path}>
              <Glyph /> <span className="truncate">{node.project.name}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Under a machine's rows while it cannot be reached (21.09, "Sidebar ·
 * machine can't be reached"): that it isn't reachable, when it was last seen,
 * that its sessions keep running and this list catches up when it
 * reconnects, with Try again and Machine settings. A machine that revoked
 * this Mac offers to pair again instead.
 */
export function MachineAwayCard({ machine, state }: { machine: PairedMachine; state: MachineConnectionState }) {
  const [pairing, setPairing] = useState(false);
  if (state.state !== "offline" && state.state !== "accessRemoved") return null;
  const removed = state.state === "accessRemoved";
  const seen = state.state === "offline" && state.lastSeenAt ? state.lastSeenAt : machine.lastSeenAt;
  const Icon = removed ? ShieldX : WifiOff;
  const title = removed ? `${machine.name} no longer allows ${thisComputer}` : `${machine.name} isn’t reachable`;
  const detail = removed
    ? `It was revoked on ${machine.name}. Sessions there keep running; pair again to see them here.`
    : [seen ? lastSeenSentence(seen) : null, "Sessions there keep running, and this list catches up when it reconnects."].filter(Boolean).join(" ");
  const settings = (
    <Button size="sm" variant="outline" onClick={() => selectCloudWorkspace(machineSectionKey(machine.machineId))}>
      Machine settings
    </Button>
  );
  return (
    <div className="mx-1 mt-1.5 grid gap-1.5 rounded-lg border border-hairline p-3" role="status" data-testid="machine-away-card" data-state={state.state}>
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
        <Icon className="size-3.5 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 truncate">{title}</span>
      </div>
      <p className="text-[12px] leading-[18px] text-muted-foreground">{detail}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {removed ? (
          <Button size="sm" onClick={() => setPairing(true)}>
            Pair again
          </Button>
        ) : (
          <Button size="sm" onClick={() => void reconnectMachine(machine.machineId)}>
            <RotateCw /> Try again
          </Button>
        )}
        {settings}
      </div>
      {removed && <AddMachineDialog open={pairing} onOpenChange={setPairing} onPaired={() => void refreshPairedMachines().then(() => reconnectMachine(machine.machineId))} />}
    </div>
  );
}
