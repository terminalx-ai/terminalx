import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { PlugZap } from "@/icons";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { openForwardCount, usePortForwards } from "@/lib/portForwards";
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
  const { forwards, loaded } = usePortForwards(inputs.connectionId, follow);
  // The views remember what was open to say what has expired; this is drawn while they are not.
  const { workspaceKey } = inputs;
  useEffect(() => {
    if (follow && loaded) observe(workspaceKey, forwards);
  }, [follow, loaded, forwards, workspaceKey]);
  const count = openForwardCount(forwards);
  const label = count ? `${count} port${count === 1 ? "" : "s"} forwarded to this Mac` : "Forward ports to this Mac";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
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
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Forward ports to this Mac"
          className="z-(--z-menu) w-[430px] max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-auto rounded-xl bg-popover text-popover-foreground shadow-surface hairline outline-none animate-fade-in"
        >
          <PortsPopover {...inputs} active={open} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
