import { describe, expect, it, vi } from "vitest";

// #433: a cloud project's issues are its repository's. The issue calls take a
// cloud project's key where they take a project's path; no other call does,
// and no other cloud key gets through.

const { tauriInvoke } = vi.hoisted(() => ({ tauriInvoke: vi.fn(async (_command: string, _args?: unknown) => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

const { api, issues, isCloudRepositoryKey, workStatus } = await import("./api");
const { issueOps } = await import("./issueOps");
const { LocalPathLeakError } = await import("@/types/target");

const PROJECT = "cloud:org-a:github.com/acme/api";

describe("issue calls for a cloud project", () => {
  it("take the project's key, and nothing else from the cloud", async () => {
    await issues.list(PROJECT, "github", { assignedToMe: false, teamId: null, search: "" });
    await issues.githubRepo(PROJECT);
    await issueOps.details(PROJECT, "github", "433");
    // Who works on its issues (#441), as the Issues list reads it for any project.
    await workStatus.claims(PROJECT, "github", ["https://github.com/acme/api/issues/433"]);
    expect(tauriInvoke.mock.calls.map(([command]) => command)).toEqual(["issues_list", "github_repo", "issue_details", "work_claims_list"]);

    // A workspace or session key, a path on a VM, or a blank project is not a repository.
    for (const key of ["cloud:org-a:ws-1", "cloud:org-a:ws-1:s-1", "cloud://org-a:ws-1/src", "cloud:org-a:blank/scratch", "cloud:org-a:github.com/acme/api/extra"]) {
      expect(isCloudRepositoryKey(key), key).toBe(false);
      await expect(issueOps.details(key, "github", "433")).rejects.toBeInstanceOf(LocalPathLeakError);
    }
    // Only the issue calls: a local command still refuses even a project key.
    await expect(api.workStatus(PROJECT)).rejects.toBeInstanceOf(LocalPathLeakError);
    expect(tauriInvoke).toHaveBeenCalledTimes(4);
  });
});
