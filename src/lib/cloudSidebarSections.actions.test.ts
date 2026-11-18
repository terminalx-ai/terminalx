import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "./api";
import type { CloudProject, CloudWorkspaceNode } from "@/types/target";
const mock = vi.hoisted(() => ({ status: { state: "signed-in", identity: { email: "same@example.com" }, context: { account: "account-a" } } as AccountStatus, privacy: false }));
vi.mock("./account", () => ({ getAccount: () => ({ status: mock.status }), useAccount: () => ({ status: mock.status }) }));
vi.mock("./dataPrivacy", () => ({ privacyEnabled: () => mock.privacy }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
import { getPrefs, setPrefs } from "./prefs";
import { createCloudSection, createCloudSectionForWorkspace, deleteCloudSection, discardCloudSectionDrafts, moveCloudSection, moveProjectToSection, moveWorkspaceToSection, migrateCloudSectionOwner, MY_WORKSPACES, renameCloudSection, sectionOfProject, sectionWorkspaceIds, SHARED_WORKSPACES, sortSectionWorkspaces, updateCloudSection, workspaceBuiltIn } from "./cloudSidebarSections";
const node = (id: string, fields = {}): CloudWorkspaceNode => ({ key: `cloud:org:${id}`, placedBy: "server", item: { latestOperation: null, workspace: { id, name: id, orgId: "org", provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 10, releaseDisposition: null, createdBy: "viewer", you: { role: "manager", canApprove: true }, ...fields } } });
const projects = [{ key: "cloud:org:repo", orgId: "org", identity: "repo", fullName: "repo", selected: true, pinned: false, blank: false, workspaces: [node("one"), node("two")] }] satisfies CloudProject[];
const mine = () => getPrefs().cloudSections["account-a"]?.org ?? [];
beforeEach(() => { discardCloudSectionDrafts(); mock.status.state = "signed-in"; mock.status.context = { account: "account-a", scope: "a", revision: "a:1" }; mock.privacy = false; setPrefs({ cloudSections: {} }); });
describe("workspace section ownership and sorting", () => {
  it("uses real ownership; a management role is not ownership and missing facts are unclassified", () => {
    expect(workspaceBuiltIn(node("a"), "viewer")).toBe(MY_WORKSPACES);
    expect(workspaceBuiltIn(node("a", { createdBy: "other" }), "viewer")).toBe(SHARED_WORKSPACES);
    expect(workspaceBuiltIn(node("a", { createdBy: null }), "viewer")).toBeNull();
    expect(workspaceBuiltIn(node("a"), undefined)).toBeNull();
    expect(workspaceBuiltIn(node("a", { you: { role: "none" } }), "viewer")).toBeNull();
  });
  it("sorts each section by real activity, creation or name with deterministic ties", () => {
    const rows = [node("Z", { lastActivityAt: 30, createdAt: 3 }), node("A", { lastActivityAt: 20, createdAt: 8 }), node("B", { lastActivityAt: 40, createdAt: 1 })];
    const ids = (sort: "active" | "created" | "name") => sortSectionWorkspaces(rows, sort).map((row) => row.item.workspace.id);
    expect(ids("active")).toEqual(["B", "Z", "A"]); expect(ids("created")).toEqual(["A", "Z", "B"]); expect(ids("name")).toEqual(["A", "B", "Z"]);
    expect(rows.map((row) => row.item.workspace.id)).toEqual(["Z", "A", "B"]);
  });
});
describe("personal workspace layout", () => {
  it("keeps icon, sort and collapse on only the chosen section and protects built-ins", () => {
    const a = createCloudSection("org"), b = createCloudSection("org");
    renameCloudSection("org", a, "A"); renameCloudSection("org", b, "B");
    updateCloudSection("org", a, { icon: "🚀", sort: "name", collapsed: true });
    expect(mine().find((s) => s.id === a)).toMatchObject({ icon: "🚀", sort: "name", collapsed: true });
    expect(mine().find((s) => s.id === b)).not.toHaveProperty("sort");
    updateCloudSection("org", MY_WORKSPACES, { sort: "created" });
    renameCloudSection("org", MY_WORKSPACES, "Changed"); deleteCloudSection("org", MY_WORKSPACES);
    expect(mine().find((s) => s.id === MY_WORKSPACES)).toMatchObject({ name: "My workspaces", sort: "created" });
  });
  it("moves one workspace from a legacy project section; deleting a section never changes its workspaces", () => {
    setPrefs({ cloudSections: { "account-a": { org: [{ id: "old", name: "Legacy", projects: ["repo"] }, { id: "new", name: "New", projects: [] }] } } });
    expect(sectionWorkspaceIds(mine()[0], projects)).toEqual(["one", "two"]);
    const original = structuredClone(projects);
    moveWorkspaceToSection("org", "one", "new", projects);
    expect(mine().map((s) => s.workspaces)).toEqual([["two"], ["one"]]);
    moveWorkspaceToSection("org", "one", null, projects);
    expect(sectionOfProject(mine(), "repo", ["one"])).toBeNull();
    expect(sectionOfProject(mine(), "repo", ["two"])?.id).toBe("old");
    moveProjectToSection("org", "repo", "new", ["one"]);
    moveWorkspaceToSection("org", "foreign", "new", projects);
    expect(mine()[1].workspaces).toEqual(["one"]);
    deleteCloudSection("org", "new"); expect(projects).toEqual(original); expect(mine()).toHaveLength(1);
  });
  it("legacy project menu moves remain effective after explicit workspace membership exists", () => {
    setPrefs({ cloudSections: { "account-a": { org: [{ id: "source", name: "Source", projects: [], workspaces: ["one", "two"] }, { id: "target", name: "Target", projects: [], workspaces: [] }] } } });
    moveProjectToSection("org", "repo", "target", ["one", "two"]);
    expect(mine().map((s) => s.workspaces)).toEqual([[], ["one", "two"]]);
    moveProjectToSection("org", "repo", null, ["one", "two"]);
    expect(mine().map((s) => s.workspaces)).toEqual([[], []]);
  });
  it("does not persist creation or move its workspace before Enter, and cancellation preserves placement", () => {
    setPrefs({ cloudSections: { "account-a": { org: [{ id: "source", name: "Source", projects: [], workspaces: ["one", "two"] }] } } });
    const before = structuredClone(getPrefs().cloudSections);
    const canceled = createCloudSectionForWorkspace("org", "one", projects);
    expect(getPrefs().cloudSections).toEqual(before);
    deleteCloudSection("org", canceled); expect(getPrefs().cloudSections).toEqual(before);
    const committed = createCloudSectionForWorkspace("org", "one", projects);
    renameCloudSection("org", committed, "Release");
    expect(mine().map((s) => s.workspaces)).toEqual([["two"], ["one"]]);
  });
  it("claims legacy email layouts once with their collapse state, then isolates the same email's other profile", () => {
    setPrefs({ cloudSections: { "same@example.com": { org: [{ id: "legacy", name: "Existing", projects: ["repo"] }] } }, sidebarSections: { "cloud-section:legacy": "collapsed" } });
    migrateCloudSectionOwner();
    expect(mine()[0]).toMatchObject({ name: "Existing", collapsed: true });
    expect(getPrefs().cloudSections["same@example.com"]).toBeUndefined();
    mock.status.context!.account = "account-b"; migrateCloudSectionOwner();
    expect(getPrefs().cloudSections["account-b"]).toBeUndefined();
  });
  it("reorders personal sections across built-in preference records", () => {
    setPrefs({ cloudSections: { "account-a": { org: [{ id: "a", name: "A", projects: [] }, { id: MY_WORKSPACES, name: "My workspaces", projects: [], collapsed: true }, { id: "b", name: "B", projects: [] }] } } });
    moveCloudSection("org", "a", 1);
    expect(mine().filter((s) => !s.id.startsWith("builtin:")).map((s) => s.id)).toEqual(["b", "a"]);
    expect(mine().find((s) => s.id === MY_WORKSPACES)?.collapsed).toBe(true);
  });
  it("fences the same email's profiles, organizations, sign-out and privacy", () => {
    const id = createCloudSection("org"); renameCloudSection("org", id, "Private");
    const other = createCloudSection("other-org"); renameCloudSection("other-org", other, "Other"); expect(mine()).toHaveLength(1);
    mock.status.context = { account: "account-b", scope: "b", revision: "b:1" };
    renameCloudSection("org", id, "Leaked"); expect(mine()[0].name).toBe("Private");
    mock.status.state = "signed-out"; createCloudSection("org"); expect(getPrefs().cloudSections["account-b"]).toBeUndefined();
    mock.status.state = "signed-in"; mock.status.context.account = "account-a"; mock.privacy = true;
    deleteCloudSection("org", id); expect(mine()[0].name).toBe("Private");
  });
});
