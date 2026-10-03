import { useCallback, useState } from "react";
import type { WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import type { TerminalDropRefusal } from "@/components/terminal/TerminalDrop";
import { TerminalView, createTerminal } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { usePeople } from "@/lib/cloudPeople";
import { cloudTerminalFactory, errorCode, takeControl, type CloudTerminal } from "@/lib/cloudTerminals";
import { getInstance } from "@/lib/terminal";

/**
 * One cloud shell (PRO-26): its xterm, and who controls its input. Shared by
 * the cloud workspace page and a cloud session's terminal tabs. On a shared
 * workspace (PRO-30) it names who is typing and lets a driver take control.
 */
export function CloudTerminalPane({
  workspace,
  terminal,
  client,
  connected,
  manage,
  mayControl = manage,
  you = null,
  base,
}: {
  workspace: string;
  terminal: CloudTerminal;
  client: WorkspaceRpcClient;
  connected: boolean;
  manage: boolean;
  /** May take control (manage authority, or a driver or manager of a shared workspace). */
  mayControl?: boolean;
  /** Set on a runtime with `collab/1`. */
  you?: WorkspaceYou | null;
  base: () => ReturnType<typeof createTerminal>;
}) {
  // Names only matter on a shared workspace; a plain one fetches no roster.
  const nameOf = usePeople(!!you);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useCallback(() => cloudTerminalFactory(workspace, terminal, base)(), [workspace, terminal.id]);
  const controlling = terminal.control === "you";

  const control = async () => {
    setBusy(true);
    setError(null);
    try {
      const instance = getInstance(terminal.id, create);
      const size = instance.fit.proposeDimensions();
      await takeControl(workspace, client, terminal.id, size && size.cols > 0 && size.rows > 0 ? { cols: size.cols, rows: size.rows } : null);
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  let notice: string | null = null;
  if (terminal.gone === "runtime-restarted") notice = "This terminal ended when the workspace runtime restarted. Input is not sent anywhere.";
  else if (terminal.gone === "closed") notice = "This terminal was closed.";
  else if (terminal.exited) notice = `The shell exited${terminal.exitCode === null ? "" : ` with code ${terminal.exitCode}`}.`;
  else if (terminal.inputError) notice = `Input was not delivered: ${inputErrorText(terminal.inputError)}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cloud-terminal">
      {!terminal.gone && !terminal.exited && !controlling && (
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-1 text-xs text-muted-foreground" data-testid="cloud-terminal-viewer">
          <span>{viewerText(terminal, manage, mayControl, you, nameOf)}</span>
          {mayControl && (
            <Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => void control()}>
              Take control
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p className="border-b border-hairline px-3 py-1 text-xs text-muted-foreground" data-testid="cloud-terminal-notice">
          {notice}
        </p>
      )}
      {error && <p className="px-3 py-1 text-xs text-red-500">{error}</p>}
      <div className="min-h-0 flex-1">
        <TerminalView id={terminal.id} visible create={create} fit={controlling && !terminal.gone} dropRefusal={dropRefusal(terminal, mayControl)} />
      </div>
    </div>
  );
}

/**
 * What a cloud terminal does not take by drag and drop. A dropped file is
 * never typed: its path is one on this computer, not on the workspace.
 * Whoever cannot type there cannot drop text there either.
 */
export function dropRefusal(terminal: CloudTerminal, mayControl: boolean): TerminalDropRefusal {
  let watching: string | null = null;
  if (terminal.gone || terminal.exited) watching = "This terminal has ended. Nothing can be dropped on it.";
  else if (terminal.control !== "you") watching = mayControl ? "You are watching this terminal. Take control to drop into it." : "View only: you cannot drop into this terminal.";
  if (watching) return { files: watching, text: watching };
  return { files: "Files can't be dropped on a cloud terminal yet: a path on this computer does not exist on the workspace." };
}

/** Why this view only watches the terminal, and who controls it. */
export function viewerText(
  terminal: CloudTerminal,
  manage: boolean,
  mayControl: boolean,
  you: WorkspaceYou | null,
  nameOf: (userId: string | null | undefined) => string,
): string {
  const controller = terminal.controllerId;
  if (controller && controller === you?.userId) return "You control this terminal from another window or device; you are watching here.";
  if (controller) {
    const who = nameOf(controller);
    // Holding control is not typing: the banner says who has the input, not what they are doing with it.
    return mayControl ? `${who} controls this terminal; you are watching.` : `${who} controls this terminal. View only: you can watch; ask an admin for driver access to type.`;
  }
  if (you && !mayControl) return "View only: you can watch this terminal; ask an admin for driver access to type.";
  if (manage || mayControl) return "Another device controls this terminal's input and size; you are watching.";
  return "View only: this attachment cannot type into or resize terminals.";
}

function inputErrorText(code: string): string {
  switch (code) {
    case "not_controller":
      return "another device controls this terminal. Take control to type.";
    case "forbidden":
      return "your access to this workspace does not allow typing in terminals.";
    case "unavailable":
      return "the shell has exited.";
    case "not_found":
      return "the terminal no longer exists.";
    case "not connected":
      return "not connected to the workspace.";
    default:
      return code;
  }
}
