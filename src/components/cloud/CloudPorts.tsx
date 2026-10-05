import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2 } from "lucide-react";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { api, type CloudPortForward } from "@/lib/api";

/** How often the list is read while the panel is on screen. */
const POLL_MS = 5_000;

const STOPPED = "Previews work while the workspace is running. Looking here never starts it.";

/** What a refused forward means, in words. `port` is the workspace's port. */
export function portErrorMessage(error: unknown, port: number): string {
  const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : String(error);
  switch (code) {
    case "cloud_port_in_use":
      return `Port ${port} is already in use on this Mac. Untick "Same port number as the workspace" to use a free one.`;
    case "cloud_port_not_connected":
      return STOPPED;
    case "cloud_port_invalid":
      return "Enter a port between 1 and 65535.";
    case "forbidden":
      return "You do not have access to this workspace's ports.";
    case "cloud_remote_identity_changed":
    case "cloud_remote_connection_unknown":
      return "The connection to this workspace changed. Open the workspace again.";
    default:
      return "The preview could not be opened. Try again.";
  }
}

// 127.0.0.1, never `localhost`: the listener is IPv4 only, and `localhost`
// could reach another program listening on IPv6 loopback at that port.
const previewUrl = (forward: CloudPortForward) => `http://127.0.0.1:${forward.localPort}`;

/**
 * A workspace's ports and previews (PRO-28, docs/CLOUD-PREVIEWS.md). A
 * preview is a forward to this Mac's loopback over the workspace connection:
 * there is no public address. Nothing here starts a stopped workspace.
 *
 * `connectionId` names the native connection the forwards belong to; `mayOpen`
 * is the terminal's rule (a manager, or a driver who may approve).
 */
export function CloudPortsView({
  client,
  state,
  connectionId,
  mayOpen,
  active,
}: {
  client: WorkspaceRpcClient;
  state: WorkspaceConnectionState;
  connectionId: string | null;
  mayOpen: boolean;
  active: boolean;
}) {
  const connected = state.state === "connected";
  const supported = connected && state.capabilities.includes("ports/1");
  const usable = supported && mayOpen && !!connectionId;
  const [listening, setListening] = useState<number[]>([]);
  const [detected, setDetected] = useState(true);
  const [forwards, setForwards] = useState<CloudPortForward[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  // Ask for the workspace's own port number on this Mac, and refuse if taken.
  const [sameNumber, setSameNumber] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    if (!usable || !connectionId) return;
    const [ports, open] = await Promise.all([client.listPorts().catch(() => null), api.cloudPortForwards(connectionId).catch(() => null)]);
    if (!mounted.current) return;
    if (ports) {
      setListening(ports.ports.map((entry) => entry.port));
      setDetected(ports.detected);
    }
    if (open) setForwards(open);
  }, [client, connectionId, usable]);

  // Read while shown and connected; never while hidden.
  useEffect(() => {
    if (!active || !usable) return;
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void read();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, usable, read]);
  // The connection went: its forwards were closed with it, and do not come back.
  useEffect(() => {
    if (!connected) {
      setListening([]);
      setForwards([]);
    }
  }, [connected]);

  const open = async (port: number) => {
    if (!connectionId) return;
    setBusy(port);
    setError(null);
    try {
      const forward = await api.cloudPortForward(connectionId, port, sameNumber ? { localPort: port, exact: true } : {});
      if (!mounted.current) return;
      setForwards((current) => [...current.filter((other) => other.port !== port), forward].sort((a, b) => a.port - b.port));
      await openUrl(previewUrl(forward));
    } catch (failure) {
      if (mounted.current) setError(portErrorMessage(failure, port));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const stop = async (port: number) => {
    if (!connectionId) return;
    setBusy(port);
    setError(null);
    try {
      await api.cloudPortUnforward(connectionId, port);
      if (mounted.current) setForwards((current) => current.filter((other) => other.port !== port));
    } catch (failure) {
      if (mounted.current) setError(portErrorMessage(failure, port));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  if (!connected) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="cloud-ports-stopped">
        {STOPPED}
      </p>
    );
  }
  if (!supported) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="cloud-ports-unsupported">
        This workspace's runtime does not offer previews yet. It will after the workspace's next runtime update.
      </p>
    );
  }
  if (!mayOpen) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="cloud-ports-forbidden">
        Opening a preview needs the right to approve permissions, or to manage the workspace: a preview reaches whatever listens on the workspace's local ports, as a terminal does. Ask an admin.
      </p>
    );
  }

  const forwarded = new Map(forwards.map((forward) => [forward.port, forward]));
  const ports = [...new Set([...listening, ...forwards.map((forward) => forward.port)])].sort((a, b) => a - b);
  const wanted = Number(typed);
  const typedValid = /^\d{1,5}$/.test(typed) && wanted >= 1 && wanted <= 65535;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto text-xs" data-testid="cloud-ports">
      <p className="border-b border-hairline px-3 py-2 text-muted-foreground">
        A preview opens a workspace port at <span className="text-foreground">127.0.0.1</span> on this Mac, over your encrypted connection to the workspace. It has no public address, and it closes when the workspace stops or your access does. While it is open, other programs on this Mac can connect to it, and it shares cookies with anything else you use at 127.0.0.1.
      </p>
      {error && (
        <p className="px-3 py-1 text-red-500" role="alert">
          {error}
        </p>
      )}
      <ul className="divide-y divide-hairline">
        {ports.map((port) => {
          const forward = forwarded.get(port);
          const gone = !listening.includes(port);
          return (
            <li key={port} className="flex flex-wrap items-center gap-2 px-3 py-1.5" data-testid="cloud-port">
              <span className="w-14 font-mono text-foreground">{port}</span>
              {forward ? (
                <>
                  <button type="button" className="font-mono underline decoration-hairline-strong underline-offset-2" onClick={() => void openUrl(previewUrl(forward))}>
                    {previewUrl(forward)}
                  </button>
                  {gone && detected && <span className="text-muted-foreground">nothing is listening in the workspace now</span>}
                  <Button className="ml-auto" size="xs" variant="ghost" disabled={busy === port} onClick={() => void stop(port)}>
                    Stop
                  </Button>
                </>
              ) : (
                <Button className="ml-auto" size="xs" variant="outline" disabled={busy !== null} onClick={() => void open(port)}>
                  {busy === port ? <Loader2 className="animate-spin" /> : "Open preview"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {ports.length === 0 && (
        <p className="px-3 py-2 text-muted-foreground" data-testid="cloud-ports-empty">
          {detected ? "Nothing is listening in the workspace yet. Start your application there, or enter its port below." : "This workspace cannot list its listening ports. Enter the port your application uses."}
        </p>
      )}
      <form
        className="flex flex-wrap items-center gap-2 border-t border-hairline px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (typedValid) void open(wanted).then(() => mounted.current && setTyped(""));
        }}
      >
        <input aria-label="Workspace port" inputMode="numeric" placeholder="Port" className="h-7 w-20 rounded-md border border-hairline bg-background px-2 font-mono" value={typed} onChange={(event) => setTyped(event.target.value.trim())} />
        <Button type="submit" size="xs" variant="outline" disabled={!typedValid || busy !== null}>
          Open preview
        </Button>
        <label className="ml-auto flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={sameNumber} onChange={(event) => setSameNumber(event.target.checked)} />
          Same port number as the workspace
        </label>
      </form>
    </div>
  );
}
