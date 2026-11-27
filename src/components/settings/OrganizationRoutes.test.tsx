import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus, OrganizationRoute, OrganizationRoutes as Routes } from "@/lib/api";
import { OrganizationRoutes } from "./OrganizationRoutes";

const { current, list, remove } = vi.hoisted(() => ({
  current: { ready: true },
  list: vi.fn(),
  remove: vi.fn(),
}));

function account() {
  return {
    status: {
      state: "signed-in",
      context: { revision: "rev-1" },
      phase2Readiness: current.ready ? { "org-2": ["cloud.agent-routes.organization.v1"] } : {},
    } as unknown as AccountStatus,
  };
}
vi.mock("@/lib/account", () => ({ getAccount: account, useAccount: account }));
vi.mock("@/lib/api", () => ({ api: { cloudOrganizationRoutes: list, cloudOrganizationRouteRemove: remove } }));

const route: OrganizationRoute = {
  id: "orgroute_0b6f3c1e-1d2a-4f5b-8c7d-9e0f1a2b3c4d",
  provider: "claude",
  repository: "acme/terminalx",
  templateId: "claude-gateway",
  templateVersion: 1,
  templateCurrent: true,
  settings: { baseUrl: "https://gateway.example.com/anthropic", authScheme: "bearer" },
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};
const routes = (canManage: boolean, rows: OrganizationRoute[] = [route]): Routes => ({ canManage, templates: [], routes: rows });

const show = () => render(<OrganizationRoutes contextRevision="rev-1" organizationId="org-2" organizationName="Acme" />);
const openMenu = async () => {
  const trigger = await screen.findByRole("button", { name: "Route actions for Claude Code on acme/terminalx" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove route…" }));
  return screen.findByTestId("organization-route-remove");
};

beforeEach(() => {
  current.ready = true;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  list.mockReset();
  remove.mockReset();
});

it("stays hidden and reads nothing while the readiness key is off", () => {
  current.ready = false;
  show();
  expect(screen.queryByTestId("organization-routes")).toBeNull();
  expect(list).not.toHaveBeenCalled();
});

it.each([["owner"], ["admin"]])("shows an %s the route, marked as set by the organization, with a way to remove it", async () => {
  list.mockResolvedValue(routes(true));
  show();
  const row = await screen.findByTestId("organization-route");
  expect(within(row).getByText("Custom provider for Claude Code")).toBeTruthy();
  expect(within(row).getByTestId("organization-route-badge").textContent).toContain("Set by Acme");
  expect(row.textContent).toContain("Claude Code in acme/terminalx workspaces goes through https://gateway.example.com/anthropic. It takes precedence over members’ own logins.");
  expect(screen.getByText("Set by owners and admins for everyone in Acme.")).toBeTruthy();
  expect(list).toHaveBeenCalledWith("org-2");
  expect(within(row).getByRole("button", { name: /Route actions/ })).toBeTruthy();
});

it("shows a member the route read-only, with nothing to change or remove", async () => {
  list.mockResolvedValue(routes(false));
  show();
  const row = await screen.findByTestId("organization-route");
  expect(within(row).getByText("Custom provider for Claude Code")).toBeTruthy();
  expect(within(row).queryByRole("button")).toBeNull();
});

it("asks before removing, and Cancel changes nothing", async () => {
  list.mockResolvedValue(routes(true));
  show();
  const dialog = await openMenu();
  expect(within(dialog).getByText("Disconnect custom provider?")).toBeTruthy();
  expect(dialog.textContent).toContain("Remove the custom route? Claude Code goes back to each member’s own login.");
  expect(dialog.textContent).toContain("Route https://gateway.example.com/anthropic for workspaces on acme/terminalx. Members without their own Claude login can’t start Claude Code there until they connect one. Running workspaces keep this route until they restart.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByTestId("organization-route-remove")).toBeNull());
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByTestId("organization-route")).toBeTruthy();
});

it("removes the route once the service confirms, and says new sessions use members' own logins", async () => {
  list.mockResolvedValue(routes(true));
  let confirm: (value: Routes) => void = () => {};
  remove.mockReturnValue(new Promise<Routes>((resolve) => { confirm = resolve; }));
  show();
  const dialog = await openMenu();
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove route" }));
  expect(remove).toHaveBeenCalledExactlyOnceWith(route.id, "rev-1", "org-2");
  // Nothing is reported as removed until the service answers.
  expect(screen.getByTestId("organization-route")).toBeTruthy();
  expect(screen.queryByTestId("organization-routes-notice")).toBeNull();
  confirm(routes(true, []));
  await waitFor(() => expect(screen.queryByTestId("organization-route")).toBeNull());
  expect(screen.getByTestId("organization-routes-notice").textContent).toBe("Route removed. New Claude Code sessions on acme/terminalx use each member's own login.");
});

it("keeps the route and says so when removing fails", async () => {
  list.mockResolvedValue(routes(true));
  remove.mockRejectedValue({ code: "organization_admin_required" });
  show();
  const dialog = await openMenu();
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove route" }));
  expect(await screen.findByTestId("organization-routes-error")).toBeTruthy();
  expect(screen.getByTestId("organization-route")).toBeTruthy();
  expect(screen.queryByTestId("organization-routes-notice")).toBeNull();
});

it("shows loading, then a load failure with a retry", async () => {
  let fail: (error: unknown) => void = () => {};
  list.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  show();
  expect(screen.getByRole("status").textContent).toContain("Loading routes");
  fail({ code: "cloud_organization_unavailable" });
  const error = await screen.findByTestId("organization-routes-error");
  expect(error.textContent).toContain("can't be reached");
  list.mockResolvedValueOnce(routes(false));
  fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
  expect(await screen.findByTestId("organization-route")).toBeTruthy();
  expect(screen.queryByTestId("organization-routes-error")).toBeNull();
});

it("drops a route someone else already removed, with nothing to retry", async () => {
  list.mockResolvedValue(routes(true));
  remove.mockRejectedValue({ code: "cloud_organization_route_not_found" });
  show();
  const dialog = await openMenu();
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove route" }));
  await waitFor(() => expect(screen.queryByTestId("organization-route")).toBeNull());
  expect(screen.getByTestId("organization-routes-notice").textContent).toBe("That route was already removed.");
  expect(screen.queryByTestId("organization-routes-error")).toBeNull();
});

it("doesn't let a reload and a remove race: each waits for the other", async () => {
  list.mockResolvedValueOnce(routes(true));
  remove.mockRejectedValueOnce({ code: "cloud_organization_unavailable" });
  show();
  const dialog = await openMenu();
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove route" }));
  const error = await screen.findByTestId("organization-routes-error");
  // Reloading: no remove can start until the list is back.
  let answer: (value: Routes) => void = () => {};
  list.mockReturnValueOnce(new Promise<Routes>((resolve) => { answer = resolve; }));
  fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
  const trigger = screen.getByRole("button", { name: /Route actions/ }) as HTMLButtonElement;
  await waitFor(() => expect(trigger.disabled).toBe(true));
  answer(routes(true));
  await waitFor(() => expect(trigger.disabled).toBe(false));
});

it("shows forks with the same name apart, by owner", async () => {
  list.mockResolvedValue(routes(false, [route, { ...route, id: "orgroute_1b6f3c1e-1d2a-4f5b-8c7d-9e0f1a2b3c4d", repository: "fork/terminalx" }]));
  show();
  await waitFor(() => expect(screen.getAllByTestId("organization-route")).toHaveLength(2));
  const text = screen.getAllByTestId("organization-route").map((row) => row.textContent);
  expect(text[0]).toContain("acme/terminalx");
  expect(text[1]).toContain("fork/terminalx");
});
