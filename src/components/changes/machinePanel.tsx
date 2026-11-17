import { createContext, useContext } from "react";
import { openWorkspaceDelete } from "@/lib/dialogs";
import { machineHostId } from "@/lib/mergedCleanup";
import type { RemovableWorkspace } from "@/lib/workspaceRemoval";

/**
 * What the side panel of a session on a paired machine knows of the machine
 * (PRO-404, PRO-406): which machine it is, the session's worktree there, and
 * whether a merge is pinned to the head shown (`machine/9`). The session view
 * provides it around its panel; the PR panel reads it, so a merged pull
 * request offers to remove the worktree on the machine and nothing of this
 * computer is read or removed for it.
 */
export interface MachinePanel {
  machineId: string;
  name: string;
  /** The session's worktree on the machine, removed there (`workspace/1`); absent for one in the project's own folder, or without manage. */
  workspace?: RemovableWorkspace;
  /** The machine refuses a merge once the head moved (`machine/9`). */
  headPinned: boolean;
}

export const MachinePanelContext = createContext<MachinePanel | null>(null);

export function useMachinePanel(): MachinePanel | null {
  return useContext(MachinePanelContext);
}

/** The merged-cleanup host the machine's worktree is read under: never this computer's. */
export function machinePanelHost(panel: MachinePanel): string {
  return machineHostId(panel.machineId);
}

/** The removal dialog for the session's worktree, asking the machine only (its `host`). */
export function removeMachineWorkspace(workspace: RemovableWorkspace): void {
  openWorkspaceDelete(workspace.projectPath, workspace.path, workspace.name, workspace.host);
}
