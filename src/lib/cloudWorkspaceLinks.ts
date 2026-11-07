import type { CloudWorkspace } from "@/lib/api";
import { copyText } from "@/lib/clipboard";

export interface WorkspaceLink { org: string; number: number }
export interface ResolvedWorkspaceLink { orgId: string; workspaceId: string }

export function workspaceLabel(workspace: Pick<CloudWorkspace, "name" | "number">): string {
  return workspace.number ? `#${workspace.number} · ${workspace.name}` : workspace.name;
}
export function workspaceOwner(workspace: Pick<CloudWorkspace, "ownerName" | "createdBy">): string | null {
  return workspace.ownerName || workspace.createdBy || null;
}
export async function copyWorkspaceLink(workspace: CloudWorkspace): Promise<void> {
  if (!workspace.webUrl) throw new Error("Refresh this workspace to get its link.");
  await copyText(workspace.webUrl);
}
