import { ChevronRight } from "@/icons";
import { cn } from "@/lib/cn";
import { useMachineUpdateEntry, useMachineVersion, type MachineVersionView } from "@/lib/machineUpdate";
import type { MachineUpdateMethod } from "@/types/machines";
import { MachineIcon, MachineStateMark, machineTone, routeText, toneText } from "./connectionStatus";
import { MachineVersionBanner } from "./MachineUpdate";
import { osLabel, shortDate } from "./machineText";

/** "Connected" on the page and the card (21.02, 21.10); the chip's label otherwise. */
export function pageStateLabel(view: MachineVersionView): string {
  const state = view.shownState;
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
    default:
      return "Not connected";
  }
}

const METHOD_TEXT: Record<MachineUpdateMethod, string | null> = { installer: "headless", app: "desktop app", unmanaged: null };

/** "Ubuntu 24.04 · headless · through Relay · paired Nov 12". */
export function machineMetaLine(view: MachineVersionView, method: MachineUpdateMethod | null): string {
  const machine = view.machine;
  if (!machine) return "";
  const state = view.state;
  const route = state.state === "direct" || state.state === "relay" ? routeText(state.route).replace(/^Through TerminalX Relay$/, "through Relay").replace(/^Direct/, "direct") : null;
  return [osLabel(machine.os), method ? METHOD_TEXT[method] : null, route, `paired ${shortDate(machine.pairedAt)}`].filter(Boolean).join(" · ");
}

/**
 * A machine's page in Settings → Machines (screen 21.10): its name and state,
 * how it is reached, and the version section saying what is hidden and
 * which side updates. Its agents, projects and resources are PRO-350 and
 * PRO-351.
 */
export function MachinePage({ machineId, onBack }: { machineId: string; onBack: () => void }) {
  const view = useMachineVersion(machineId);
  const entry = useMachineUpdateEntry(machineId);
  const machine = view.machine;
  if (!machine) {
    return (
      <div className="grid gap-3" data-testid="machine-page">
        <Breadcrumb name="Machine" onBack={onBack} />
        <p className="text-[13px] text-muted-foreground">This machine is no longer paired with this Mac.</p>
      </div>
    );
  }
  const tone = machineTone(view.shownState);
  return (
    <div className="grid gap-5" data-testid="machine-page" data-machine={machineId}>
      <Breadcrumb name={machine.name} onBack={onBack} />
      <header className="flex items-center gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-well">
          <MachineIcon machine={machine} className="size-[18px] text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="truncate text-[20px] font-semibold leading-7">{machine.name}</h2>
            <span className={cn("flex shrink-0 items-center gap-1.5 text-[12px]", toneText(tone))} data-testid="machine-page-state" data-state={view.shownState.state}>
              <MachineStateMark state={view.shownState} />
              {pageStateLabel(view)}
            </span>
          </div>
          <div className="truncate text-[12.5px] text-muted-foreground" data-testid="machine-page-meta">
            {machineMetaLine(view, entry.status?.method ?? null)}
          </div>
        </div>
      </header>
      <MachineVersionBanner machineId={machineId} view={view} />
    </div>
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
