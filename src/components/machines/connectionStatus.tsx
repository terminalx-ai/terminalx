import { useEffect, useState } from "react";
import { thisComputer } from "@/lib/platform";
import { Popover } from "radix-ui";
import { LoaderCircle, Lock } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { disconnectMachine, machineConnection, reconnectMachine, useMachineConnections } from "@/lib/machineConnections";
import { memoryText } from "@/lib/machineNewSession";
import { selectCloudWorkspace } from "@/lib/sessions";
import { machineSectionKey } from "@/types/target";
import type { MachineConnectionState, MachineRouteKind, MachineRouteUsed, PairedMachine } from "@/types/machines";
import { PlatformIcon, clockTime, keyLabel, osLabel, seenText } from "./machineText";
import { useFreeMemory, useRunningSessions } from "./useRunningSessions";

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
    case "disconnected":
      return "removed";
    default:
      return "idle";
  }
}

export { clockTime };

/** The machine's last contact: the offline state's, else the record's. */
function lastSeen(state: MachineConnectionState, machine: PairedMachine | null): number | null {
  if (state.state === "offline" && state.lastSeenAt) return state.lastSeenAt;
  return machine?.lastSeenAt ?? null;
}

/** "Last seen at 14:02." the same day, else "Last seen yesterday at 14:02." (21.09). */
export function lastSeenSentence(seen: number, now = Date.now()): string {
  const text = seenText(seen, now);
  return `Last seen ${text.startsWith("today at ") ? text.slice("today ".length) : text}.`;
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
    case "disconnected":
      return "Disconnected";
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
      return state.side === "thisMac" ? `Runs a newer TerminalX than ${thisComputer}` : "Runs an older TerminalX";
    case "updating":
      return "Back in under a minute";
    case "accessRemoved":
      return `Revoked on ${name}`;
    case "disconnected":
      return `Disconnected on ${name}`;
    default:
      return `Not connected from ${thisComputer}`;
  }
}

const ROUTE_WORDS: Record<MachineRouteKind, string> = { lan: "this network", tailscale: "Tailscale", relay: "Relay" };

/**
 * The routes a reconnect is trying, in the order it tries them (21.09):
 * "Trying this network, then Relay." Each route keeps its own name, as
 * {@link routeText} does: Tailscale is not "this network".
 */
export function tryingText(trying: MachineRouteKind[]): string | null {
  const routes = (["lan", "tailscale", "relay"] as const).filter((kind) => trying.includes(kind)).map((kind) => ROUTE_WORDS[kind]);
  if (routes.length === 0) return null;
  return `Trying ${routes.length === 1 ? routes[0] : `${routes.slice(0, -1).join(", ")}, then ${routes[routes.length - 1]}`}.`;
}

/**
 * What a machine's view says under its tabs while it is not connected (21.09).
 * It reads the machine's own state, so it agrees with the chip and the
 * sidebar: an offline machine is offline, with no transport retry counter.
 */
export function machineViewStatus(state: MachineConnectionState, name: string): string {
  switch (state.state) {
    case "reconnecting":
      return [`Reconnecting to ${name}.`, tryingText(state.trying), "The agent keeps working there."].filter(Boolean).join(" ");
    case "offline":
      return `${name} isn’t reachable. Sessions there keep running.`;
    case "needsUpdate":
      // PRO-354: the newer side says which computer updates.
      return state.side === "thisMac" ? `${name} runs a newer TerminalX than ${thisComputer}. Update ${thisComputer} to connect.` : `${name} runs an older TerminalX. Update TerminalX there to connect.`;
    case "updating":
      return `${name} is updating. Back in under a minute. Sessions there keep running.`;
    case "accessRemoved":
      return `${name} no longer allows ${thisComputer}. Pair again to reconnect.`;
    case "disconnected":
      return `${name} disconnected ${thisComputer}. Try again once it lets ${thisComputer} back.`;
    case "idle":
      return `Not connected to ${name}.`;
    default:
      // Connecting, or the link is up and the view's own channel is opening.
      return `Connecting to ${name}…`;
  }
}

/** {@link machineViewStatus} in a word or two, for a tab's connection chip: the chip's own label, or Connecting while the view's channel opens. */
export function machineViewLabel(state: MachineConnectionState): string {
  return state.state === "direct" || state.state === "relay" ? "Connecting" : machineStateLabel(state, null);
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

/**
 * The header chip (21.08, 21.09): icon, name, mark and label; the hover text
 * says what the state means. Choosing it opens the connection popover.
 */
export function MachineChip({ machine, name, state }: { machine: PairedMachine | null; name: string; state: MachineConnectionState }) {
  const now = useTick(state.state === "reconnecting");
  const [open, setOpen] = useState(false);
  const tone = machineTone(state);
  const label = machineStateLabel(state, machine);
  const hint = machineStateHint(state, name, now);
  const face = (
    <>
      <MachineIcon machine={machine} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-foreground">{name}</span>
      <MachineStateMark state={state} />
      <span className={cn("shrink-0", TONE_TEXT[tone])}>{label}</span>
    </>
  );
  const chip = "inline-flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2 text-[12px]";
  // A machine no longer paired has nothing to open.
  if (!machine) {
    return (
      <span className={chip} title={hint} aria-label={`${name}: ${label}. ${hint}`} data-testid="machine-chip" data-state={state.state}>
        {face}
      </span>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(chip, "outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40", open && "bg-veil-raised")}
          title={hint}
          aria-label={`${name}: ${label}. ${hint}`}
          data-testid="machine-chip"
          data-state={state.state}
        >
          {face}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          aria-label={`${name} connection`}
          className="z-(--z-tooltip) w-[340px] max-w-[calc(100vw-16px)] rounded-xl bg-popover p-4 text-popover-foreground shadow-surface hairline"
          data-testid="machine-popover"
        >
          <MachineConnectionDetails machine={machine} state={state} onDone={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The popover's word for the state: Connected on either route, else the chip's own label. */
export function popoverStateLabel(state: MachineConnectionState, machine: PairedMachine | null): string {
  return state.state === "direct" || state.state === "relay" ? "Connected" : machineStateLabel(state, machine);
}

/**
 * The rows of the connection popover (21.09): how this Mac reaches the
 * machine and how fast, that the link is end to end and the machine's key
 * label, its TerminalX and system, and what runs there. Each row has its
 * label and value; a value that is not known yet is left out.
 */
export function machineDetailRows(
  machine: PairedMachine,
  state: MachineConnectionState,
  live: { running: number | null; freeBytes: number | null },
  now = Date.now(),
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const linked = state.state === "direct" || state.state === "relay";
  rows.push({ label: "Path", value: machinePathText(state) ?? machineStateHint(state, machine.name, now) });
  const key = keyLabel(machine.machineId);
  rows.push({ label: "Encryption", value: key ? `End to end · ${key}` : "End to end" });
  rows.push({ label: "TerminalX", value: `${machine.version} · ${osLabel(machine.os)}` });
  if (linked) {
    const parts = [
      live.running === null ? null : `${live.running} session${live.running === 1 ? "" : "s"}`,
      live.freeBytes === null ? null : `${memoryText(live.freeBytes)} memory free`,
    ].filter((part): part is string => !!part);
    if (parts.length) rows.push({ label: "Running", value: parts.join(" · ") });
  } else {
    const seen = state.state === "offline" && state.lastSeenAt ? state.lastSeenAt : machine.lastSeenAt;
    if (seen) rows.push({ label: "Last seen", value: seenText(seen, now) });
  }
  return rows;
}

function MachineConnectionDetails({ machine, state, onDone }: { machine: PairedMachine; state: MachineConnectionState; onDone: () => void }) {
  const store = useMachineConnections();
  const { connection } = machineConnection(store, machine.machineId);
  const linked = state.state === "direct" || state.state === "relay";
  const running = useRunningSessions(connection, linked);
  const freeBytes = useFreeMemory(linked ? (connection?.client ?? null) : null);
  const now = useTick(state.state === "reconnecting");
  const tone = machineTone(state);
  const rows = machineDetailRows(machine, state, { running, freeBytes }, now);
  // A connection that is up or being reached can be let go; one that is away or let go is tried again.
  const holds = linked || state.state === "connecting" || state.state === "reconnecting" || state.state === "updating";
  return (
    <div className="grid gap-3 text-[13px]">
      <div className="flex min-w-0 items-center gap-2">
        <MachineIcon machine={machine} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{machine.name}</span>
        <MachineStateMark state={state} />
        <span className={cn("shrink-0 text-[12px]", TONE_TEXT[tone])} data-testid="machine-popover-state">
          {popoverStateLabel(state, machine)}
        </span>
      </div>
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2" data-testid="machine-popover-rows">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 truncate text-foreground" title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onDone();
            selectCloudWorkspace(machineSectionKey(machine.machineId));
          }}
        >
          Machine settings
        </Button>
        {holds ? (
          <Button
            size="sm"
            variant="outline"
            className="text-muted-foreground"
            onClick={() => {
              onDone();
              disconnectMachine(machine.machineId);
            }}
          >
            Disconnect
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void reconnectMachine(machine.machineId)}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The strip under the header (21.08): what runs where, and the route. A
 * machine's view says it runs there, as a cloud one says it runs in the cloud.
 */
export function MachineLocation({ machine, name, state }: { machine: PairedMachine | null; name: string; state: MachineConnectionState }) {
  const path = machinePathText(state);
  return (
    <div className="flex h-9 min-w-0 shrink-0 items-center gap-2 border-b border-hairline px-3 text-[12px]" data-testid="machine-location" title={`Commands run on ${name}, not on ${thisComputer}.`}>
      <MachineIcon machine={machine} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium text-foreground">Runs on {name}</span>
      <span className="min-w-0 truncate text-faint">· its files, terminals and git; {thisComputer} can sleep</span>
      {path && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-faint" data-testid="machine-path">
          <Lock className="size-3 shrink-0" aria-hidden />
          {path}
        </span>
      )}
    </div>
  );
}
