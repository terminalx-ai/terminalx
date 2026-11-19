import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Hash, Loader2, PlugZap } from "@/icons";
import type { ListedPort, WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Switch } from "@/components/ui/controls";
import type { CloudPortForward, CloudPortSettings } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  copyForwardUrl,
  dropPortForwards,
  forwardPort,
  notePortProcesses,
  openForwardInBrowser,
  processLabel,
  readPortForwards,
  resetPortForwards,
  setPortSettings,
  unforwardPort,
  usePortForwards,
} from "@/lib/portForwards";
import { MachineFeatureNotice } from "@/components/machines/MachineFeatureNotice";
import { isMachineKey } from "@/types/target";
import { PortRow, PortSection, type PortRowModel } from "./PortRow";
import { useMachinePlace, type MachinePlace } from "./workspacePlace";

/**
 * How often the list is read while the panel is on screen, so an application
 * that has just started shows within a couple of seconds. `ports.list` is one
 * read of the runtime's listening sockets, which always has listeners of its
 * own, so the list is never empty to wait on: it is read at one steady pace.
 */
export const POLL_MS = 2_000;

/** The checkbox that keeps the remote port's number on this Mac (14.11). */
export const SAME_PORT_LABEL = "Same port number on this Mac";

const STOPPED = "Previews work while the workspace is running. Looking here never starts it.";
/** Said beside a state with no connection when previews were open here: they ended with it. */
const CLOSED_WITH_CONNECTION = "The previews that were open closed with the connection; open them again once it is back.";

/**
 * What the panel says while there is no live connection (PRO-28: stopped,
 * restarting and unavailable states). Restarting is a connection on its way
 * back: a reconnect, or a runtime that is starting or restarting.
 */
export function connectionText(state: WorkspaceConnectionState): { text: string; restarting: boolean } {
  switch (state.state) {
    case "connecting":
    case "opening":
      return { text: "Connecting to the workspace…", restarting: true };
    case "reconnecting":
      return { text: "The connection to the workspace dropped. Reconnecting…", restarting: true };
    case "waitingForRuntime":
      return { text: "The workspace's runtime is starting or restarting. Previews can be opened once it is up.", restarting: true };
    case "updateRequired":
      return { text: "Update TerminalX to preview this workspace's ports.", restarting: false };
    default:
      return { text: STOPPED, restarting: false };
  }
}

/** What a refused forward means, in words. `port` is the workspace's port; on a paired machine the words name it. */
export function portErrorMessage(error: unknown, port: number, machine: MachinePlace | null = null): string {
  const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : String(error);
  switch (code) {
    case "cloud_port_in_use":
      return `Port ${port} is already in use on this Mac. Untick "${SAME_PORT_LABEL}" to use a free one.`;
    case "cloud_port_not_connected":
      return machine ? `Ports are forwarded while ${machine.name} is connected.` : STOPPED;
    case "cloud_port_invalid":
      return "Enter a port between 1 and 65535.";
    // The native forwarder refuses new forwards while the master switch is off (PRO-355).
    case "cloud_port_forwarding_off":
      return "Forwarding is off. Turn it on to forward ports to this Mac.";
    case "forbidden":
      return machine ? `You do not have access to ${machine.name}’s ports.` : "You do not have access to this workspace's ports.";
    case "cloud_remote_identity_changed":
    case "cloud_remote_connection_unknown":
      return machine ? `The connection to ${machine.name} changed. Open ${machine.name} again.` : "The connection to this workspace changed. Open the workspace again.";
    default:
      return "The port could not be forwarded. Try again.";
  }
}

// ---- what is remembered per workspace

/** A forward that was open here and closed without being stopped here: its address no longer works. */
interface Expired {
  port: number;
  localPort: number;
}
interface Memory {
  seen: CloudPortForward[];
  expired: Expired[];
}

/**
 * Per workspace (or machine), the forwards last seen open and those that have
 * since closed. Kept outside the views (the panel is drawn only while shown,
 * the popover only while open), so a forward that closed meanwhile is still
 * reported as closed when either is next drawn.
 */
const memory = new Map<string, Memory>();
const memoryListeners = new Set<() => void>();
const NO_EXPIRED: Expired[] = [];

function remember(key: string, next: Memory) {
  memory.set(key, next);
  for (const listener of memoryListeners) listener();
}

function useExpired(key: string): Expired[] {
  return useSyncExternalStore(
    (listener) => {
      memoryListeners.add(listener);
      return () => memoryListeners.delete(listener);
    },
    () => memory.get(key)?.expired ?? NO_EXPIRED,
    () => memory.get(key)?.expired ?? NO_EXPIRED,
  );
}

/**
 * The forwards as they now are: one seen before that went (same port, same address) has expired; one open again is no longer expired.
 * The header's chip reports them too, being drawn while the views are not: a port forwarded automatically and
 * closed again with both hidden is otherwise never seen, and so never expired.
 */
export function observe(key: string, next: readonly CloudPortForward[]) {
  const before = memory.get(key) ?? { seen: [], expired: [] };
  const gone = before.seen.filter((old) => !next.some((forward) => forward.port === old.port && forward.localPort === old.localPort));
  const expired = [...before.expired.filter((entry) => !gone.some((old) => old.port === entry.port)), ...gone.map(({ port, localPort }) => ({ port, localPort }))]
    .filter((entry) => !next.some((forward) => forward.port === entry.port))
    .sort((a, b) => a.port - b.port);
  const same = expired.length === before.expired.length && expired.every((entry, index) => entry.port === before.expired[index]!.port && entry.localPort === before.expired[index]!.localPort);
  remember(key, { seen: [...next], expired: same ? before.expired : expired });
}

/** A Stop made here: the forward is not expired when it goes. */
function forget(key: string, port: number) {
  const before = memory.get(key);
  if (before) remember(key, { ...before, seen: before.seen.filter((forward) => forward.port !== port) });
}

/** The connection went (a cloud workspace's): everything seen open closed with it. */
function expireAll(key: string) {
  const before = memory.get(key);
  if (before?.seen.length) observe(key, []);
}

/** Forgets what the views remember, and every connection's forwards (tests). */
export function resetPortsMemory() {
  memory.clear();
  resetPortForwards();
}

// ---- the controller both views share

export interface PortsInputs {
  /** Names the workspace or machine: what is remembered is kept per workspace. */
  workspaceKey: string;
  client: WorkspaceRpcClient | null;
  state: WorkspaceConnectionState;
  /** The native connection the forwards belong to. */
  connectionId: string | null;
  /** The terminal's rule: a manager, or a driver who may approve. */
  mayOpen: boolean;
  /** The view is on screen: only then is the list read, on a timer. */
  active: boolean;
}

export interface PortsModel {
  machine: MachinePlace | null;
  connected: boolean;
  /** The runtime offers `ports/1`. */
  supported: boolean;
  /** Forwards can be made and read now. */
  usable: boolean;
  /** A machine that is away, whose forwards wait for it. */
  awayWithForwards: boolean;
  /** "on Mac mini", "in the workspace". */
  where: string;
  /** Null until the first answer: until then the view is looking, and never says nothing listens. */
  listening: ListedPort[] | null;
  detected: boolean;
  forwarded: PortRowModel[];
  notForwarded: PortRowModel[];
  expiredCount: number;
  settings: CloudPortSettings;
  busy: number | null;
  error: string | null;
  copied: number | null;
  sameNumber: boolean;
  setSameNumber: (value: boolean) => void;
  forward: (port: number) => Promise<boolean>;
  stop: (port: number) => void;
  copy: (localPort: number, port: number) => void;
  open: (localPort: number) => void;
  setSettings: (settings: Partial<CloudPortSettings>) => void;
}

/**
 * A workspace's or machine's ports and forwards (PRO-28, PRO-355): what
 * listens there, what is forwarded here, and the changes to make. A forward
 * is a listener on this Mac's loopback over the encrypted connection: there
 * is no public address. Nothing here starts a stopped workspace.
 */
export function usePorts({ workspaceKey, client, state, connectionId, mayOpen, active }: PortsInputs): PortsModel {
  const connected = state.state === "connected";
  // On a paired machine the views name it and speak from its own state.
  const machine = useMachinePlace();
  const where = machine ? `on ${machine.name}` : "in the workspace";
  const supported = connected && state.capabilities.includes("ports/1");
  const usable = supported && mayOpen && !!connectionId && !!client;
  // A machine's forwards wait while it is away and come back with it: they are followed meanwhile too.
  const follows = usable || (!!machine && !connected && mayOpen && !!connectionId);
  const generation = connected ? `${state.runtimeGeneration}:${state.runtimeEpoch ?? ""}:${state.link ?? 0}` : state.state;
  const { loaded, forwards, settings, processes } = usePortForwards(connectionId, follows, generation);
  const expired = useExpired(workspaceKey);
  const [listening, setListening] = useState<ListedPort[] | null>(null);
  const [detected, setDetected] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  // Ask for the remote port's own number on this Mac, and refuse if taken.
  const [sameNumber, setSameNumber] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // What is open now against what was seen open: a forward that went without a Stop here has expired.
  useEffect(() => {
    if (follows && loaded) observe(workspaceKey, forwards);
  }, [follows, loaded, forwards, workspaceKey]);
  // A cloud workspace's connection went: its forwards were closed with it, and do not come back.
  // A machine's stay, waiting, and open again when it is back.
  useEffect(() => {
    if (connected) return;
    setListening(null);
    if (machine) return;
    expireAll(workspaceKey);
    if (connectionId) dropPortForwards(connectionId);
  }, [connected, machine, workspaceKey, connectionId]);

  const read = useCallback(async () => {
    if (!usable || !connectionId || !client) return;
    const [ports] = await Promise.all([client.listPorts().catch(() => null), readPortForwards(connectionId)]);
    if (!mounted.current || !ports) return;
    notePortProcesses(connectionId, ports.ports);
    setListening(ports.ports);
    setDetected(ports.detected);
  }, [client, connectionId, usable]);

  // Read while shown and connected; never while hidden. One read at a time.
  useEffect(() => {
    if (!active || !usable) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState !== "hidden") await read();
      if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, usable, read]);

  const forward = async (port: number): Promise<boolean> => {
    if (!connectionId) return false;
    setBusy(port);
    setError(null);
    try {
      await forwardPort(connectionId, port, sameNumber);
      return true;
    } catch (failure) {
      if (mounted.current) setError(portErrorMessage(failure, port, machine));
      return false;
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const stop = (port: number) => {
    if (!connectionId) return;
    setBusy(port);
    setError(null);
    forget(workspaceKey, port);
    void unforwardPort(connectionId, port)
      .catch((failure: unknown) => mounted.current && setError(portErrorMessage(failure, port, machine)))
      .finally(() => mounted.current && setBusy(null));
  };

  const copy = (localPort: number, port: number) => {
    void copyForwardUrl(localPort)
      .then(() => mounted.current && setCopied(port))
      .catch(() => undefined);
  };

  const open = (localPort: number) => {
    void openForwardInBrowser(localPort).catch(() => mounted.current && setError(`TerminalX's browser could not open 127.0.0.1:${localPort}. Try again.`));
  };

  const setSettings = (change: Partial<CloudPortSettings>) => {
    if (!connectionId) return;
    setError(null);
    void setPortSettings(connectionId, change).catch(() => mounted.current && setError("The forwarding switch could not be changed. Try again."));
  };

  // The rows: what is forwarded or waiting, then what expired, then what only listens.
  const listed = new Map((listening ?? []).map((entry) => [entry.port, entry]));
  const label = (port: number) => processLabel(listed.get(port)?.process ?? processes.get(port));
  const forwardedPorts = new Set(forwards.map((entry) => entry.port));
  const ended = expired.filter((entry) => !forwardedPorts.has(entry.port));
  const waitingWhy = !connected && machine ? `returns when ${machine.name} is back` : !settings.enabled ? "paused while Forwarding is off" : "opening again…";
  const forwardedRows: PortRowModel[] = [
    ...forwards.map((entry): PortRowModel =>
      entry.state === "waiting"
        ? { port: entry.port, label: label(entry.port), state: { kind: "waiting", forward: entry, why: waitingWhy } }
        : { port: entry.port, label: label(entry.port), state: { kind: "open", forward: entry, gone: listening !== null && detected && !listed.has(entry.port) } },
    ),
    // An expired forward is shown while the person can start it again; a machine's never expire while it is away.
    ...(connected ? ended.map((entry): PortRowModel => ({ port: entry.port, label: label(entry.port), state: { kind: "expired", localPort: entry.localPort } })) : []),
  ].sort((a, b) => a.port - b.port);
  const notForwarded: PortRowModel[] = connected
    ? [...listed.keys()].filter((port) => !forwardedPorts.has(port) && !ended.some((entry) => entry.port === port)).map((port) => ({ port, label: label(port), state: { kind: "listening" } }))
    : [];

  return {
    machine,
    connected,
    supported,
    usable,
    awayWithForwards: !connected && !!machine && forwards.length > 0,
    where,
    listening,
    detected,
    forwarded: forwardedRows,
    notForwarded,
    expiredCount: ended.length,
    settings,
    busy,
    error,
    copied,
    sameNumber,
    setSameNumber,
    forward,
    stop,
    copy,
    open,
    setSettings,
  };
}

// ---- pieces both views draw

/** The port field: the remote port, and whether to keep its number here (14.11). Enter forwards it. */
export function PortInput({ model, autoFocus, className, onDone }: { model: PortsModel; autoFocus?: boolean; className?: string; onDone?: () => void }) {
  const [typed, setTyped] = useState("");
  const wanted = Number(typed);
  const valid = /^\d{1,5}$/.test(typed) && wanted >= 1 && wanted <= 65535;
  const fieldLabel = model.machine ? `Port on ${model.machine.name}` : "Workspace port";
  return (
    <form
      className={cn("flex h-9 items-center gap-2 rounded-md border border-hairline bg-raised px-2.5 text-[12.5px]", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || model.busy !== null) return;
        void model.forward(wanted).then((done) => {
          if (!done) return;
          setTyped("");
          onDone?.();
        });
      }}
      data-testid="cloud-port-input"
    >
      <Hash className="size-[13px] shrink-0 text-faint" aria-hidden />
      <input
        aria-label={fieldLabel}
        inputMode="numeric"
        placeholder={fieldLabel}
        autoFocus={autoFocus}
        disabled={!model.usable}
        className="min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:font-sans placeholder:text-faint"
        value={typed}
        onChange={(event) => setTyped(event.target.value.trim())}
      />
      <button type="submit" className="sr-only" disabled={!valid || model.busy !== null}>
        Forward this port
      </button>
      <label className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <input type="checkbox" className="size-3.5 accent-(--accent)" checked={model.sameNumber} onChange={(event) => model.setSameNumber(event.target.checked)} />
        {SAME_PORT_LABEL}
      </label>
    </form>
  );
}

/** The rows of one list, with their actions. */
export function PortRows({ model, rows }: { model: PortsModel; rows: PortRowModel[] }) {
  return (
    <>
      {rows.map((row) => (
        <PortRow
          key={row.port}
          row={row}
          where={model.where}
          busy={model.busy === row.port}
          locked={model.busy !== null || !model.usable}
          copied={model.copied === row.port}
          onOpen={model.open}
          onCopy={(localPort) => model.copy(localPort, row.port)}
          onStop={model.stop}
          onForward={(port) => void model.forward(port)}
        />
      ))}
    </>
  );
}

/** While nothing is listed: looking, nothing listens, or the runtime cannot tell. */
export function PortsEmpty({ model }: { model: PortsModel }) {
  if (model.listening === null) {
    return (
      <p className="flex items-center gap-1.5 px-3.5 py-2 text-xs text-muted-foreground" data-testid="cloud-ports-looking">
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
        Looking for ports that listen {model.where}…
      </p>
    );
  }
  return (
    <p className="px-3.5 py-2 text-xs text-muted-foreground" data-testid="cloud-ports-empty">
      {model.detected
        ? `Nothing is listening ${model.where} yet. Start your application there, or enter its port below.`
        : `${model.machine ? model.machine.name : "This workspace"} cannot list its listening ports. Enter the port your application uses.`}
    </p>
  );
}

/** Where things stand while there is no connection, or why there are no ports to show; null when the list can be shown. */
function PortsUnavailable({ model, workspaceKey, state, mayOpen }: { model: PortsModel; workspaceKey: string; state: WorkspaceConnectionState; mayOpen: boolean }) {
  const { machine } = model;
  if (!model.connected) {
    const { text, restarting } = machine ? { text: machine.status, restarting: connectionText(state).restarting } : connectionText(state);
    return (
      <div className="px-3.5 py-2 text-xs text-muted-foreground" data-testid={restarting ? "cloud-ports-restarting" : "cloud-ports-stopped"}>
        <p className="flex items-center gap-1.5">
          {restarting && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
          {text}
        </p>
        {model.awayWithForwards && <p className="mt-1">Forwarded ports open again on this Mac when {machine!.name} is back.</p>}
        {!machine && model.expiredCount > 0 && <p className="mt-1">{CLOSED_WITH_CONNECTION}</p>}
      </div>
    );
  }
  if (!model.supported && isMachineKey(workspaceKey)) {
    return <MachineFeatureNotice workspaceKey={workspaceKey} capability="ports/1" granted={state.state === "connected" ? state.capabilities : null} className="m-3" />;
  }
  if (!model.supported) {
    return (
      <p className="px-3.5 py-2 text-xs text-muted-foreground" data-testid="cloud-ports-unsupported">
        {machine
          ? `The TerminalX on ${machine.name} does not forward ports yet. It will after ${machine.name} is updated.`
          : "This workspace's runtime does not offer previews yet. It will after the workspace's next runtime update."}
      </p>
    );
  }
  if (!mayOpen) {
    return (
      <p className="px-3.5 py-2 text-xs text-muted-foreground" data-testid="cloud-ports-forbidden">
        {machine
          ? `Forwarding a port needs the right to manage ${machine.name}: a forward reaches whatever listens on its local ports, as a terminal does.`
          : "Opening a preview needs the right to approve permissions, or to manage the workspace: a preview reaches whatever listens on the workspace's local ports, as a terminal does. Ask an admin."}
      </p>
    );
  }
  return null;
}

export { PortsUnavailable };

/**
 * The side panel's Ports tab (14.11): "Ports and previews" with the
 * Forwarding switch, FORWARDED (open, waiting and expired forwards) and NOT
 * FORWARDED, the port field, and what a forward exposes. A machine's tab
 * stays while it reconnects, its forwards shown as returning.
 *
 * Opening a forward only listens here and shows its address; a page opens,
 * in TerminalX's built-in browser, only when the person asks (Open).
 */
export function CloudPortsView(props: PortsInputs) {
  const { workspaceKey, state, mayOpen } = props;
  const model = usePorts(props);
  const { machine } = model;
  const header = (
    <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3.5 py-3 text-[13px]">
      <PlugZap className="size-[15px] shrink-0 text-add" aria-hidden />
      <span className="font-medium text-foreground">Ports and previews</span>
      {(model.usable || model.awayWithForwards) && (
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Forwarding
          <Switch aria-label="Forwarding" checked={model.settings.enabled} onCheckedChange={(enabled) => model.setSettings({ enabled })} />
        </label>
      )}
    </div>
  );
  const unavailable = <PortsUnavailable model={model} workspaceKey={workspaceKey} state={state} mayOpen={mayOpen} />;
  if (!model.usable && !model.awayWithForwards) {
    return (
      <div className="flex min-h-0 flex-1 flex-col text-xs" data-testid="cloud-ports-unavailable">
        {header}
        {unavailable}
      </div>
    );
  }
  const anyRows = model.forwarded.length + model.notForwarded.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="cloud-ports">
      {header}
      {!model.connected && unavailable}
      {model.error && (
        <p className="px-3.5 pt-2 text-xs text-destructive" role="alert">
          {model.error}
        </p>
      )}
      {model.forwarded.length > 0 && (
        <section aria-label="Forwarded">
          <PortSection>Forwarded</PortSection>
          <PortRows model={model} rows={model.forwarded} />
        </section>
      )}
      {model.notForwarded.length > 0 && (
        <section aria-label="Not forwarded">
          <PortSection>Not forwarded</PortSection>
          <PortRows model={model} rows={model.notForwarded} />
        </section>
      )}
      {model.connected && !anyRows && <PortsEmpty model={model} />}
      {model.connected && <PortInput model={model} className="mx-3.5 mt-2" />}
      <p className="mx-3.5 mt-3 mb-3 text-xs leading-4 text-faint">
        A forward opens {machine ? `a port of ${machine.name}` : "a workspace port"} at <span className="font-mono">127.0.0.1</span> on this Mac, over your encrypted connection to {machine ? machine.name : "the workspace"}; it has no public address. While a forward is open, other programs on this Mac can reach it, and it shares cookies with anything else on 127.0.0.1.
      </p>
    </div>
  );
}
