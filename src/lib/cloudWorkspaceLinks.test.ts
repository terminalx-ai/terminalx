import { describe, it, expect, vi } from "vitest";
import type { CloudWorkspace } from "@/lib/api";
import { copyWorkspaceLink, workspaceLabel, workspaceOwner } from "./cloudWorkspaceLinks";
import { buildCloudPaletteProjects } from "./commandPalette";
const copy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText: copy }));
const workspace: CloudWorkspace = { id: "ws", orgId: "org", name: "feature/team", number: 12, ownerName: "Team Owner", webUrl: "https://console.terminalx.ai/o/team/w/12", provider: "hetzner", state: "suspended", accessMode: "organization", createdAt: 1, updatedAt: 1, releaseDisposition: null };
describe("cloud workspace links", () => {
  it("copies the server's canonical browser link without changing sharing or starting compute", async () => {
    await copyWorkspaceLink(workspace);
    expect(copy).toHaveBeenCalledWith("https://console.terminalx.ai/o/team/w/12");
    await expect(copyWorkspaceLink({ ...workspace, webUrl: undefined })).rejects.toThrow("Refresh");
    expect(copy).toHaveBeenCalledTimes(1);
  });
  it("uses numbers and owner names while remaining compatible with older servers", () => {
    expect(workspaceLabel(workspace)).toBe("#12 · feature/team");
    expect(workspaceOwner(workspace)).toBe("Team Owner");
    expect(workspaceLabel({ name: "Old server" })).toBe("Old server");
  });
  it("indexes a workspace by number and owner and selects its precise target", () => {
    const entries = buildCloudPaletteProjects([{ key: "project", identity: "github.com/a/b", fullName: "a/b", orgName: "Team", blank: false, workspaces: [{ key: "cloud:org:ws", name: workspace.name, number: 12, ownerName: "Team Owner", lastActivity: 1 }] }]);
    const entry = entries.find((item) => item.cloudWorkspaceKey);
    expect(entry?.primary).toBe("#12 · feature/team");
    expect(entry?.secondary).toContain("Team Owner");
    expect(entry?.cloudWorkspaceKey).toBe("cloud:org:ws");
  });
});
