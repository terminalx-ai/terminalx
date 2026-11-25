import { beforeEach, expect, it, vi } from "vitest";
import { importCloudWorkspace } from "./cloudWorkspaceTransfer";

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
