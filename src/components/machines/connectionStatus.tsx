import { useEffect, useState } from "react";
import { Loader2, Lock, Monitor, Server } from "@/icons";
import { cn } from "@/lib/cn";
import type { MachineConnectionState, MachineRouteUsed, PairedMachine } from "@/types/machines";

/**
 * How a machine's connection reads (screens 21.01, 21.08 and 21.09): a short
 * label beside its name, the hover text of its header chip, and a colour.
 */
export type MachineTone = "connecting" | "connected" | "reconnecting" | "offline" | "warning" | "updating" | "removed" | "idle";

export function machineTone(state: MachineConnectionState): MachineTone {
  switch (state.state) {
    case "connecting":
      return "connecting";
    case "direct":
    case "relay":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "offline":
      return "offline";
    case "needsUpdate":
      return "warning";
    case "updating":
      return "updating";
    case "accessRemoved":
      return "removed";
    default:
      return "idle";
  }
}

/** "14:02" in the reader's locale. */
export function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The machine's last contact: the offline state's, else the record's. */
function lastSeen(state: MachineConnectionState, machine: PairedMachine | null): number | null {
  if (state.state === "offline" && state.lastSeenAt) return state.lastSeenAt;
  return machine?.lastSeenAt ?? null;
}

/**
 * The label beside a machine's name. The sidebar adds when an offline machine
 * was last seen (`Offline · seen 14:02`); the chip says only `Offline`.
 */
export function machineStateLabel(state: MachineConnectionState, machine: PairedMachine | null, options: { seen?: boolean } = {}): string {
  switch (state.state) {
    case "connecting":
      return "Connecting";
    case "direct":
      return "Direct";
    case "relay":
      return "Relay";
    case "reconnecting":
      return "Reconnecting";
    case "offline": {
      const seen = options.seen ? lastSeen(state, machine) : null;
      return seen ? `Offline · seen ${clockTime(seen)}` : "Offline";
    }
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

function seconds(ms: number): string {
  const count = Math.max(0, Math.round(ms / 1000));
  return `${count} second${count === 1 ? "" : "s"}`;
}

/** The chip's hover text (21.09). */
export function machineStateHint(state: MachineConnectionState, name: string, now = Date.now()): string {
  switch (state.state) {
    case "connecting":
      return `Reaching the ${name}`;
    case "direct":
      return "On this network or Tailscale";
    case "relay":
      return "Through TerminalX Relay";
    case "reconnecting":
      return `Lost it ${seconds(now - state.lostAt)} ago`;
    case "offline":
      return "Sessions there keep running";
    case "needsUpdate":
      return state.side === "thisMac" ? "Runs a newer TerminalX than this Mac" : "Runs an older TerminalX";
    case "updating":
      return "Back in under a minute";
    case "accessRemoved":
      return "Revoked on that Mac";
    default:
      return "Not connected from this Mac";
  }
}

/** "Direct over Tailscale", "Direct on this network" or "Through TerminalX Relay". */
export function routeText(route: MachineRouteUsed): string {
  if (route.kind === "relay") return "Through TerminalX Relay";
  return route.kind === "tailscale" ? "Direct over Tailscale" : "Direct on this network";
}

/** The path strip's right end (21.08): the route and the last round trip. */
export function machinePathText(state: MachineConnectionState): string | null {
  if (state.state !== "direct" && state.state !== "relay") return null;
  const route = routeText(state.route);
  return state.rttMs === null ? route : `${route} · ${Math.round(state.rttMs)} ms`;
}

const TONE_TEXT: Record<MachineTone, string> = {
  connecting: "text-info",
  connected: "text-add",
  reconnecting: "text-warning",
  offline: "text-faint",
  warning: "text-warning",
  updating: "text-info",
  removed: "text-destructive",
  idle: "text-faint",
};

const TONE_DOT: Record<MachineTone, string> = {
  connecting: "bg-info",
  connected: "bg-add",
  reconnecting: "bg-warning",
  offline: "bg-faint",
  warning: "bg-warning",
  updating: "bg-info",
  removed: "bg-destructive",
  idle: "bg-faint",
};

/** The tone's text colour, for the chip's label. */
export function toneText(tone: MachineTone): string {
  return TONE_TEXT[tone];
}

/** A dot for a settled state, a spinner while it is reaching the machine (21.09). */
export function MachineStateMark({ state, className }: { state: MachineConnectionState; className?: string }) {
  const tone = machineTone(state);
  if (tone === "connecting" || tone === "reconnecting" || tone === "updating") {
    return <Loader2 className={cn("size-3 shrink-0 animate-spin", TONE_TEXT[tone], className)} aria-hidden data-testid="machine-state-mark" data-tone={tone} />;
  }
  return <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], className)} aria-hidden data-testid="machine-state-mark" data-tone={tone} />;
}

/** A monitor for a Mac, a server for Linux (21.01). */
export function MachineIcon({ machine, className }: { machine: PairedMachine | null; className?: string }) {
  const linux = machine?.os.family === "linux";
  const Icon = linux ? Server : Monitor;
  return <Icon className={className} aria-hidden data-icon={linux ? "server" : "monitor"} />;
}

/** Re-render every second while `on`, so "Lost it N seconds ago" counts. */
export function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** The header chip (21.08, 21.09): icon, name, mark and label; the hover text says what the state means. */
export function MachineChip({ machine, name, state }: { machine: PairedMachine | null; name: string; state: MachineConnectionState }) {
  const now = useTick(state.state === "reconnecting");
  const tone = machineTone(state);
  const label = machineStateLabel(state, machine);
  const hint = machineStateHint(state, name, now);
  return (
    <span
      className="inline-flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2 text-[12px]"
      title={hint}
      aria-label={`${name}: ${label}. ${hint}`}
      data-testid="machine-chip"
      data-state={state.state}
    >
      <MachineIcon machine={machine} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-foreground">{name}</span>
      <MachineStateMark state={state} />
      <span className={cn("shrink-0", TONE_TEXT[tone])}>{label}</span>
    </span>
  );
}

/**
 * The strip under the header (21.08): what runs where, and the route. A
 * machine's view says it runs there, as a cloud one says it runs in the cloud.
 */
export function MachineLocation({ machine, name, state }: { machine: PairedMachine | null; name: string; state: MachineConnectionState }) {
  const path = machinePathText(state);
  return (
    <div className="flex h-8 min-w-0 shrink-0 items-center gap-2 border-b border-hairline px-3 text-[12px]" data-testid="machine-location" title={`Commands run on ${name}, not on this Mac.`}>
      <MachineIcon machine={machine} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium text-foreground">Runs on {name}</span>
      <span className="min-w-0 truncate text-faint">· its files, terminals and git; this Mac can sleep</span>
      {path && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-faint" data-testid="machine-path">
          <Lock className="size-3 shrink-0" aria-hidden />
          {path}
        </span>
      )}
    </div>
  );
}
