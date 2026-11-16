import { Package } from "@/icons";
import { cn } from "@/lib/cn";
import { machineFeaturesMessage } from "@/lib/machineFeatures";
import { useMachineConnections } from "@/lib/machineConnections";
import { machineFeatureNotice, type MachineVersionView } from "@/lib/machineUpdate";
import { UpdateButton, useUpdateAction } from "./MachineUpdate";

/**
 * Where a machine's feature would be and its namespace was not granted: one
 * line naming the machine and saying to update it (21.09, "ci-box runs
 * TerminalX 0.2.27. Update it to forward ports from here."). Nothing when
 * the feature is there or the view is not a machine's.
 */
export function MachineFeatureNotice({ workspaceKey, capability, granted, className }: { workspaceKey: string; capability: string; granted: readonly string[] | null; className?: string }) {
  // Re-read when the machine's record (its name, its version) changes.
  useMachineConnections();
  const message = machineFeatureNotice(workspaceKey, capability, granted);
  if (!message) return null;
  return (
    <div className={cn("flex items-center gap-2.5 rounded-lg border border-warning/40 px-3.5 py-2.5 text-[13px]", className)} data-testid="machine-feature-notice" data-capability={capability}>
      <Package className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

/**
 * Under a machine's "Runs on" strip: one line for everything the machine
 * hides from this Mac, naming it and saying to update it, with Update
 * beside it (PRO-354). A hidden control (adding agent tabs, interrupting,
 * issue pipelines, clean-up) is never gone without a word. Nothing when the
 * machine hides nothing, or when this Mac is the older side.
 */
export function MachineHiddenFeatures({ machineId, view }: { machineId: string; view: MachineVersionView }) {
  const action = useUpdateAction(machineId, view);
  const name = view.machine?.name ?? "This machine";
  const message = view.gap && view.gap.side === "machine" ? machineFeaturesMessage(name, view.gap.version ?? view.version, view.gap.hidden) : null;
  if (!message) return null;
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-2.5 border-b border-hairline px-3 py-1.5 text-[12.5px]" data-testid="machine-hidden-features-line">
      <Package className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1 text-muted-foreground">{message}</span>
      <UpdateButton action={action} variant="outline" />
    </div>
  );
}
