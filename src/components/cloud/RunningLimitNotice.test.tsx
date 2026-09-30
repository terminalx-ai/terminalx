import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({ value: { orgs: {} } as unknown }));
vi.mock("@/lib/cloudCatalog", () => ({ useCloudCatalog: () => catalog.value, getCloudCatalog: () => catalog.value }));
vi.mock("@/components/cloud/WorkspaceActions", () => ({
  WorkspaceLifecycleDialog: ({ request }: { request: { item: { workspace: { name: string } }; action: string } }) => (
    <div role="dialog">{`${request.action} ${request.item.workspace.name}`}</div>
  ),
}));

const { RunningLimitNotice } = await import("./RunningLimitNotice");

const item = (id: string, state: string) => ({ workspace: { id, orgId: "org-a", name: `${id}-vm`, state, archivedAt: null }, latestOperation: null });

afterEach(() => cleanup());

describe("RunningLimitNotice", () => {
  it("lists running workspaces and stops one through the usual confirmation", () => {
    catalog.value = { orgs: { "org-a": { workspaces: [item("a", "ready"), item("b", "suspended"), item("c", "provisioning")], quota: null } } };
    render(<RunningLimitNotice orgId="org-a" />);
    const list = screen.getByRole("group", { name: "Running cloud workspaces" });
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["a-vm Stop", "c-vmStarting or stopping"]);
    fireEvent.click(within(list).getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("dialog").textContent).toBe("stop a-vm");
  });

  it("shows nothing when the catalog has no running workspace", () => {
    catalog.value = { orgs: { "org-a": { workspaces: [item("b", "suspended")], quota: null } } };
    render(<RunningLimitNotice orgId="org-a" />);
    expect(screen.queryByTestId("running-limit-notice")).toBeNull();
  });
});
