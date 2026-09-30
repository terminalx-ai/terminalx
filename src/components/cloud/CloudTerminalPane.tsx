import { useCallback, useState } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { TerminalView, createTerminal } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { cloudTerminalFactory, errorCode, takeControl, type CloudTerminal } from "@/lib/cloudTerminals";
import { getInstance } from "@/lib/terminal";

/**
 * One cloud shell (PRO-26): its xterm, and who controls its input. Shared by
 * the cloud workspace page and a cloud session's terminal tabs.
 */
export function CloudTerminalPane({
  workspace,
  terminal,
  client,
  connected,
  manage,
  base,
}: {
  workspace: string;
  terminal: CloudTerminal;
  client: WorkspaceRpcClient;
  connected: boolean;
  manage: boolean;
  base: () => ReturnType<typeof createTerminal>;
}) {
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
          <span>
            {manage ? "Another device controls this terminal's input and size; you are watching." : "View only: this attachment cannot type into or resize terminals."}
          </span>
          {manage && (
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
        <TerminalView id={terminal.id} visible create={create} fit={controlling && !terminal.gone} />
      </div>
    </div>
  );
}

function inputErrorText(code: string): string {
  switch (code) {
    case "not_controller":
      return "another device controls this terminal. Take control to type.";
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
