import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudProject } from "@/types/target";
import { useCloudPlacement } from "./CloudPlacement";

const { identity, preflight } = vi.hoisted(() => ({ identity: vi.fn(), preflight: vi.fn(async () => undefined) }));
vi.mock("@/lib/githubIdentity", async (original) => ({
  ...(await original<typeof import("@/lib/githubIdentity")>()),
  refreshGithubIdentity: identity,
}));
vi.mock("@/lib/dataPrivacy", async (original) => ({
  ...(await original<typeof import("@/lib/dataPrivacy")>()),
  useDataPrivacy: () => ({ ready: true, enabled: false, managed: false }),
}));
vi.mock("@/lib/account", async (original) => ({
  ...(await original<typeof import("@/lib/account")>()),
  useAccount: () => ({
    status: { state: "signed-in", identity: null, expiresAt: null, lastError: null, phase2Readiness: { "org-a": ["cloud.workspaces.session-placement.v1"] } },
  }),
}));
vi.mock("@/lib/cloudNewSession", async (original) => ({
  ...(await original<typeof import("@/lib/cloudNewSession")>()),
  cloudPlacementOffers: async () => [{ id: "box", label: "Box", setup: null, error: null }],
  checkCloudPlacement: preflight,
}));

afterEach(() => { cleanup(); identity.mockReset(); preflight.mockClear(); });

const project: CloudProject = { key: "cloud:org-a:github.com/acme/api", orgId: "org-a", identity: "github.com/acme/api", fullName: "Acme/API", selected: true, pinned: false, blank: false, workspaces: [] };
const section = { orgId: "org-a", orgName: "Acme", mayStart: true, projects: [project], more: [] };

it("shows a local GitHub lookup failure and retries it on Recheck", async () => {
  identity.mockRejectedValueOnce(new Error("Temporary fetch failure"))
    .mockResolvedValueOnce({ remoteHost: "github", repo: "Acme/API" });
  const { result } = renderHook(() => useCloudPlacement({
    sections: [section],
    cloudProject: null, localPath: "/repos/api", agent: "claude",
    selection: null, defaultCreate: false, idleChoice: null,
  }));
  await waitFor(() => expect(result.current.rows[0]?.locked).toBe("Couldn’t check the repository’s GitHub remote."));
  act(() => result.current.recheck());
  await waitFor(() => expect(result.current.rows[0]?.startKey).toBe(project.key));
  expect(identity.mock.calls).toEqual([["/repos/api"], ["/repos/api"]]);
});

it("offers a cloud provider before an agent is selected and checks the cloud form's selected agent", async () => {
  identity.mockResolvedValue({ remoteHost: "github", repo: "Acme/API" });
  type FormTarget = Pick<Parameters<typeof useCloudPlacement>[0], "agent" | "cloudProject">;
  const { result, rerender } = renderHook((target: FormTarget) => useCloudPlacement({
    ...target, sections: [section], localPath: "/repos/api",
    selection: null, defaultCreate: true, idleChoice: null,
  }), { initialProps: { cloudProject: null, agent: null } as FormTarget });
  await waitFor(() => expect(result.current.rows[0]).toMatchObject({ provider: "box", startKey: project.key, locked: null }));
  expect(preflight).not.toHaveBeenCalled();
  rerender({ cloudProject: project, agent: null });
  expect(result.current.rows[0].locked).toBeNull();
  expect(result.current.blocked).toBe("Choose an agent first.");
  expect(preflight).not.toHaveBeenCalled();

  rerender({ cloudProject: project, agent: "codex" });
  expect(result.current.blocked).toBe("Checking cloud readiness…");
  await waitFor(() => expect(preflight).toHaveBeenCalledWith(project, "codex"));
});
