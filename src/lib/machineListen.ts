import { useCallback, useEffect, useState } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { errorMessage } from "@/lib/api";
import type { MachineListen, MachineListenStatus, MachineRunsAs } from "@/types/machines";

/**
 * Where a machine listens and who its runtime runs as (PRO-487): the words
 * Settings → Machines and a machine's page share, and the reading a page
 * takes from `machine.describe`.
 */
export const LISTEN_CHOICES: readonly { value: MachineListen; label: string; exposes: string }[] = [
  { value: "relay", label: "Relay only", exposes: "No port is opened. Computers and phones reach it through the TerminalX relay, end-to-end encrypted." },
  { value: "tailscale", label: "Tailscale", exposes: "TCP 6768 on its Tailscale address only." },
  { value: "lan", label: "Local network", exposes: "TCP 6768 on its private network and Tailscale addresses." },
  { value: "all", label: "All interfaces", exposes: "TCP 6768 on every address it has, public ones included." },
];

export function listenChoice(value: MachineListen) {
  return LISTEN_CHOICES.find((choice) => choice.value === value) ?? LISTEN_CHOICES[0];
}

/** "Listening on 192.168.1.20:6768 and 100.93.49.78:6768", "Listening on every interface, port 6768", "No port is open". */
export function listeningText(status: MachineListenStatus): string {
  if (!status.addresses.length) return status.choice === "relay" ? "No port is open." : "No port is open: it has no address of that kind right now.";
  const every = status.addresses.find((address) => address.startsWith("0.0.0.0:"));
  if (every) return `Listening on every interface, port ${every.slice(every.lastIndexOf(":") + 1)}.`;
  const list = status.addresses.length === 1 ? status.addresses[0] : `${status.addresses.slice(0, -1).join(", ")} and ${status.addresses[status.addresses.length - 1]}`;
  return `Listening on ${list}.`;
}

/** Who is answered from public addresses, said beside the choice. */
export function publicCallersText(status: MachineListenStatus): string {
  if (status.allowPublic) return "Callers from public addresses are answered.";
  if (status.choice === "all") return "Callers from public addresses are refused.";
  return "";
}

/** "Runs as dev", "Runs as root". */
export function runsAsText(runsAs: MachineRunsAs): string {
  return `Runs as ${runsAs.user}`;
}

/** What that user's sudo means for everything acting through the runtime; null when there is nothing to say (root says it itself). */
export function sudoText(runsAs: MachineRunsAs): string | null {
  if (runsAs.root) return null;
  if (runsAs.passwordlessSudo === true) return "Passwordless sudo: paired computers and agents can become root.";
  if (runsAs.passwordlessSudo === false) return "No passwordless sudo.";
  return null;
}

export const ROOT_WARNING = "Every paired computer and every agent on it acts as root.";

export interface MachineHostingState {
  listen: MachineListenStatus | null;
  runsAs: MachineRunsAs | null;
  /** Read at least once. */
  ready: boolean;
  busy: boolean;
  error: string | null;
}

const NONE: MachineHostingState = { listen: null, runsAs: null, ready: false, busy: false, error: null };

function listenStatus(value: unknown): MachineListenStatus | null {
  if (!value || typeof value !== "object") return null;
  const status = value as Partial<MachineListenStatus>;
  if (!LISTEN_CHOICES.some((choice) => choice.value === status.choice) || !Array.isArray(status.addresses)) return null;
  return {
    choice: status.choice as MachineListen,
    chosen: status.chosen !== false,
    addresses: status.addresses.filter((address): address is string => typeof address === "string"),
    allowPublic: status.allowPublic === true,
    askPublic: status.askPublic === true,
    refusedPublicAt: typeof status.refusedPublicAt === "number" ? status.refusedPublicAt : null,
  };
}

function runsAs(value: unknown): MachineRunsAs | null {
  if (!value || typeof value !== "object") return null;
  const who = value as Partial<MachineRunsAs>;
  if (typeof who.user !== "string" || !who.user) return null;
  return { user: who.user, root: who.root === true, passwordlessSudo: typeof who.passwordlessSudo === "boolean" ? who.passwordlessSudo : null };
}

/**
 * A paired machine's hosting, read from `machine.describe` when its page
 * opens and after each change. `setListen` asks the machine to listen
 * elsewhere (`machine.setListen`, `machine/9`, a manager); its answer is the
 * new state.
 */
export function useMachineHosting(client: WorkspaceRpcClient | null, connected: boolean): MachineHostingState & { setListen: (listen: MachineListen, allowPublic: boolean) => Promise<void> } {
  const [state, setState] = useState<MachineHostingState>(NONE);
  useEffect(() => {
    setState(NONE);
  }, [client]);
  useEffect(() => {
    if (!client || !connected) return;
    let live = true;
    void (async () => {
      try {
        const described = await client.call<{ listen?: unknown; runsAs?: unknown }>("machine.describe");
        if (live) setState((now) => ({ ...now, listen: listenStatus(described.listen), runsAs: runsAs(described.runsAs), ready: true, error: null }));
      } catch (error) {
        if (live) setState((now) => ({ ...now, ready: true, error: errorMessage(error) }));
      }
    })();
    return () => {
      live = false;
    };
  }, [client, connected]);
  const setListen = useCallback(
    async (listen: MachineListen, allowPublic: boolean) => {
      if (!client) return;
      setState((now) => ({ ...now, busy: true, error: null }));
      try {
        const answered = listenStatus((await client.call<{ listen?: unknown }>("machine.setListen", { listen, allowPublic })).listen);
        setState((now) => ({ ...now, listen: answered ?? now.listen, busy: false }));
      } catch (error) {
        setState((now) => ({ ...now, busy: false, error: errorMessage(error) }));
      }
    },
    [client],
  );
  return { ...state, setListen };
}
