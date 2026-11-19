import { describe, expect, it, vi } from "vitest";
import { WorkspaceRpcError, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { RemoteGit } from "@terminalx/portable/workspaceGit";

vi.mock("@/lib/api", () => ({ api: {}, gh: {}, git: {}, errorMessage: (error: unknown) => String(error) }));

const { cloudGitSource, runtimeSessionIn } = await import("./gitSource");

it("reports unsupported header totals on an older runtime without falling back to snapshots", async () => {
  const call = vi.fn().mockRejectedValue(new WorkspaceRpcError("method_not_found", "Unknown method", "git.branchDiffSize"));
  const remote = new RemoteGit({ call } as unknown as WorkspaceRpcClient, "topic");
  const source = cloudGitSource({ workspaceKey: "machine:m1:p1", remote, canWrite: true, author: async () => null });

  await expect(source.branchDiffSize?.("release/2.x")).resolves.toBe("unsupported");
  await expect(source.branchDiffSize?.("release/2.x")).resolves.toBe("unsupported");
  expect(call.mock.calls).toEqual([["git.branchDiffSize", { repo: "topic", base: "release/2.x" }]]);
});

it("sends the selected branch and the machine session together when creating a PR", async () => {
  const mutate = vi.fn().mockResolvedValue({ sessionAssociated: true });
  const remote = new RemoteGit({ mutate } as unknown as WorkspaceRpcClient, "topic");
  const source = cloudGitSource({ workspaceKey: "machine:m1:p1", remote, canWrite: true, author: async () => null });
  const request = { title: "Topic", body: "", base: "release/2.x", draft: false, branch: "topic" };

  await expect(source.createPr({ ...request, sessionId: "machine:m1:p2:s1" })).rejects.toThrow("different workspace");
  expect(mutate).not.toHaveBeenCalled();
  await expect(source.createPr({ ...request, sessionId: "machine:m1:p1:s1" })).resolves.toBeNull();
  expect(mutate).toHaveBeenCalledWith("git.prCreate", { ...request, sessionId: "s1", repo: "topic" });
});

it("refuses to fall back to an unguarded commit on an older machine", async () => {
  const call = vi.fn().mockResolvedValue({ branch: "topic", head: "abc" });
  const mutate = vi.fn().mockRejectedValue(new WorkspaceRpcError("method_not_found", "Unknown method", "git.commitForPush"));
  const remote = new RemoteGit({ call, mutate } as unknown as WorkspaceRpcClient, "topic");
  const author = { name: "Ada", email: "ada@example.com" };
  const source = cloudGitSource({ workspaceKey: "machine:m1:p1", remote, canWrite: true, author: async () => author });
  await expect(source.commitForPush?.("Record work", "topic", "abc")).rejects.toThrow("Update the machine runtime");
  expect(mutate.mock.calls).toEqual([["git.commitForPush", {
    repo: "topic", message: "Record work", author, expectedBranch: "topic", expectedHead: "abc",
  }]]);
});

describe("the runtime session a session key names in a workspace", () => {
  it("reads a machine session in its own project (PRO-347)", () => {
    expect(runtimeSessionIn("machine:m1:p1", "machine:m1:p1:s1")).toBe("s1");
  });

  it.each([
    ["another project", "machine:m1:p2:s1"],
    ["another machine", "machine:m2:p1:s1"],
    ["the project itself", "machine:m1:p1"],
    ["a cloud session", "cloud:o:w:s1"],
    ["a local session", "5d3f0a8e-4b1c-4f7e-9a2d-1c6b8e0f2a91"],
  ])("never a session of %s", (_name, key) => {
    expect(runtimeSessionIn("machine:m1:p1", key)).toBeNull();
  });

  it("reads a cloud session in its workspace, as before", () => {
    expect(runtimeSessionIn("cloud:o:w", "cloud:o:w:s1")).toBe("s1");
    expect(runtimeSessionIn("cloud:o:w", "cloud:o:w2:s1")).toBeNull();
    expect(runtimeSessionIn("cloud:o:w", "machine:m1:p1:s1")).toBeNull();
  });
});
