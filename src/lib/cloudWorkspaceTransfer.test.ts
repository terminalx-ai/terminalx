import { beforeEach, expect, it, vi } from "vitest";
import { importCloudWorkspace, readCloudTransfer } from "./cloudWorkspaceTransfer";

const { archive } = vi.hoisted(() => ({ archive: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { cloudWorkspaceArchive: archive } }));
vi.mock("@/lib/cloudCatalog", () => ({ cloudOrgArg: (orgId: string) => orgId }));

const workspace = { id: "workspace", orgId: "org" };
const local = { sessionId: "local", worktreePath: "/project/worktree" };

beforeEach(() => archive.mockReset());

it("leaves the cloud workspace untouched when local import fails", async () => {
  await expect(importCloudWorkspace(workspace, async () => { throw Error("import failed"); }, () => true)).rejects.toThrow("import failed");
  expect(archive).not.toHaveBeenCalled();
});

it("waits for a separate archive choice and returns the operation to track", async () => {
  const transfer = await importCloudWorkspace(workspace, async () => local, () => true);
  expect(transfer.local).toEqual(local);
  expect(archive).not.toHaveBeenCalled();
  archive.mockResolvedValue({ workspace, operation: { id: "op", workspaceId: workspace.id, action: "archive", state: "queued" } });
  const [first, second] = await Promise.all([transfer.archiveCloudCopy(), transfer.archiveCloudCopy()]);
  expect(first).toEqual({ status: "queued", operationId: "op" });
  expect(second).toEqual(first);
  expect(archive.mock.calls).toEqual([[workspace.id, false, workspace.orgId]]);
});

it("preserves the local import after account revocation or archive failure", async () => {
  const revoked = await importCloudWorkspace(workspace, async () => local, () => false);
  expect(await revoked.archiveCloudCopy()).toEqual({ status: "failed" });
  expect(archive).not.toHaveBeenCalled();

  const failed = await importCloudWorkspace(workspace, async () => local, () => true);
  archive.mockResolvedValue({ workspace, operation: { id: "op", workspaceId: workspace.id, action: "archive", state: "failed" } });
  expect(await failed.archiveCloudCopy()).toEqual({ status: "failed" });
  expect(failed.local).toEqual(local);
});

it("reads bounded export parts on the current attachment and closes the export", async () => {
  const manifest = {
    transferId: "export", branch: "topic", commit: "a".repeat(40),
    bundleBytes: 3, transcriptBytes: 2, harness: "claude", title: "Conversation",
  };
  const calls: Record<string, unknown>[] = [];
  const scope = { sessionId: "cloud-session", tabId: "cloud-tab" };
  const client = {
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, ...params });
      if (method === "transfer.open") return manifest as T;
      if (method === "transfer.close") return {} as T;
      const data = params.part === "transcript" ? btoa("[]") : btoa("git");
      return { offset: params.offset, data } as T;
    },
  };
  await expect(readCloudTransfer(client, scope, () => true)).resolves.toEqual({
    branch: "topic", commit: "a".repeat(40), harness: "claude", title: "Conversation",
    transcript: btoa("[]"), bundle: btoa("git"),
  });
  expect(calls).toEqual([
    { method: "transfer.open", ...scope, requestId: expect.any(String) },
    { method: "transfer.read", ...scope, transferId: "export", part: "transcript", offset: 0 },
    { method: "transfer.read", ...scope, transferId: "export", part: "bundle", offset: 0 },
    { method: "transfer.close", ...scope, transferId: "export" },
  ]);
});

it("drops bytes returned after the account fence changes", async () => {
  let current = true;
  const scope = { sessionId: "cloud-session", tabId: "cloud-tab" };
  const client = {
    async call<T>(method: string): Promise<T> {
      if (method === "transfer.open") return { transferId: "export", transcriptBytes: 2 } as T;
      expect(method).toBe("transfer.read");
      current = false;
      return { offset: 0, data: btoa("[]") } as T;
    },
  };
  await expect(readCloudTransfer(client, scope, () => current)).rejects.toThrow("account or workspace connection changed");
});
