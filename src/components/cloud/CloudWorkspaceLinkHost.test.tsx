import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(async () => () => {}), select: vi.fn(), refresh: vi.fn(),
  account: { state: "signed-in", identity: null, expiresAt: null, lastError: null, context: { account: "user", scope: "scope", revision: "1" } } as AccountStatus,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: mocks.account }), getAccount: () => ({ status: mocks.account }), refreshAccount: vi.fn(async () => {}), signIn: vi.fn() }));
vi.mock("@/lib/cloudCatalog", () => ({ refreshCloudWorkspaces: mocks.refresh, findCloudWorkspace: vi.fn(), getCloudCatalog: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ selectCloudWorkspace: mocks.select, getSessionStore: vi.fn(() => ({})) }));
vi.mock("@/lib/hotkeys", () => ({ registerShortcut: vi.fn(() => () => {}) }));
import { CloudWorkspaceLinkHost } from "./CloudWorkspaceLinkHost";
const link = { org: "old-team", number: 12 };
beforeEach(() => {
  vi.clearAllMocks(); mocks.account.state = "signed-in";
  mocks.invoke.mockImplementation(async (command: string) => command === "cloud_workspace_link_pending" ? link : command === "cloud_workspace_link_resolve" ? { orgId: "org", workspaceId: "ws" } : undefined);
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(cleanup);
describe("cloud link delivery", () => {
  it("opens a cold-start link only after the server resolves access and refreshes the target list", async () => {
    render(<CloudWorkspaceLinkHost />);
    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("cloud:org:ws"));
    expect(mocks.refresh).toHaveBeenCalledWith("org");
    expect(mocks.invoke).toHaveBeenCalledWith("cloud_workspace_link_clear", { link });
    expect(mocks.invoke.mock.calls.some(([name]) => /resume|create|attach/.test(name))).toBe(false);
  });
  it("retains a link through sign-in without resolving it while signed out", async () => {
    mocks.account.state = "signed-out";
    const view = render(<CloudWorkspaceLinkHost />);
    await screen.findByText("Sign in to open this workspace.");
    expect(mocks.invoke).not.toHaveBeenCalledWith("cloud_workspace_link_resolve", expect.anything());
    mocks.account.state = "signed-in";
    view.rerender(<CloudWorkspaceLinkHost />);
    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("cloud:org:ws"));
  });
  it("does not navigate on access denial", async () => {
    mocks.invoke.mockImplementation(async (command: string) => { if (command === "cloud_workspace_link_pending") return link; throw new Error("cloud_workspace_not_found"); });
    render(<CloudWorkspaceLinkHost />);
    await screen.findByText(/You don't have access/);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("ignores an answer after the link dialog is unmounted", async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation(async (command: string) => command === "cloud_workspace_link_pending" ? link : new Promise((resolve) => { finish = resolve; }));
    const view = render(<CloudWorkspaceLinkHost />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_workspace_link_resolve", { link }));
    view.unmount();
    await act(async () => finish({ orgId: "org", workspaceId: "ws" }));
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
