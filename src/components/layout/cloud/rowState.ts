import type { CloudWorkspaceListItem } from "@/lib/api";
import { phaseOf, PHASES, settled } from "@/lib/cloudCreate";
import { archiving, deletion, isArchived, isOpen } from "@/lib/cloudLifecycle";

export type RowTone = "ready" | "stopped" | "changing" | "attention" | "archived";

/**
 * A workspace row's short state, from the lifecycle alone (PRO-23 row state
 * table, rows 1 to 5). Tab states (Needs you, Working, Done) come with
 * sessions in CS-7 and CS-8; until then a running workspace reads "Ready",
 * and a stopped one is never shown as working.
 */
export function workspaceRowState(item: CloudWorkspaceListItem): { label: string; tone: RowTone } {
  const { state, launch } = item.workspace;
  const operation = item.latestOperation;
  if (deletion(item) === "running") return { label: "Deleting", tone: "changing" };
  if (archiving(item)) return { label: "Archiving", tone: "changing" };
  if (state === "archived" || state === "destroyed") return { label: "Archived", tone: "archived" };
  const phase = phaseOf(item);
  if (state === "attention-required" || (launch && phase === "failed") || deletion(item) === "failed") return { label: "Needs attention", tone: "attention" };
  if (isOpen(operation) && operation?.action === "suspend") return { label: "Stopping", tone: "changing" };
  if (isOpen(operation) && operation?.action === "resume") return { label: "Resuming", tone: "changing" };
  if (state === "provisioning" || (launch && !settled(phase))) {
    const label = PHASES.find((p) => p.id === phase)?.label ?? phase;
    return { label: `Starting: ${label.replace(/…$/, "").toLowerCase()}`, tone: "changing" };
  }
  if (state === "suspended") return { label: "Stopped", tone: "stopped" };
  if (isArchived(item.workspace)) return { label: "Archived", tone: "archived" };
  return { label: "Ready", tone: "ready" };
}
