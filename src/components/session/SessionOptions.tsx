import { useState } from "react";
import { Popover } from "radix-ui";
import { Ellipsis } from "@/icons";
import { Switch } from "@/components/ui/controls";
import type { usePipelineLaunch } from "@/lib/pipelineLaunch";
import { cn } from "@/lib/cn";
import { PipelineLaunchControls } from "./PipelineLaunchControls";

/**
 * The new session's less-used choices behind `…`: whether it gets a branch of
 * its own, and what TerminalX does with its pull request. A dot on the button
 * says an automation is on, so nothing that acts later is hidden unseen.
 */
export function SessionOptions({
  useWorktree,
  onUseWorktreeChange,
  worktreeLabel,
  switchLabel = "Start on a new branch in a worktree",
  currentBranch,
  pipeline,
}: {
  useWorktree?: boolean;
  onUseWorktreeChange?: (value: boolean) => void;
  worktreeLabel?: string;
  switchLabel?: string;
  currentBranch?: string;
  pipeline: ReturnType<typeof usePipelineLaunch>;
}) {
  const [open, setOpen] = useState(false);
  const automated = pipeline.value.resolveConflicts || pipeline.value.autoMerge;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Session options"
          title="Branch and automation"
          className={cn("relative flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-veil-raised hover:text-foreground", open && "bg-veil-raised text-foreground")}
        >
          <Ellipsis className="size-4" />
          {automated && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" aria-label="Automation on" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-(--z-menu) flex w-[24rem] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl bg-popover glass p-2 text-popover-foreground shadow-surface hairline animate-fade-in"
        >
          {onUseWorktreeChange && (
            <label className="flex items-start justify-between gap-3 rounded-lg px-2 py-1.5 text-xs">
              <span className="flex flex-col gap-0.5">
                <span className="text-foreground">{worktreeLabel}</span>
                <span className="text-faint">{useWorktree ? "A branch and folder of its own, named after the task, so sessions never collide." : `Works directly on ${currentBranch}.`}</span>
              </span>
              <Switch size="sm" aria-label={switchLabel} checked={!!useWorktree} onCheckedChange={onUseWorktreeChange} />
            </label>
          )}

          <PipelineLaunchControls launch={pipeline} disabled={false} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
