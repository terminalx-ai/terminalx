import { Package } from "@/icons";
import { cn } from "@/lib/cn";
import { useMachineConnections } from "@/lib/machineConnections";
import { machineFeatureNotice } from "@/lib/machineUpdate";

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
