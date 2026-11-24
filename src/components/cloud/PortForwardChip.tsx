import { useEffect, useRef, useState } from "react";
import { isMac, thisComputer } from "@/lib/platform";
import { Popover } from "radix-ui";
import { PlugZap } from "@/icons";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { hasEscapeOverlay, useHotkey } from "@/lib/hotkeys";
import { openForwardCount, portForwardsOf, setPortSettings, usePortForwards } from "@/lib/portForwards";
import { isMachineKey } from "@/types/target";
import { PortsPopover } from "./PortsPopover";
import { observe, type PortsInputs } from "./CloudPorts";

/**
 * The header's forward chip (14.10, 21.08): a plug and how many ports are
 * forwarded to this Mac now, opening "Forward ports to this Mac". The count
 * follows the desktop's `cloud_port_forwards_changed`, so it is right while
 * the popover and the Ports tab are closed and nothing polls.
 *
 * With nothing forwarded it is left out of a narrow header (SessionView, "gives
 * way in order", step 7): there it costs the title its first 12 characters, and
 * the Ports tab beside it forwards a port just the same. It is back with the
 * first forward.
 */
export function PortForwardChip({ follow, ...inputs }: Omit<PortsInputs, "active"> & { follow: boolean }) {
  const [open, setOpen] = useState(false);
  const [phase2Available, setPhase2Available] = useState(false);
  const [forwardingError, setForwardingError] = useState(false);
  const toggling = useRef(false);
  const popover = useRef<HTMLDivElement>(null);
  const { forwards, loaded } = usePortForwards(inputs.connectionId, follow);
  // The views remember what was open to say what has expired; this is drawn while they are not.
  const { workspaceKey, connectionId } = inputs;
  const cloud = !isMachineKey(workspaceKey);
  useEffect(() => {
    if (!cloud) return;
    let current = true;
    void Promise.resolve().then(() => api.phase2DesktopContractsAvailable()).then((available) => {
      if (current) setPhase2Available(available === true);
    }).catch(() => {});
    return () => { current = false; };
  }, [cloud]);
  const phase2 = cloud && phase2Available;
  const canToggle = phase2 && isMac && inputs.mayOpen && follow && inputs.state.state === "connected"
    && inputs.state.capabilities.includes("ports/1") && !!connectionId && loaded;
  const setForwarding = (enabled: boolean) => {
    if (!connectionId || toggling.current) return;
    toggling.current = true;
    setForwardingError(false);
    void setPortSettings(connectionId, { enabled })
      .catch(() => {
        setForwardingError(true);
        setOpen(true);
      })
      .finally(() => { toggling.current = false; });
  };
  useHotkey("mod+y", (event) => {
    if (hasEscapeOverlay(popover.current)) return false;
    if (!event.repeat) setForwarding(!portForwardsOf(connectionId).settings.enabled);
  }, { enabled: canToggle });
  useEffect(() => {
    if (follow && loaded) observe(workspaceKey, forwards);
  }, [follow, loaded, forwards, workspaceKey]);
  const count = openForwardCount(forwards);
  const label = count ? `${count} port${count === 1 ? "" : "s"} forwarded to ${thisComputer}` : `Forward ports to ${thisComputer}`;
  return (
    <Popover.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) setForwardingError(false);
    }}>
      <span className={cn("flex items-center px-1", count === 0 && !open && "@max-[480px]/session-header:hidden")}>
        <WithTooltip label={label}>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={label}
              className={cn(
                "flex h-7! items-center gap-1.5 rounded-md! px-2 text-[12.5px] tabular-nums text-muted-foreground hover:bg-veil-raised hover:text-foreground",
                (open || count > 0) && "bg-selected text-foreground",
              )}
              data-testid="port-forward-chip"
            >
              <PlugZap className="size-[13px]! text-add" aria-hidden />
              {count > 0 && <span data-testid="port-forward-count">{count}</span>}
            </button>
          </Popover.Trigger>
        </WithTooltip>
      </span>
      <Popover.Portal>
        <Popover.Content
          ref={popover}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label={`Forward ports to ${thisComputer}`}
          className="z-(--z-menu) w-[430px] max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-auto rounded-xl bg-popover text-popover-foreground shadow-surface hairline outline-none animate-fade-in"
        >
          <PortsPopover {...inputs} active={open} phase2={phase2} shortcut={canToggle} forwardingError={forwardingError}
            onSetForwarding={phase2 ? setForwarding : undefined} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
