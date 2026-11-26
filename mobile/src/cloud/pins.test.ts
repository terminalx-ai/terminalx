import { describe, expect, it } from "vitest";
import type { CloudWorkspaceItem } from "./api";
import type { CatalogOrganization } from "./catalog";
import { pinnedCloudRows, workspaceProject } from "./pins";

type Repositories = CloudWorkspaceItem["workspace"]["repositories"];
const workspace = (id: string, orgId: string, repositories: Repositories, lastActivityAt?: number): CloudWorkspaceItem => ({
  workspace: { id, orgId, name: ` ${id.toUpperCase()} `, provider: "box", state: "running", repositories, lastActivityAt },
  latestOperation: null,
});
const org = (orgId: string, workspaces: CloudWorkspaceItem[]): CatalogOrganization => ({
  organization: { orgId, name: orgId, role: "member" }, workspaces, error: null, loaded: true,
});
const web = [{ identity: "https://GitHub.com/Acme/Web.git", fullName: "acme/web", primary: true }];

describe("a cloud workspace's project, as the computer names it (#1403)", () => {
  it("is its primary repository's identity, else a blank project by its name", () => {
    expect(workspaceProject(workspace("w1", "org-1", web).workspace)).toBe("github.com/acme/web");
    const second = [{ identity: "github.com/acme/api", primary: false }, { identity: null, cloneUrl: "git@github.com:acme/site.git", primary: true }];
    expect(workspaceProject(workspace("w2", "org-1", second).workspace)).toBe("github.com/acme/site");
    expect(workspaceProject(workspace("notes", "org-1", []).workspace)).toBe("blank/notes");
    expect(workspaceProject(workspace("notes", "org-1", undefined).workspace)).toBe("blank/notes");
  });
});

describe("the pinned cloud rows (#1403)", () => {
  it("lists the workspaces of the projects the computer pinned, in organizations this phone can read", () => {
    const snapshot = {
      organizations: [
        org("org-1", [workspace("w1", "org-1", web, 20), workspace("w2", "org-1", [{ identity: "github.com/acme/api", primary: true }]), workspace("notes", "org-1", [], 10)]),
        org("org-2", [workspace("w3", "org-2", web)]),
      ],
      titles: { "org-1/w1": "Fix the login" },
    };
    const rows = pinnedCloudRows(snapshot, { "org-1": ["github.com/acme/web", "blank/notes"], "org-9": ["github.com/acme/web"] });
    expect(rows.map(({ key, identity, title, time }) => ({ key, identity, title, time }))).toEqual([
      { key: "cloud:org-1:w1", identity: "github.com/acme/web", title: "Fix the login", time: 20 },
      { key: "cloud:org-1:notes", identity: "blank/notes", title: " NOTES ", time: 10 },
    ]);
    expect(pinnedCloudRows(snapshot, {})).toEqual([]);
  });
});
