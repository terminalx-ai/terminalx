import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ThisComputer, thisComputer } from "@/lib/platform";
import { Check, ChevronDown, Folder, GitBranch, Laptop, Plus, RefreshCw } from "@/icons";
import { WorkspaceRpcError, type MachineProject, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { RemoteGit, type RemoteBranch } from "@terminalx/portable/workspaceGit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { cloudProviderIcon, useCloudProviderDescriptors } from "@/lib/cloudProviders";
import { MachineIcon, machineViewStatus } from "@/components/machines/connectionStatus";
import { MachineMessage } from "@/components/machines/MachineMessage";
import { useRuntimeModels } from "@/lib/cloudModels";
import { useMachineCatalog } from "@/lib/machineCatalog";
import { machineConnection, useMachineConnections } from "@/lib/machineConnections";
import { machineFeatureMessage } from "@/lib/machineFeatures";
import { useClientState } from "@/lib/machineUpdate";
import { agentSignIn, machineWhereRow, pickMachineProject, type MachineAgentReport } from "@/lib/machineNewSession";
import { runningSessionCount, useFreeMemory } from "@/components/machines/useRunningSessions";
import { errorMessage, type Issue } from "@/lib/api";
import { runNewSessionHere, startCloudSessionIn, startMachineSessionIn, useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";
import type { MachineConnectionState, PairedMachine } from "@/types/machines";
import type { HarnessInfo } from "@/types/session";

/**
 * The machine half of the new-session form (PRO-348, screen 21.07): the
 * "Where it runs" menu, and with a machine chosen, its projects, the
 * project's branches there, and the line under the form that says the agent
 * is signed in there and the project exists there. None of it shows until a
 * machine is paired.
 */

/** A connected machine's live client; null while it is not connected. */
function liveClient(client: WorkspaceRpcClient | null | undefined, state: MachineConnectionState): WorkspaceRpcClient | null {
  if (!client || (state.state !== "direct" && state.state !== "relay")) return null;
  return client.connection.state === "connected" ? client : null;
}

/** The new-session form's machine, while a machine is chosen in its "Where it runs" menu. */
export interface MachineDraft {
  machineId: string;
  machine: PairedMachine | null;
  name: string;
  state: MachineConnectionState;
  /** The live connection; null while the machine is not connected. */
  client: WorkspaceRpcClient | null;
  /** Its projects, archived ones left out. */
  projects: MachineProject[];
  /** The project the session is created in. */
  project: MachineProject | null;
  /**
   * The project the form was on here, when the machine has none of that name
   * (21.09: "terminalx isn't a project on dev-server yet"); null otherwise,
   * and while its projects are not read yet.
   */
  missingProject: string | null;
  /** Its agents (`runtime.agents`); null until read. */
  agents: MachineAgentReport[] | null;
  /** This Mac's agent list narrowed to the ones the machine has, so the pickers name what it can run. */
  harnesses: HarnessInfo[];
}

/**
 * The machine the new-session form runs on, from the store's
 * `machineSessionPreset`; null for This Mac.
 * `wantedName` is the project the form was on here: the machine's project of
 * that name is chosen unless one was asked for.
 */
export function useMachineDraft(localHarnesses: HarnessInfo[], wantedName: string | null): MachineDraft | null {
  const store = useSessionStore();
  const preset = store.machineSessionPreset;
  const connections = useMachineConnections();
  const catalog = useMachineCatalog();
  const machineId = preset?.machineId ?? "";
  const { machine, state, connection } = machineConnection(connections, machineId);
  // The connection's own state, so the form follows a drop without waiting for the machine's next event.
  const clientState = useClientState(preset ? (connection?.client ?? null) : null);
  const client = clientState.state === "connected" ? liveClient(connection?.client, state) : null;
  const runtime = useRuntimeModels(client);
  const entry = catalog.machines[machineId];
  return useMemo(() => {
    if (!preset) return null;
    const projects = (entry?.projects ?? []).filter((project) => !project.archived);
    const agents = runtime?.agents ?? null;
    const harnesses = agents
      ? localHarnesses.filter((harness) => agents.some((agent) => agent.id === harness.id)).map((harness) => ({ ...harness, available: true }))
      : localHarnesses.map((harness) => ({ ...harness, available: true }));
    return {
      machineId,
      machine,
      name: machine?.name ?? "Machine",
      state,
      client,
      projects,
      project: pickMachineProject(projects, preset.projectId, wantedName),
      missingProject: !preset.projectId && wantedName && entry && !projects.some((project) => project.name === wantedName) ? wantedName : null,
      agents,
      harnesses,
    };
  }, [preset, entry, runtime, localHarnesses, machineId, machine, state, client, wantedName]);
}

const chip = "flex h-7 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12.5px] transition-colors hover:bg-veil-raised disabled:opacity-60";

/** A row of the "Where it runs" menu: an icon, the name, and its second line. */
function WhereItem({ icon, name, detail, chosen, disabled, onSelect, testId }: { icon: ReactNode; name: string; detail: ReactNode; chosen: boolean; disabled?: boolean; onSelect: () => void; testId: string }) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      data-testid={testId}
      aria-checked={chosen}
      role="menuitemradio"
      className={cn("items-start gap-2.5 whitespace-normal px-2.5 py-1.5 text-[12.5px] data-[disabled]:opacity-100", chosen && "bg-sel", disabled ? "text-faint [&_svg]:text-faint" : "text-foreground")}
    >
      <span className="mt-[3px] shrink-0 [&_svg]:!size-3.5">{icon}</span>
      <span className="min-w-0 flex-1">
        {name}
        <span className="mt-0.5 block text-[12px] leading-[17px] text-faint">{detail}</span>
      </span>
      {chosen && <Check className="mr-1 mt-[3px] !size-3.5 shrink-0 !text-accent" aria-hidden />}
    </DropdownMenuItem>
  );
}

/** One paired machine in the menu: its route, its running sessions and free memory, or why it cannot be chosen. */
export function MachineWhereItem({ machine, chosen, wantedProject, onSelect }: { machine: PairedMachine; chosen: boolean; wantedProject: string | null; onSelect: () => void }) {
  const connections = useMachineConnections();
  const catalog = useMachineCatalog();
  const { state, connection } = machineConnection(connections, machine.machineId);
  const client = liveClient(connection?.client, state);
  const runtime = useRuntimeModels(client);
  const free = useFreeMemory(client);
  const entry = catalog.machines[machine.machineId];
  const live = entry?.source === "live";
  const row = machineWhereRow({
    state,
    machine,
    running: live ? runningSessionCount(entry.sessions) : null,
    freeBytes: free,
    agents: runtime?.agents ?? null,
    projects: entry ? entry.projects : null,
    wantedProject,
  });
  return (
    <WhereItem
      testId={`where-machine-${machine.machineId}`}
      icon={<MachineIcon machine={machine} />}
      name={machine.name}
      detail={row.detail}
      chosen={chosen}
      disabled={!row.enabled}
      onSelect={onSelect}
    />
  );
}

/**
 * "Start on…" beside another place's start button (an issue's): the paired
 * machines as the "Where it runs" menu lists them. Choosing one opens the
 * new-session form on it (PRO-348). Nothing while no machine is paired.
 */
export function StartOnMachineMenu({ wantedProject, disabled, onPick, label = "Start on a machine" }: { wantedProject: string | null; disabled?: boolean; onPick: (machineId: string) => void; label?: string }) {
  const menu = useRowMenu();
  const { machines } = useMachineConnections();
  if (machines.length === 0) return null;
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <button type="button" disabled={disabled} aria-label={label} title={label} data-testid="start-on-machine" className={cn(chip, "h-8 text-muted-foreground")}>
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-1.5">
        <DropdownMenuLabel className="px-2.5 pb-1 pt-2 text-[11px] font-normal uppercase tracking-[.08em] text-faint">Start on</DropdownMenuLabel>
        {machines.map((machine) => (
          <MachineWhereItem key={machine.machineId} machine={machine} chosen={false} wantedProject={wantedProject} onSelect={() => onPick(machine.machineId)} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "~/code/terminalx": a home-relative path, as the screens write one. */
function homePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

export interface CloudWhere {
  orgId: string;
  orgName: string;
  /** The project a choice of this organization opens; null when none can be started. */
  startKey: string | null;
  projectCount: number;
  /** Why it cannot be chosen, if it cannot. */
  locked: string | null;
  provider?: string;
  providerLabel?: string;
  detail?: string | null;
}

/**
 * The "Where it runs" chip and its menu (21.07; 01.07 for This Mac): This
 * Mac, each paired machine, each organization's cloud, and "Add a
 * machine…". `lead` draws it first in the header, chosen (a machine);
 * otherwise it sits at the header's end.
 */
export function WhereMenu({
  lead,
  current,
  localProject,
  localWorktree,
  cloud,
  cloudSummaries,
  onCloud,
  onHere,
  onRecheckCloud,
  disabled,
  onAddMachine,
}: {
  lead: boolean;
  /** What runs it now: This Mac, a machine (by id), or an organization's cloud. */
  current: { kind: "local" } | { kind: "machine"; machineId: string; name: string; machine: PairedMachine | null } | { kind: "cloud"; orgId: string; orgName: string; provider?: string; providerLabel?: string };
  localProject: { name: string; path: string } | null;
  localWorktree: boolean;
  cloud: CloudWhere[];
  cloudSummaries?: string[];
  onCloud?: (row: CloudWhere) => void;
  onHere?: () => void;
  onRecheckCloud?: () => void;
  disabled?: boolean;
  onAddMachine: () => void;
}) {
  const menu = useRowMenu();
  useCloudProviderDescriptors();
  const { machines } = useMachineConnections();
  const label = current.kind === "local" ? ThisComputer : current.kind === "machine" ? current.name : current.providerLabel ? `${current.orgName} · ${current.providerLabel}` : `${current.orgName} cloud`;
  const ProviderIcon = cloudProviderIcon(current.kind === "cloud" ? current.provider : null);
  const icon = current.kind === "local" ? <Laptop className="size-[13px]" /> : current.kind === "machine" ? <MachineIcon machine={current.machine} className="size-[13px]" /> : <ProviderIcon className="size-[13px] shrink-0 text-info" />;
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Where it runs: ${label}`}
          data-testid={current.kind === "cloud" ? "cloud-runs-in" : "where-it-runs"}
          title="Where it runs"
          className={cn(chip, cloudSummaries && "max-w-full shrink", lead ? "bg-sel text-foreground" : "ml-auto text-[12px] text-muted-foreground")}
        >
          {icon}
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={lead ? "start" : "end"} className="w-96 max-w-[calc(100vw-2rem)] p-1.5" data-testid="where-menu">
        <DropdownMenuLabel className="px-2.5 pb-1 pt-2 text-[11px] font-normal uppercase tracking-[.08em] text-faint">Where it runs</DropdownMenuLabel>
        <WhereItem
          testId="where-this-mac"
          icon={<Laptop />}
          name={ThisComputer}
          detail={
            localProject ? (
              <>
                {localWorktree ? "New worktree in " : "In "}
                <span className="font-mono text-xs">{homePath(localProject.path)}</span>
              </>
            ) : (
              `Your projects on ${thisComputer}`
            )
          }
          chosen={current.kind === "local"}
          onSelect={onHere ?? runNewSessionHere}
        />
        {machines.map((machine) => (
          <MachineWhereItem
            key={machine.machineId}
            machine={machine}
            chosen={current.kind === "machine" && current.machineId === machine.machineId}
            wantedProject={localProject?.name ?? null}
            onSelect={() => startMachineSessionIn(machine.machineId, null)}
          />
        ))}
        {cloud.map((org) => {
          const Icon = cloudProviderIcon(org.provider);
          return (
            <WhereItem
              key={JSON.stringify([org.orgId, org.provider])}
              testId={`where-cloud-${org.orgId}${org.provider ? `-${org.provider}` : ""}`}
              icon={<Icon className="!text-info" />}
              name={org.providerLabel ? `${org.orgName} · ${org.providerLabel}` : `${org.orgName} cloud`}
              detail={org.locked ?? org.detail ?? `A cloud workspace of ${org.orgName} · ${org.projectCount} project${org.projectCount === 1 ? "" : "s"}`}
              chosen={current.kind === "cloud" && current.orgId === org.orgId && current.provider === org.provider}
              disabled={!org.startKey || (!!org.provider && !!org.locked)}
              onSelect={() => onCloud ? onCloud(org) : org.startKey && startCloudSessionIn(org.startKey)}
            />
          );
        })}
        <DropdownMenuSeparator />
        {onRecheckCloud && <DropdownMenuItem className="h-8 gap-2.5 px-2.5 text-[12.5px]" onSelect={onRecheckCloud}>
          <RefreshCw className="!size-3.5" />
          Recheck cloud placement
        </DropdownMenuItem>}
        <DropdownMenuItem className="h-8 gap-2.5 px-2.5 text-[12.5px]" onSelect={onAddMachine} data-testid="where-add-machine">
          <Plus className="!size-3.5" />
          Add a machine…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2.5 py-1.5 text-[12px] leading-[17px] text-faint">
          {cloudSummaries ? <>
            <p>Cloud placement works with GitHub repositories.</p>
            {cloudSummaries.map((summary) => <p key={summary}>{summary}</p>)}
          </> : <p>A session runs where it is created and uses that machine’s files, agent sign-ins and git.</p>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The machine's projects; choosing one keeps the machine. */
export function MachineProjectMenu({ draft, disabled }: { draft: MachineDraft; disabled?: boolean }) {
  const menu = useRowMenu();
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <button type="button" className={cn(chip, "text-foreground")} disabled={disabled} aria-label={draft.project ? `Project: ${draft.project.name}` : "Choose a project"} data-testid="machine-project">
          <Folder className="size-[13px]" />
          <span className="truncate">{draft.project?.name ?? "Choose a project"}</span>
          <ChevronDown className="size-3 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[20rem] overflow-y-auto">
        <DropdownMenuLabel>Projects on {draft.name}</DropdownMenuLabel>
        {draft.projects.length === 0 && <div className="px-2 pb-1.5 text-[12px] text-faint">{draft.name} has no projects yet. Add one there first.</div>}
        {draft.projects.map((project) => (
          <DropdownMenuItem key={project.projectId} onSelect={() => startMachineSessionIn(draft.machineId, project.projectId)} title={project.path}>
            <Folder className={cn(project.projectId === draft.project?.projectId && "text-foreground")} />
            <span className="truncate">{project.name}</span>
            {project.projectId === draft.project?.projectId && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type BranchList = { state: "idle" | "loading" } | { state: "loaded"; branches: RemoteBranch[]; defaultBranch: string | null } | { state: "failed"; error: string };

/**
 * "from main": the branch the session's worktree is cut from, from the
 * project's branches on the machine. `base` null is the project's default
 * branch. A machine without `session-base/1` starts from its default only.
 */
export function MachineBranchMenu({ draft, base, onBase, disabled }: { draft: MachineDraft; base: string | null; onBase: (branch: string | null) => void; disabled?: boolean }) {
  const menu = useRowMenu();
  const [list, setList] = useState<BranchList>({ state: "idle" });
  const projectId = draft.project?.projectId ?? null;
  const client = draft.client;
  const canChoose = !!client?.hasCapability("session-base/1");
  useEffect(() => setList({ state: "idle" }), [client, projectId]);
  const load = () => {
    if (!client || !projectId || list.state === "loading" || list.state === "loaded") return;
    setList({ state: "loading" });
    new RemoteGit(client.forProject(projectId), ".")
      .branches()
      .then((result) => setList({ state: "loaded", branches: result.branches.filter((branch) => !branch.remote), defaultBranch: result.defaultBranch }))
      .catch((error: unknown) => setList({ state: "failed", error: error instanceof WorkspaceRpcError ? error.message : errorMessage(error) }));
  };
  const defaultBranch = (list.state === "loaded" ? list.defaultBranch : null) ?? draft.project?.defaultBranch ?? "the default branch";
  const shown = base ?? defaultBranch;
  const locked = !canChoose && client ? machineFeatureMessage(draft.name, draft.machine?.version ?? null, { id: "baseBranch", label: "Starting from another branch", capability: "session-base/1", action: "start a session from another branch" }) : null;
  if (draft.project?.kind === "folder") return null;
  return (
    <DropdownMenu
      {...menu.root}
      onOpenChange={(open) => {
        menu.root.onOpenChange?.(open);
        if (open) load();
      }}
    >
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <button type="button" className={cn(chip, "text-muted-foreground")} disabled={disabled || !client || !projectId} title={locked ?? "The branch the new worktree is made from"} data-testid="machine-branch">
          <GitBranch className="size-[13px]" />
          <span className="truncate">from {shown}</span>
          <ChevronDown className="size-3 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[20rem] overflow-y-auto">
        <DropdownMenuLabel>New worktree from</DropdownMenuLabel>
        {locked && <div className="max-w-64 px-2 pb-1.5 text-[12px] leading-snug text-muted-foreground">{locked}</div>}
        <DropdownMenuItem onSelect={() => onBase(null)}>
          <GitBranch />
          <span className="truncate">{defaultBranch}</span>
          <span className="ml-auto pl-3 text-[11px] text-faint">default</span>
        </DropdownMenuItem>
        {canChoose && list.state === "loading" && <div className="px-2 py-1.5 text-[12px] text-faint">Reading branches on {draft.name}…</div>}
        {canChoose && list.state === "failed" && <div className="px-2 py-1.5 text-[12px] text-destructive">{list.error}</div>}
        {canChoose &&
          list.state === "loaded" &&
          list.branches
            .filter((branch) => branch.name !== list.defaultBranch)
            .map((branch) => (
              <DropdownMenuItem key={branch.name} onSelect={() => onBase(branch.name)}>
                <GitBranch className={cn(branch.name === base && "text-foreground")} />
                <span className="truncate font-mono text-[12px]">{branch.name}</span>
                {branch.name === base && <Check className="ml-auto" />}
              </DropdownMenuItem>
            ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The line under the form (21.07): where it runs, that the chosen agent is
 * signed in there, and that the project exists there. While the machine is
 * not connected it says so instead, and Create waits.
 */
export function MachineFormLine({ draft, agentId, agentName }: { draft: MachineDraft; agentId: string | null; agentName: string | null }) {
  const signIn = agentSignIn(draft.agents, agentId);
  if (!draft.client) {
    return (
      <div className="mt-2 px-1 text-xs text-warning" role="status" data-testid="machine-form-line">
        {machineViewStatus(draft.state, draft.name)}
      </div>
    );
  }
  return (
    <>
    {draft.missingProject && <MachineMessage kind="projectMissing" name={draft.name} project={draft.missingProject} className="mt-2" />}
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-faint" data-testid="machine-form-line">
      <span>Runs on {draft.name}; {thisComputer} can sleep</span>
      <span className="ml-auto flex items-center gap-x-4">
        {agentName && signIn === "signedIn" && (
          <span className="flex items-center gap-1" data-testid="machine-agent-signed-in">
            <Check className="size-3 text-add" aria-hidden />
            {agentName} signed in
          </span>
        )}
        {agentName && signIn === "signedOut" && (
          <span className="text-warning" data-testid="machine-agent-signed-out">
            {agentName} is not signed in on {draft.name}
          </span>
        )}
        {draft.project && (
          <span className="flex items-center gap-1" data-testid="machine-project-there">
            <Check className="size-3 text-add" aria-hidden />
            {draft.project.name} is a project there
          </span>
        )}
      </span>
    </div>
    </>
  );
}

/**
 * What another place hands the new-session form when it opens it on a
 * machine (PRO-348): an issue's start, or a handoff's prompt. The form takes
 * it once, the next time it is drawn.
 */
export interface NewSessionSeed {
  prompt: string;
  issue: Issue | null;
  /** The project on this Mac the issue was read from, for its comments. */
  issueProjectPath: string | null;
  nonce: number;
}

let seed: NewSessionSeed | null = null;
let seeds = 0;
const seedListeners = new Set<() => void>();

function publishSeed() {
  for (const listener of [...seedListeners]) listener();
}

/** Open the new-session form on `machineId` with a prompt or an issue in it; the project of `projectName` there is chosen. */
export function openMachineDraft(machineId: string, draft: { prompt?: string; issue?: Issue | null; issueProjectPath?: string | null }) {
  seed = { prompt: draft.prompt ?? "", issue: draft.issue ?? null, issueProjectPath: draft.issueProjectPath ?? null, nonce: ++seeds };
  publishSeed();
  startMachineSessionIn(machineId, null);
}

export function useNewSessionSeed(): NewSessionSeed | null {
  return useSyncExternalStore(
    (listener) => {
      seedListeners.add(listener);
      return () => seedListeners.delete(listener);
    },
    () => seed,
    () => seed,
  );
}

/** The form has the seed: it is spent. */
export function takeNewSessionSeed(spent: NewSessionSeed) {
  if (seed?.nonce !== spent.nonce) return;
  seed = null;
  publishSeed();
}

/** For tests. */
export function resetNewSessionSeedForTests() {
  seed = null;
  seedListeners.clear();
}
