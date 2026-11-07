import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { organizationMcp, type McpView } from "@/lib/organizationMcp";
import { OrganizationMcpServers } from "./OrganizationMcpServers";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/organizationMcp", async (original) => ({ ...(await original<typeof import("@/lib/organizationMcp")>()), organizationMcp: { list: vi.fn(), save: vi.fn(), remove: vi.fn(), signIn: vi.fn(), import: vi.fn() } }));
const api = vi.mocked(organizationMcp);
const view = (): McpView => ({ servers: [], canEdit: true, contextRevision: "rev-1" });
const server = { id: "mcp-1", name: "docs", url: "https://docs.example/mcp", auth: "oauth" as const, version: 1, status: "needs-reauth" as const, checkedAt: null, hasClientIdentity: false };
beforeEach(() => { vi.resetAllMocks(); api.list.mockResolvedValue(view()); api.save.mockResolvedValue({ ...view(), servers: [server] }); });
afterEach(cleanup);
it("adds a server with a form and signs in without receiving tokens", async () => {
  render(<OrganizationMcpServers contextRevision="account-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
  fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "docs" } });
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: server.url } });
  fireEvent.click(screen.getByRole("button", { name: "Save server" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith({ name: "docs", url: server.url, auth: "oauth", expectedVersion: 0 }, null, "rev-1"));
  expect(await screen.findByText("Needs re-auth")).toBeTruthy();
  api.signIn.mockResolvedValue("https://auth.example/authorize?state=fixture");
  fireEvent.click(screen.getByRole("button", { name: "Re-authenticate docs" }));
  await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://auth.example/authorize?state=fixture"));
});
it("previews Mac imports before saving and shows unsupported servers", async () => {
  api.import.mockResolvedValue({ servers: [{ name: "docs", url: server.url, requiresAuth: true }], skipped: 2 });
  render(<OrganizationMcpServers contextRevision="account-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Import from this Mac" }));
  fireEvent.click(await screen.findByRole("button", { name: "Import docs" }));
  expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe(server.url);
  expect((screen.getByLabelText("Authentication") as HTMLSelectElement).value).toBe("oauth");
  expect(screen.getByText("2 unsupported server(s) skipped.")).toBeTruthy();
  expect(api.save).not.toHaveBeenCalled();
});
it("offers recommendations and retains form errors without sending a request", async () => {
  render(<OrganizationMcpServers contextRevision="account-1" />);
  await screen.findByRole("button", { name: "Add server" });
  fireEvent.click(screen.getByRole("tab", { name: "Recommended" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Linear" }));
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "http://bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Save server" }));
  expect((await screen.findByRole("alert")).textContent).toContain("HTTPS");
  expect(api.save).not.toHaveBeenCalled();
});
it("shows member status without mutation controls", async () => {
  api.list.mockResolvedValue({ ...view(), canEdit: false, servers: [{ ...server, status: "connected", checkedAt: 1 }] });
  render(<OrganizationMcpServers contextRevision="account-1" />);
  expect(await screen.findByText("Connected")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add server" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign in docs" })).toBeNull();
});
it("discards an in-flight import on an account change", async () => {
  let resolve!: (value: { servers: { name: string; url: string; requiresAuth: boolean }[]; skipped: number }) => void;
  api.import.mockReturnValue(new Promise((done) => { resolve = done; }));
  const rendered = render(<OrganizationMcpServers contextRevision="account-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Import from this Mac" }));
  rendered.rerender(<OrganizationMcpServers contextRevision="account-2" />);
  resolve({ servers: [{ name: "old-account", url: server.url, requiresAuth: false }], skipped: 0 });
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("old-account")).toBeNull();
});
