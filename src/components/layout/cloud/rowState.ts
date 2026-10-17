import type { CloudWorkspaceListItem } from "@/lib/api";
import { deriveCloudActivity, type RowTone } from "@/lib/cloudRowState";

export type { RowTone };

/**
 * A workspace's short state from the lifecycle alone (rows 1 to 5 of the
 * row-state table in `cloudRowState.ts`, which decides every cloud row).
 * `agentRan`: the workspace has a session, so a failed first task is history.
 */
export function workspaceRowState(item: CloudWorkspaceListItem, agentRan = false): { label: string; tone: RowTone } {
  const { label, tone } = deriveCloudActivity(item, { agentRan });
  return { label, tone };
}
