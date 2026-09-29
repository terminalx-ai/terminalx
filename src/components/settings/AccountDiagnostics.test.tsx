import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: null as unknown,
  api: { cloudDiagnostics: vi.fn(), cloudConnectionDiagnostics: vi.fn(), cloudDiagnosticsExport: vi.fn() },
}));

vi.mock("@/lib/account", () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  useAccount: () => ({ ready: true, busy: false, status: mocks.status }),
}));
vi.mock("@/lib/pairing", () => ({
  setPairingHostName: vi.fn(),
  usePairing: () => ({ ready: true, busy: false, status: { host: null, devices: [] } }),
}));
vi.mock("@/lib/api", () => ({ api: mocks.api, errorMessage: String }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("./OrganizationOnboarding", () => ({ OrganizationOnboarding: () => null }));
vi.mock("./OrganizationMembers", () => ({ OrganizationMembers: () => null }));
vi.mock("./OrganizationCompute", () => ({ OrganizationCompute: () => null }));
vi.mock("./OrganizationGithubApp", () => ({ OrganizationGithubApp: () => null }));
vi.mock("./OrganizationWorkspaceConfig", () => ({ OrganizationWorkspaceConfig: () => null }));

const { AccountTab } = await import("./AccountTab");

const signedIn = (role: string) => ({
  state: "signed-in",
  identity: { name: "Owner", email: "owner@example.test", organization: "Team" },
  expiresAt: null,
  lastError: null,
  context: { scope: "s", revision: "rev-1" },
  organizations: [{ id: "org_1", name: "Team", role }],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.cloudDiagnostics.mockRejectedValue({ code: "cloud_diagnostics_not_supported" });
  mocks.api.cloudConnectionDiagnostics.mockResolvedValue([]);
});
afterEach(cleanup);

it("signed out: local workflows only, no diagnostics section and no cloud request", async () => {
  mocks.status = { state: "signed-out", identity: null, expiresAt: null, lastError: null };
  render(<AccountTab />);
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(screen.getByText(/every local workspace and agent continues to work without an account/)).toBeTruthy();
  expect(screen.queryByText("Cloud diagnostics")).toBeNull();
  await Promise.resolve();
  expect(mocks.api.cloudDiagnostics).not.toHaveBeenCalled();
  expect(mocks.api.cloudConnectionDiagnostics).not.toHaveBeenCalled();
});

it("a member of the active organization gets this Mac's closes but no organization request", async () => {
  mocks.status = signedIn("member");
  render(<AccountTab />);
  expect(await screen.findByText(/Only organization owners and administrators/)).toBeTruthy();
  expect(mocks.api.cloudConnectionDiagnostics).toHaveBeenCalled();
  expect(mocks.api.cloudDiagnostics).not.toHaveBeenCalled();
});

it("an administrator sees the diagnostics section", async () => {
  mocks.status = signedIn("admin");
  render(<AccountTab />);
  expect(screen.getByText("Cloud diagnostics")).toBeTruthy();
  await waitFor(() => expect(mocks.api.cloudDiagnostics).toHaveBeenCalledWith(7));
});
