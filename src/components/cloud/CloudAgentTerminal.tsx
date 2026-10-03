import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceYou } from "@terminalx/portable/workspace";
import { TerminalView } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { inputErrorText, viewerText } from "@/components/cloud/CloudTerminalPane";
import { usePeople } from "@/lib/cloudPeople";
import {
  agentTerminalId,
  agentTerminalOf,
  attachAgentTerminal,
  cloudTerminalFactory,
  detachAgentTerminal,
  ensureAgentTerminal,
  errorCode,
  setCloudTerminalInputGate,
  takeControl,
  useCloudTerminals,
  type CloudTerminalInputGate,
} from "@/lib/cloudTerminals";
import type { AgentTerminalTarget } from "@/lib/sessionBackend";
import { getInstance } from "@/lib/terminal";
import { terminalSize } from "@/lib/terminalFit";

/**
 * The terminal view of a cloud agent tab (PRO-86): the terminal the tab's own
 * CLI runs in on the VM, streamed through the runtime like a cloud shell.
 *
 * - Looking costs nothing: on a stopped workspace it says Stopped and asks
 *   the server for nothing. Typing there wakes the workspace once, the way
 *   sending a message does; what was typed blind is not kept.
 * - It streams only while it shows, and attaching never starts the agent or
 *   takes it from anyone: the chat is the same conversation.
 * - One person types. `blocked` (a viewer, or someone else driving the tab)
 *   makes it read-only; otherwise the terminal's controller types, and
 *   everyone else sees who that is and may take control.
 */
export function CloudAgentTerminal({
  target,
  generation,
  tabId,
  active,
  blocked,
  you = null,
}: {
  target: AgentTerminalTarget;
  /** The backend's generation: the stream is attached again after every connect. */
  generation: string;
  tabId: string;
  /** The tab is on screen with its terminal view selected. */
  active: boolean;
  /** Why this person may not type here; null when they may. */
  blocked: string | null;
  /** Set on a shared workspace. */
  you?: WorkspaceYou | null;
}) {
  const { workspaceKey: workspace, client, base } = target;
  const id = agentTerminalId(workspace, tabId);
  const terminal = useCloudTerminals(workspace).agents?.find((item) => item.tabId === tabId) ?? null;
  // Names only matter on a shared workspace; a plain one fetches no roster.
  const nameOf = usePeople(!!you);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const create = useCallback(() => cloudTerminalFactory(workspace, ensureAgentTerminal(workspace, tabId), base)(), [workspace, tabId, base]);
  const running = target.process(tabId) === "running";

  // The view has a record before anything is asked of the runtime, so a stopped workspace has a terminal view too.
  useEffect(() => {
    ensureAgentTerminal(workspace, tabId);
  }, [workspace, tabId]);

  // Stream only while this view shows, and only over a connection that is already there.
  useEffect(() => {
    if (!active || !client) return;
    let cancelled = false;
    setError(null);
    void attachAgentTerminal(workspace, client, tabId, base).catch((e: unknown) => !cancelled && setError(errorCode(e)));
    return () => {
      cancelled = true;
      detachAgentTerminal(workspace, tabId);
    };
  }, [active, client, generation, workspace, tabId, base]);
  useEffect(() => {
    if (client) setWaking(false);
  }, [client]);

  // A control call on its way: the view does not ask twice for the same thing.
  const asking = useRef(false);
  const control = useCallback(
    async (start: boolean): Promise<boolean> => {
      if (!client) return false;
      asking.current = true;
      setBusy(true);
      setError(null);
      try {
        // The size this view fits itself to (`TerminalView`), so taking control is one resize of the agent's screen, not two.
        const instance = getInstance(id, create);
        const box = instance.el.parentElement;
        const size = (box && terminalSize(instance.term, box)) ?? instance.fit.proposeDimensions();
        await takeControl(workspace, client, id, size && size.cols > 0 && size.rows > 0 ? { cols: size.cols, rows: size.rows } : null, { start });
        return true;
      } catch (e) {
        setError(errorCode(e));
        return false;
      } finally {
        asking.current = false;
        setBusy(false);
      }
    },
    [client, workspace, id, create],
  );

  // Every keystroke asks here first. The xterm outlives this render, so it reads the gate of now.
  const gate = useRef<CloudTerminalInputGate>(() => false);
  gate.current = async () => {
    if (blocked) return false;
    if (!client) {
      // Stopped: one wake, as a send asks for. Nothing is typed into a screen nobody has seen.
      if (target.asleep) {
        setWaking(true);
        target.wake();
      }
      return false;
    }
    const now = agentTerminalOf(workspace, tabId);
    // Until it is attached, who controls it is not known; someone else's terminal is taken explicitly.
    if (!now || now.gone || !now.live || now.control === "other") return false;
    const runs = target.process(tabId) === "running";
    if (now.control === "none" || !runs) {
      const taken = await control(!runs);
      // The key that starts the agent is not typed into a CLI that is still starting.
      return taken && runs;
    }
    return true;
  };
  useEffect(() => {
    setCloudTerminalInputGate(id, (data) => gate.current(data));
    return () => setCloudTerminalInputGate(id, null);
  }, [id]);

  // Nobody controls it, and this person may type: take it at this view's size, as opening a local tab does.
  // Never while someone else controls it, and never to start an agent that is not running.
  const live = !!terminal?.live;
  const controlState = terminal?.control ?? "none";
  useEffect(() => {
    if (!active || !client || blocked || !live || controlState !== "none" || !running || asking.current) return;
    void control(false);
  }, [active, client, blocked, live, controlState, running, generation]);

  const controlling = controlState === "you" && !!client && !blocked;
  const controller = terminal?.controllerId && terminal.controllerId !== you?.userId ? `${nameOf(terminal.controllerId)} controls this terminal; you are watching. ` : "";
  let status: { text: string; action?: { label: string; start: boolean } } | null = null;
  if (!client) {
    if (target.asleep) {
      status = {
        text: blocked
          ? "Stopped: nothing runs while the workspace is stopped."
          : waking
            ? "Stopped: waking the workspace. The agent's terminal appears once it runs."
            : "Stopped: the workspace is asleep. Typing here wakes it, as sending a message does.",
      };
    } else status = { text: "Connecting to the workspace…" };
  } else if (terminal?.gone === "closed") status = { text: "This terminal closed with its tab." };
  else if (blocked) status = { text: `Read-only. ${controller}${blocked}` };
  else if (terminal && controlState === "other") status = { text: viewerText(terminal, false, true, you, nameOf), action: { label: "Take control", start: false } };
  else if (!running) {
    status = {
      text: `${target.process(tabId) === "exited" ? "The agent is not running; its conversation is saved." : "The agent has not started yet."} Press a key here, or Start, to run it.`,
      action: { label: "Start agent", start: true },
    };
  } else if (terminal && controlState === "none" && live) status = { text: viewerText(terminal, false, true, you, nameOf), action: { label: "Take control", start: false } };

  const failure = error ?? terminal?.inputError ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cloud-agent-terminal">
      {status && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1 text-xs text-muted-foreground" data-testid="cloud-agent-terminal-status" role="status">
          <span>{status.text}</span>
          {status.action && (
            <Button size="sm" variant="outline" disabled={busy || !live} onClick={() => void control(status.action!.start)}>
              {status.action.label}
            </Button>
          )}
        </div>
      )}
      {failure && client && (
        <p className="shrink-0 border-b border-hairline px-3 py-1 text-xs text-muted-foreground" data-testid="cloud-agent-terminal-notice" role="alert">
          {error ? `That did not work: ${inputErrorText(error, true)}` : `Input was not delivered: ${inputErrorText(failure, true)}`}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <TerminalView id={id} visible={active} create={create} fit={controlling && !terminal?.gone} />
      </div>
    </div>
  );
}
