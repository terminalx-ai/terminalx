import { useId, useState } from "react";
import { thisComputer } from "@/lib/platform";
import { ChevronsRight, PlugZap, Plus } from "@/icons";
import { Switch } from "@/components/ui/controls";
import { Button } from "@/components/ui/button";
import { AUTO_FORWARD_SKIPPED } from "@/lib/api";
import { FORWARDING_OFF, INVALID_PORT, SSH_PORT_RESERVED, PortInput, PortRows, PortsEmpty, PortsUnavailable, usePorts, validPort, type PortsInputs, type PortsModel } from "./CloudPorts";
import { PortSection } from "./PortRow";

/** "32768–60999": the ports automatic forwarding leaves alone. */
export const SKIPPED_RANGE = `${AUTO_FORWARD_SKIPPED.from}–${AUTO_FORWARD_SKIPPED.to}`;

/**
 * "Forward ports to this Mac" (14.10), opened from the header's forward chip:
 * the Forwarding switch, "Forward new ports automatically", every port that
 * listens there with its forward, "+ Forward a port", and how forwards are
 * reached. It reads the list only while open.
 */
export function PortsPopover(props: PortsInputs & { shortcut?: boolean; forwardingError?: boolean; onSetForwarding?: (enabled: boolean) => void }) {
  const model = usePorts(props);
  const [adding, setAdding] = useState(false);
  const { machine } = model;
  const switches = model.usable || model.awayWithForwards;
  const rows = [...model.forwarded, ...model.notForwarded];
  const forwardingOff = !!props.phase2 && !model.settings.enabled;
  const empty = !!props.phase2 && model.detected && model.listening !== null && !rows.length;
  const setForwarding = props.onSetForwarding ?? ((enabled: boolean) => model.setSettings({ enabled }));
  return (
    <div className="text-[13px]" data-testid="ports-popover">
      <div className="flex h-11 items-center gap-2.5 border-b border-hairline px-3.5">
        <PlugZap className="size-[15px] shrink-0 text-add" aria-hidden />
        <span className="font-medium text-foreground">Forward ports</span>
        <span className="text-xs text-faint">to {thisComputer}</span>
        {switches && (
          <span className="ml-auto flex items-center gap-2">
            {props.shortcut && <kbd className="rounded border border-hairline px-1 font-mono text-[11px] text-muted-foreground" aria-hidden>⌘Y</kbd>}
            <Switch aria-label="Forwarding" aria-keyshortcuts={props.shortcut ? "Meta+Y" : undefined} checked={model.settings.enabled} onCheckedChange={setForwarding} />
          </span>
        )}
      </div>
      {switches && (
        <label className="flex h-10 items-center gap-2.5 border-b border-hairline px-3.5 text-[12.5px] text-foreground">
          <ChevronsRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          Forward new ports automatically
          <span className="ml-auto flex items-center">
            <Switch aria-label="Forward new ports automatically" checked={model.settings.auto} disabled={!model.settings.enabled} onCheckedChange={(auto) => model.setSettings({ auto })} />
          </span>
        </label>
      )}
      {!model.usable && <PortsUnavailable model={model} workspaceKey={props.workspaceKey} state={props.state} mayOpen={props.mayOpen} />}
      {(model.usable || model.awayWithForwards) && (
        <>
          <PortSection
            trailing={
            model.usable && !forwardingOff ? (
              <button type="button" className="flex items-center gap-1 hover:text-foreground" aria-expanded={adding} onClick={() => setAdding((open) => !open)}>
                <Plus className="size-3" aria-hidden />
                Forward a port
              </button>
              ) : undefined
            }
          >
            {empty ? "No ports detected" : "Ports detected"}
          </PortSection>
          {props.forwardingError && <p className="px-3.5 pt-1 text-xs text-destructive" role="alert">The forwarding switch could not be changed. Try again.</p>}
          {model.error && (
            <p className="px-3.5 pt-1 text-xs text-destructive" role="alert">
              {model.error}
            </p>
          )}
          {adding && model.usable && !props.phase2 && <PortInput model={model} autoFocus className="mx-3.5 my-1.5" onDone={() => setAdding(false)} />}
          <div className="max-h-72 overflow-y-auto">
            <PortRows model={model} rows={rows} forwardingOff={forwardingOff} />
          </div>
          {model.usable && !rows.length && (empty
            ? <p className="px-3.5 py-2 text-xs text-muted-foreground" data-testid="cloud-ports-empty">
                Nothing is listening in the workspace yet.{!forwardingOff && " Start your app there, or enter its port."}
              </p>
            : <PortsEmpty model={model} />)}
          {props.phase2 && model.usable && (adding || empty) && (
            <WorkspacePortInput model={model} expanded={adding} disabled={forwardingOff} close={() => setAdding(false)} />
          )}
        </>
      )}
      <div className="mt-1 border-t border-hairline px-3.5 py-2.5 text-xs leading-4 text-faint">
        {forwardingOff
          ? FORWARDING_OFF
          : <>Forwards listen on 127.0.0.1 only and travel inside {machine ? `your encrypted connection to ${machine.name}` : "the encrypted relay"}. Auto-forwarding skips {SKIPPED_RANGE}.</>}
      </div>
    </div>
  );
}

function WorkspacePortInput({ model, expanded, disabled, close }: { model: PortsModel; expanded: boolean; disabled: boolean; close: () => void }) {
  const [workspacePort, setWorkspacePort] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const workspaceErrorId = useId();
  const localErrorId = useId();
  const workspaceError = Number(workspacePort) === 22 && validPort(workspacePort) ? SSH_PORT_RESERVED
    : (workspacePort || submitted) && !validPort(workspacePort) ? INVALID_PORT : null;
  const localError = expanded && localPort && !validPort(localPort) ? INVALID_PORT : null;
  const busy = model.busy !== null;
  const inputStyle = "w-full min-w-0 rounded-md border border-hairline bg-raised px-2.5 py-1.5 font-mono text-foreground outline-none focus-visible:border-accent placeholder:font-sans placeholder:text-faint disabled:opacity-50";
  return (
    <form
      className="mx-3.5 my-2 grid gap-2 rounded-md border border-hairline p-2.5 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (disabled || busy || !validPort(workspacePort) || workspaceError || localError) return;
        void model.forward(Number(workspacePort), { localPort: expanded && localPort ? Number(localPort) : undefined }).then((done) => {
          if (!done) return;
          setWorkspacePort("");
          setLocalPort("");
          setSubmitted(false);
          close();
        });
      }}
    >
      {expanded && <span className="font-medium text-foreground">Forward a port</span>}
      <label className="grid min-w-0 gap-1">
        {expanded && <span className="text-muted-foreground">Workspace port</span>}
        <input aria-label="Workspace port" aria-invalid={!!workspaceError} aria-describedby={workspaceError ? workspaceErrorId : undefined} className={inputStyle} placeholder="Workspace port" inputMode="numeric" autoFocus={expanded} disabled={disabled} value={workspacePort} onChange={(event) => setWorkspacePort(event.target.value.trim())} />
        {workspaceError && <span id={workspaceErrorId} className="text-destructive" role="alert">{workspaceError}</span>}
      </label>
      {expanded && (
        <label className="grid gap-1">
          <span className="text-muted-foreground">Local port (optional)</span>
          <input aria-invalid={!!localError} aria-describedby={localError ? localErrorId : undefined} className={inputStyle} inputMode="numeric" disabled={disabled} value={localPort} onChange={(event) => setLocalPort(event.target.value.trim())} />
          {localError && <span id={localErrorId} className="text-destructive" role="alert">{localError}</span>}
        </label>
      )}
      <div className="flex justify-end gap-2">
        {expanded && <Button type="button" size="sm" variant="ghost" onClick={close}>Cancel</Button>}
        <Button type="submit" size="sm" variant="outline" disabled={disabled || busy}>Forward</Button>
      </div>
    </form>
  );
}
