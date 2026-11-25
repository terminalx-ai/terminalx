import { api } from "@/lib/api";
import { cloudOrgArg } from "@/lib/cloudCatalog";

interface WorkspaceIdentity {
  id: string;
  orgId: string;
}

interface LocalImport {
  sessionId: string;
  worktreePath: string;
}

type ArchiveDecision =
  | { status: "archived" }
  | { status: "queued"; operationId: string }
  | { status: "failed" }
  | { status: "unconfirmed" };

/** Prepare an archive action only after the local import succeeds. The host
 * calls it from the user's explicit archive choice. */
export async function importCloudWorkspace(
  workspace: WorkspaceIdentity,
  importLocally: () => Promise<LocalImport>,
  currentAccountCanArchive: () => boolean,
) {
  const { id, orgId } = workspace;
  const local = await importLocally();
  let pending: Promise<ArchiveDecision> | undefined;

  async function archiveCloudCopy(): Promise<ArchiveDecision> {
    if (!currentAccountCanArchive()) return { status: "failed" };
    try {
      const result = await api.cloudWorkspaceArchive(id, false, cloudOrgArg(orgId));
      if (result.workspace.id !== id || result.workspace.orgId !== orgId) return { status: "unconfirmed" };
      const { operation } = result;
      if (operation?.action !== "archive" || operation.workspaceId !== id) return { status: "unconfirmed" };
      if (operation.state === "succeeded") return { status: "archived" };
      if (operation.state === "failed" || operation.state === "canceled") return { status: "failed" };
      return { status: "queued", operationId: operation.id };
    } catch {
      // A transport failure can also happen after the server accepted the
      // request. The local import is independent of the archive outcome.
      return { status: "unconfirmed" };
    }
  }

  return {
    local,
    archiveCloudCopy() {
      return pending ??= archiveCloudCopy();
    },
  };
}
