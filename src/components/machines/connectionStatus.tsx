import { useEffect, useState } from "react";
import { LoaderCircle, Lock } from "@/icons";
import { cn } from "@/lib/cn";
import type { MachineConnectionState, MachineRouteKind, MachineRouteUsed, PairedMachine } from "@/types/machines";
import { PlatformIcon } from "./machineText";

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

/** "14:02": the 24-hour clock the screens use (21.09), whatever the reader's locale. */
export function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
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

/** The routes a reconnect is trying, as the view says them (21.09): "Trying this network, then Relay." */
function tryingText(trying: MachineRouteKind[]): string | null {
  const direct = trying.some((kind) => kind !== "relay");
  const relay = trying.includes("relay");
  if (direct && relay) return "Trying this network, then Relay.";
  if (direct) return "Trying this network.";
  return relay ? "Trying Relay." : null;
}

/**
 * What a machine's view says under its tabs while it is not connected (21.09).
 * It reads the machine's own state, so it agrees with the chip and the
 * sidebar: an offline machine is offline, with no transport retry counter.
 */
export function machineViewStatus(state: MachineConnectionState, name: string): string {
  switch (state.state) {
    case "reconnecting":
      return [`Reconnecting to ${name}.`, tryingText(state.trying), "Sessions there keep running."].filter(Boolean).join(" ");
    case "offline":
      return `${name} is offline. Sessions there keep running.`;
    case "needsUpdate":
      // PRO-354: the newer side says which computer updates.
      return state.side === "thisMac" ? `${name} runs a newer TerminalX than this Mac. Update this Mac to connect.` : `${name} runs an older TerminalX. Update TerminalX there to connect.`;
    case "updating":
      return `${name} is updating. Back in under a minute. Sessions there keep running.`;
    case "accessRemoved":
      return `${name} no longer allows this Mac. Pair again to reconnect.`;
    case "idle":
      return `Not connected to ${name}.`;
    default:
      // Connecting, or the link is up and the view's own channel is opening.
      return `Connecting to ${name}…`;
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

/** A dot for a settled state, an arc spinner in the state's colour while it is reaching the machine (21.09). */
export function MachineStateMark({ state, className }: { state: MachineConnectionState; className?: string }) {
  const tone = machineTone(state);
  if (tone === "connecting" || tone === "reconnecting" || tone === "updating") {
    return <LoaderCircle className={cn("size-3 shrink-0 animate-spin", TONE_TEXT[tone], className)} aria-hidden data-testid="machine-state-mark" data-tone={tone} />;
  }
  return <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], className)} aria-hidden data-testid="machine-state-mark" data-tone={tone} />;
}

/** A monitor for a Mac, a server for Linux (21.01): the same icon Settings draws. */
export function MachineIcon({ machine, className }: { machine: PairedMachine | null; className?: string }) {
  return <PlatformIcon platform={machine?.os.family ?? null} className={className} />;
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
    <div className="flex h-9 min-w-0 shrink-0 items-center gap-2 border-b border-hairline px-3 text-[12px]" data-testid="machine-location" title={`Commands run on ${name}, not on this Mac.`}>
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
