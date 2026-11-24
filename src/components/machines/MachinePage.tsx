import { useState } from "react";
import { ThisComputer, thisComputer } from "@/lib/platform";
import { ChevronRight, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { refreshPairedMachines } from "@/lib/machineConnections";
import { machineHasFeature } from "@/lib/machineFeatures";
import { useMachineProjects } from "@/lib/machineCatalog";
import { renameMachine } from "@/lib/machinePage";
import { useMachineUpdateEntry, useMachineVersion, type MachineVersionView } from "@/lib/machineUpdate";
import type { MachineUpdateMethod, PairedMachine } from "@/types/machines";
import { MachineIcon, MachineStateMark, machineTone, routeText, toneText } from "./connectionStatus";
import { MachinePageAgents } from "./MachinePageAgents";
import { MachinePageProjects } from "./MachinePageProjects";
import { MachinePageResources } from "./MachinePageResources";
import { MachinePageHosting } from "./MachinePageHosting";
import { RemoveMachineDialog } from "./RemoveMachineDialog";
import { MachineVersionBanner } from "./MachineUpdate";
import { keyLabel, osLabel, shortDate } from "./machineText";

/**
 * "Connected" on the page and the card (21.02, 21.10); the chip's label
 * otherwise. `state` is the card's shown state (Needs update while anything
 * is hidden) or the page's own connection state, whose banner says what is
 * hidden (21.10).
 */
export function pageStateLabel(view: MachineVersionView, state = view.shownState): string {
  switch (state.state) {
    case "direct":
    case "relay":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
    case "needsUpdate":
      return "Needs update";
    case "updating":
      return "Updating";
    case "accessRemoved":
      return "Access removed";
    case "disconnected":
      return "Disconnected";
    default:
      return "Not connected";
  }
}

const METHOD_TEXT: Record<MachineUpdateMethod, string | null> = { installer: "headless", app: "desktop app", unmanaged: null };

/** The header's line in its parts: what it is and how it is reached, its key label, and when it was paired. */
export function machineMetaParts(view: MachineVersionView, method: MachineUpdateMethod | null): { lead: string; fingerprint: string | null; paired: string } | null {
  const machine = view.machine;
  if (!machine) return null;
  const state = view.state;
  const route = state.state === "direct" || state.state === "relay" ? routeText(state.route).replace(/^Through TerminalX Relay$/, "through Relay").replace(/^Direct/, "direct") : null;
  return {
    lead: [osLabel(machine.os), method ? METHOD_TEXT[method] : null, route].filter(Boolean).join(" · "),
    fingerprint: keyLabel(machine.machineId),
    paired: `paired ${shortDate(machine.pairedAt)}`,
  };
}

/** "Ubuntu 24.04 · headless · through Relay · fingerprint 3C1E·77A0 · paired Nov 12". */
export function machineMetaLine(view: MachineVersionView, method: MachineUpdateMethod | null): string {
  const parts = machineMetaParts(view, method);
  if (!parts) return "";
  return [parts.lead, parts.fingerprint ? `fingerprint ${parts.fingerprint}` : null, parts.paired].filter(Boolean).join(" · ");
}

/**
 * A machine's page in Settings → Machines (screen 21.10): its name and state,
 * how it is reached, its key label and Rename; the version section saying
 * what is hidden and which side updates (PRO-354); its agents with their
 * sign-ins, Install and Sign in on the machine, and its resources (PRO-350);
 * its projects, with Add a project and Remove project (PRO-351); and Remove.
 */
export function MachinePage({ machineId, onBack }: { machineId: string; onBack: () => void }) {
  const view = useMachineVersion(machineId);
  const entry = useMachineUpdateEntry(machineId);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const catalog = useMachineProjects(machineId);
  const machine = view.machine;
  if (!machine) {
    return (
      <div className="grid gap-3" data-testid="machine-page">
        <Breadcrumb name="Machine" onBack={onBack} />
        <p className="text-[13px] text-muted-foreground">This machine is no longer paired with {thisComputer}.</p>
      </div>
    );
  }
  // The page says how the machine is connected; its version banner says what is hidden (21.10).
  const tone = machineTone(view.state);
  const connected = (view.state.state === "direct" || view.state.state === "relay") && view.granted !== null;
  const meta = machineMetaParts(view, entry.status?.method ?? null);
  // Install and Sign in on the machine need `machine/4`; without it the agents show and nothing is offered.
  const setupGranted = machineHasFeature(view.granted ?? [], "machine/4") && !!view.granted;
  // Adding and removing projects need `machine/6`; without it the projects are listed and nothing is offered.
  const projectsGranted = machineHasFeature(view.granted ?? [], "machine/6") && !!view.granted;
  // Choosing where it listens needs `machine/9` and a computer that manages it; without them it is shown only.
  const listenGranted = !!view.granted && view.granted.includes("machine/9") && view.client?.connection.state === "connected" && view.client.connection.authority === "manage";
  return (
    <div className="grid gap-6" data-testid="machine-page" data-machine={machineId}>
      <div className="grid gap-5">
        <Breadcrumb name={machine.name} onBack={onBack} />
        <header className="flex items-center gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-well">
            <MachineIcon machine={machine} className="size-[18px] text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            {renaming ? (
              <RenameForm machine={machine} onDone={() => setRenaming(false)} />
            ) : (
              <div className="flex min-w-0 items-center gap-2.5">
                <h2 className="truncate text-[20px] font-semibold leading-7">{machine.name}</h2>
                <span className={cn("flex shrink-0 items-center gap-1.5 text-[12px]", toneText(tone))} data-testid="machine-page-state" data-state={view.state.state}>
                  <MachineStateMark state={view.state} />
                  {pageStateLabel(view, view.state)}
                </span>
              </div>
            )}
            {meta && (
              <div className="truncate text-[12.5px] text-muted-foreground" data-testid="machine-page-meta">
                {meta.lead}
                {meta.lead && " · "}
                {meta.fingerprint && (
                  <>
                    fingerprint{" "}
                    <span className="font-mono text-[12px]" title="A label for the machine’s key. Pairing compares a separate four-group fingerprint.">
                      {meta.fingerprint}
                    </span>
                    {" · "}
                  </>
                )}
                {meta.paired}
              </div>
            )}
          </div>
          {!renaming && (
            <Button size="sm" variant="outline" className="shrink-0 self-start" onClick={() => setRenaming(true)}>
              Rename
            </Button>
          )}
        </header>
        <MachineVersionBanner machineId={machineId} view={view} />
      </div>
      <MachinePageAgents machine={machine} client={view.client} connected={connected} setupGranted={setupGranted} />
      <MachinePageProjects machine={machine} client={view.client} connected={connected} manage={projectsGranted} projects={catalog.projects} ready={catalog.entry?.source === "live"} />
      <MachinePageResources name={machine.name} client={view.client} connected={connected} />
      <MachinePageHosting name={machine.name} client={view.client} connected={connected} manage={listenGranted} />
      <section className="flex items-center gap-6 border-t border-hairline pt-4" data-testid="machine-remove" aria-label="Remove this machine">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Remove this machine</div>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{ThisComputer} stops operating {machine.name} and forgets its credential. Sessions on {machine.hasWindow === false ? "the server" : machine.name} stay there.</p>
        </div>
        <Button size="sm" variant="outline" className="shrink-0 border-destructive/60 text-destructive hover:bg-destructive/10" onClick={() => setRemoving(true)}>
          Remove
        </Button>
      </section>
      <RemoveMachineDialog machine={removing ? machine : null} onClose={() => setRemoving(false)} onRemoved={onBack} />
    </div>
  );
}

/** Rename in place of the name: Enter or Save keeps it, Escape or Cancel leaves it. */
function RenameForm({ machine, onDone }: { machine: PairedMachine; onDone: () => void }) {
  const [draft, setDraft] = useState(machine.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = draft.trim();
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await renameMachine(machine.machineId, typed);
      await refreshPairedMachines();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };
  return (
    <form
      className="grid gap-1"
      data-testid="machine-rename"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed && typed !== machine.name) void save();
      }}
    >
      <div className="flex items-center gap-2">
        <input
          autoFocus
          aria-label="Machine name"
          value={draft}
          maxLength={80}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onDone();
          }}
          className="h-8 w-64 min-w-0 rounded-md border border-hairline bg-background px-2 text-[14px] outline-none focus:border-border"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={saving || !typed || typed === machine.name}>
          {saving ? <Loader2 className="animate-spin" /> : null} Save
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function Breadcrumb({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <nav className="flex items-center gap-1.5 text-[12.5px]" aria-label="Breadcrumb">
      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onBack}>
        Machines
      </button>
      <ChevronRight className="size-3 text-faint" aria-hidden />
      <span className="truncate text-foreground" aria-current="page">
        {name}
      </span>
    </nav>
  );
}
