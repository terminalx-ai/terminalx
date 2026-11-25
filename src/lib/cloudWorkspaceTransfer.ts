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

const CHUNK_BYTES = 128 * 1024;

export interface TransferManifest {
  transferId: string;
  branch: string;
  commit: string;
  bundleBytes: number | null;
  transcriptBytes: number;
  title: string;
  harness: string;
}

interface TransferRpc {
  call<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

export async function readCloudTransfer(
  client: TransferRpc,
  scope: { sessionId: string; tabId: string },
  current: () => boolean,
) {
  function checkScope() {
    if (!current()) throw Error("The cloud account or workspace connection changed.");
  }
  checkScope();
  const manifest = await client.call<TransferManifest>("transfer.open", { ...scope, requestId: crypto.randomUUID() });
  const request = { ...scope, transferId: manifest.transferId };
  async function read(part: "bundle" | "transcript", size: number, maximum: number) {
    if (!Number.isSafeInteger(size) || size <= 0 || size > maximum) throw Error("The export reported an invalid size.");
    let binary = "";
    while (binary.length < size) {
      checkScope();
      const chunk = await client.call<{ offset: number; data: string }>("transfer.read", { ...request, part, offset: binary.length });
      checkScope();
      if (chunk.offset !== binary.length || typeof chunk.data !== "string" || chunk.data.length > Math.ceil(CHUNK_BYTES / 3) * 4) {
        throw Error("The export returned an invalid chunk.");
      }
      const decoded = atob(chunk.data);
      if (decoded.length === 0 || decoded.length > CHUNK_BYTES || binary.length + decoded.length > size) throw Error("The export returned an invalid chunk.");
      binary += decoded;
    }
    return btoa(binary);
  }
  try {
    const transcript = await read("transcript", manifest.transcriptBytes, 4 * 1024 * 1024);
    const bundle = manifest.bundleBytes === null ? null : await read("bundle", manifest.bundleBytes, 64 * 1024 * 1024);
    checkScope();
    return { branch: manifest.branch, commit: manifest.commit, harness: manifest.harness, title: manifest.title, transcript, bundle };
  } finally {
    if (current()) void client.call("transfer.close", request).catch(() => undefined);
  }
}
