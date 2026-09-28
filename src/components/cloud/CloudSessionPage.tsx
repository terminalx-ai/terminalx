import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Cloud, Loader2, Plug, TerminalSquare, Bot } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { mergeAgentEvents, type AgentEvent } from "@terminalx/portable/events";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import {
  api,
  devWorkspaceConnection,
  workspaceConnection,
  type CloudWorkspaceConnection,
  type CloudWorkspaceListItem,
} from "@/lib/api";

/**
 * A session in a cloud workspace: the desktop attaches to the workspace's
 * remote runtime (PRO-13) and drives a terminal and an agent tab in it over
 * the relay. Deliberately minimal; the full cloud tab experience is PRO-26/PRO-22.
 */
export function CloudSessionPage({ onBack }: { onBack: () => void }) {
  const [workspaces, setWorkspaces] = useState<CloudWorkspaceListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [connection, setConnection] = useState<CloudWorkspaceConnection | null>(null);
  const [state, setState] = useState<WorkspaceConnectionState>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [view, setView] = useState<"terminal" | "agent">("terminal");

  useEffect(() => {
    api
      .cloudWorkspaces()
      .then((list) => setWorkspaces(list.workspaces))
      .catch((e: unknown) => setListError(errorCode(e)));
  }, []);

  useEffect(() => {
    if (!connection) return;
    return connection.client.onState(setState);
  }, [connection]);

  useEffect(() => () => connection?.close(), [connection]);

  const open = useCallback(async (item: CloudWorkspaceListItem) => {
    setError(null);
    try {
      // Opening a session is interactive: it may wake suspended compute.
      const next = await workspaceConnection(
        { kind: "cloud", organizationId: item.workspace.orgId, workspaceId: item.workspace.id },
        item.workspace.state === "suspended" ? "wake" : "connect",
      );
      setConnection(next);
    } catch (e) {
      setError(errorCode(e));
    }
  }, []);

  const openDev = useCallback(async () => {
    setError(null);
    try {
      setConnection(await devWorkspaceConnection(pairingCode.trim()));
    } catch (e) {
      setError(errorCode(e));
    }
  }, [pairingCode]);

  const connected = state.state === "connected";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-testid="cloud-session-page">
      <div className="flex h-(--titlebar-h) shrink-0 items-center gap-2 border-b border-hairline pl-[78px] pr-3" data-tauri-drag-region>
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <Cloud className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Cloud workspace session</span>
        <span className="ml-auto text-xs text-muted-foreground" data-testid="cloud-connection-state">
          {describe(state)}
        </span>
      </div>
      {!connection ? (
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Workspaces in this organization</h2>
            {listError && <p className="text-xs text-muted-foreground">Cloud workspaces are unavailable ({listError}).</p>}
            {!workspaces && !listError && <Loader2 className="size-4 animate-spin" />}
            {workspaces?.length === 0 && <p className="text-xs text-muted-foreground">No cloud workspaces yet.</p>}
            {workspaces?.map((item) => (
              <div key={item.workspace.id} className="flex items-center gap-3 rounded-md border border-hairline px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{item.workspace.name}</span>
                  <span className="text-xs text-muted-foreground">{item.workspace.state}</span>
                </div>
                <Button
                  size="sm"
                  disabled={!["ready", "suspended"].includes(item.workspace.state)}
                  onClick={() => void open(item)}
                >
                  {item.workspace.state === "suspended" ? "Resume and open" : "Open session"}
                </Button>
              </div>
            ))}
          </section>
          {import.meta.env.DEV && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Development: attach by pairing code</h2>
              <p className="text-xs text-muted-foreground">
                For a local <code>terminalx-serve --relay-link</code> runtime; debug builds only.
              </p>
              <div className="flex gap-2">
                <input
                  aria-label="Pairing code"
                  className="min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-2 py-1 font-mono text-xs"
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder="pairing code"
                />
                <Button size="sm" disabled={!pairingCode.trim()} onClick={() => void openDev()}>
                  <Plug className="size-3.5" /> Attach
                </Button>
              </div>
            </section>
          )}
          {error && <p className="text-xs text-red-500">Could not open: {error}</p>}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 gap-1 border-b border-hairline px-3 py-1">
            <Button size="sm" variant={view === "terminal" ? "secondary" : "ghost"} onClick={() => setView("terminal")}>
              <TerminalSquare className="size-3.5" /> Terminal
            </Button>
            <Button size="sm" variant={view === "agent" ? "secondary" : "ghost"} onClick={() => setView("agent")}>
              <Bot className="size-3.5" /> Agent
            </Button>
          </div>
          {!connected && <div className="px-4 py-1 text-xs text-muted-foreground">{describe(state)}</div>}
          {/* Both stay mounted across reconnects and view switches: the
              terminal and the agent tab live on the runtime, and the client
              resumes their streams from the last offset or cursor. */}
          <div className={view === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <RemoteTerminal client={connection.client} />
          </div>
          <div className={view === "agent" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <RemoteAgent client={connection.client} />
          </div>
        </div>
      )}
    </div>
  );
}

function RemoteTerminal({ client }: { client: WorkspaceRpcClient }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 12.5, scrollback: 10_000, convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    let ptyId: string | null = null;
    let detach: (() => void) | null = null;
    let disposed = false;
    const decoder = new TextDecoder();
    void (async () => {
      try {
        await firstConnect(client);
        if (disposed) return;
        const created = await client.mutate<{ ptyId: string }>("pty.create", { cols: term.cols, rows: term.rows });
        if (disposed) return;
        ptyId = created.ptyId;
        detach = await client.attachPty(
          created.ptyId,
          (bytes) => term.write(decoder.decode(bytes, { stream: true })),
          (code) => term.write(`\r\n[process exited${code === null ? "" : ` with ${code}`}]\r\n`),
        );
        term.focus();
      } catch (e) {
        setError(errorCode(e));
      }
    })();
    const input = term.onData((data) => {
      if (ptyId) void client.write(ptyId, data).catch((e: unknown) => setError(errorCode(e)));
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (ptyId) void client.call("pty.resize", { ptyId, cols, rows }).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* not laid out */
      }
    });
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      detach?.();
      if (ptyId) void client.call("pty.kill", { ptyId }).catch(() => undefined);
      term.dispose();
    };
  }, [client]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && <p className="px-3 py-1 text-xs text-red-500">Terminal: {error}</p>}
      <div ref={host} className="min-h-0 flex-1 px-2 pt-1" data-testid="cloud-terminal" />
    </div>
  );
}

function RemoteAgent({ client }: { client: WorkspaceRpcClient }) {
  const [agent, setAgent] = useState("claude");
  const [prompt, setPrompt] = useState("");
  const [tab, setTab] = useState<{ sessionId: string; tabId: string } | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tab) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void client
      .subscribeSession(tab.sessionId, tab.tabId, (event) => setEvents((current) => mergeAgentEvents(current, [event as AgentEvent])))
      .then((unsubscribe) => (cancelled ? unsubscribe() : (stop = unsubscribe)))
      .catch((e: unknown) => setError(errorCode(e)));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [client, tab]);

  const send = async () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      if (!tab) {
        const created = await client.mutate<{ sessionId: string; tabId: string }>("session.create", { agent, prompt: text });
        setTab({ sessionId: created.sessionId, tabId: created.tabId });
      } else {
        // One id per prompt: a resend after a reconnect does not prompt twice.
        await client.mutate("session.send", { sessionId: tab.sessionId, tabId: tab.tabId, text });
      }
      setPrompt("");
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="cloud-agent">
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-hairline p-2 text-xs">
        {events.length === 0 && <p className="text-muted-foreground">{tab ? "Waiting for the agent…" : "Start an agent tab in the cloud workspace."}</p>}
        {events.map((event) => {
          const text = eventText(event);
          return text ? (
            <p key={event.seq} className="whitespace-pre-wrap py-0.5">
              <span className="text-muted-foreground">{event.payload.type}: </span>
              {text}
            </p>
          ) : null;
        })}
      </div>
      {error && <p className="text-xs text-red-500">Agent: {error}</p>}
      <div className="flex gap-2">
        {!tab && (
          <select aria-label="Agent" className="rounded-md border border-hairline bg-transparent px-2 text-xs" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        )}
        <input
          aria-label="Prompt"
          className="min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-2 py-1 text-xs"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          placeholder={tab ? "Message the agent" : "First prompt"}
        />
        <Button size="sm" disabled={busy || !prompt.trim()} onClick={() => void send()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : tab ? "Send" : "Start"}
        </Button>
      </div>
    </div>
  );
}

/** Resolves on the first `connected` state; the page mounts before that. */
function firstConnect(client: WorkspaceRpcClient): Promise<void> {
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    stop = client.onState((state) => {
      if (state.state !== "connected") return;
      queueMicrotask(() => stop?.());
      resolve();
    });
  });
}

function eventText(event: AgentEvent): string | null {
  const payload = event.payload;
  switch (payload.type) {
    case "user_message":
    case "assistant_text":
    case "status":
      return payload.text;
    case "turn_completed":
      return payload.finalText ?? payload.status;
    case "error":
      return payload.message;
    case "tool_call_started":
      return payload.title ?? payload.name;
    default:
      return null;
  }
}

function describe(state: WorkspaceConnectionState): string {
  switch (state.state) {
    case "connected":
      return `Connected · runtime ${state.runtimeVersion} · generation ${state.runtimeGeneration} · ${state.authority}`;
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return `Reconnecting (attempt ${state.attempt})…`;
    case "opening":
      return "Checking the workspace…";
    case "waitingForRuntime":
      return "Waiting for the workspace runtime…";
    case "suspended":
      return "Suspended";
    case "updateRequired":
      return "Update TerminalX to connect to this workspace";
    case "stopped":
      return "Disconnected";
    default:
      return "Not connected";
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return error instanceof Error ? error.message : String(error);
}
