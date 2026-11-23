import { useState } from "react";
import { thisComputer } from "@/lib/platform";
import { ChevronsRight, PlugZap, Plus } from "@/icons";
import { Switch } from "@/components/ui/controls";
import { AUTO_FORWARD_SKIPPED } from "@/lib/api";
import { PortInput, PortRows, PortsEmpty, PortsUnavailable, usePorts, type PortsInputs } from "./CloudPorts";
import { PortSection } from "./PortRow";

/** "32768–60999": the ports automatic forwarding leaves alone. */
export const SKIPPED_RANGE = `${AUTO_FORWARD_SKIPPED.from}–${AUTO_FORWARD_SKIPPED.to}`;

/**
 * "Forward ports to this Mac" (14.10), opened from the header's forward chip:
 * the Forwarding switch, "Forward new ports automatically", every port that
 * listens there with its forward, "+ Forward a port", and how forwards are
 * reached. It reads the list only while open.
 */
export function PortsPopover(props: PortsInputs) {
  const model = usePorts(props);
  const [adding, setAdding] = useState(false);
  const { machine } = model;
  const switches = model.usable || model.awayWithForwards;
  const rows = [...model.forwarded, ...model.notForwarded];
  return (
    <div className="text-[13px]" data-testid="ports-popover">
      <div className="flex h-11 items-center gap-2.5 border-b border-hairline px-3.5">
        <PlugZap className="size-[15px] shrink-0 text-add" aria-hidden />
        <span className="font-medium text-foreground">Forward ports</span>
        <span className="text-xs text-faint">to {thisComputer}</span>
        {switches && (
          <span className="ml-auto flex items-center">
            <Switch aria-label="Forwarding" checked={model.settings.enabled} onCheckedChange={(enabled) => model.setSettings({ enabled })} />
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
              model.usable ? (
                <button type="button" className="flex items-center gap-1 hover:text-foreground" aria-expanded={adding} onClick={() => setAdding((open) => !open)}>
                  <Plus className="size-3" aria-hidden />
                  Forward a port
                </button>
              ) : undefined
            }
          >
            Ports detected
          </PortSection>
          {model.error && (
            <p className="px-3.5 pt-1 text-xs text-destructive" role="alert">
              {model.error}
            </p>
          )}
          {adding && model.usable && <PortInput model={model} autoFocus className="mx-3.5 my-1.5" onDone={() => setAdding(false)} />}
          <div className="max-h-72 overflow-y-auto">
            <PortRows model={model} rows={rows} />
          </div>
          {model.usable && !rows.length && <PortsEmpty model={model} />}
        </>
      )}
      <div className="mt-1 border-t border-hairline px-3.5 py-2.5 text-xs leading-4 text-faint">
        Forwards listen on 127.0.0.1 only and travel inside {machine ? `your encrypted connection to ${machine.name}` : "the encrypted relay"}. Auto-forwarding skips {SKIPPED_RANGE}.
      </div>
    </div>
  );
}
