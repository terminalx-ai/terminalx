import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { loadSetups, newSetup, saveSetup } from "@/lib/organizationSetup";
import { CloudSetupFlow } from "./CloudSetupFlow";
import type { StepProps } from "./stepProps";

const mocks = vi.hoisted(() => ({ status: null as unknown as AccountStatus, refreshAccount: vi.fn() }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: mocks.status }), refreshAccount: mocks.refreshAccount }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, organizationCreate: vi.fn(), organizationSelect: vi.fn() } };
});
// Keep the real flow and creation step; downstream service setup is outside this boundary.
vi.mock("./GithubStep", () => ({ GithubStep: ({ organization }: StepProps) => <div>GitHub for {organization.id}</div> }));
vi.mock("./EnvironmentStep", () => ({ EnvironmentStep: ({ organization }: StepProps) => <div>Environment for {organization.id}</div> }));
vi.mock("./ComputeStep", () => ({ ComputeStep: () => null }));
vi.mock("./LoginsStep", () => ({ LoginsStep: () => null }));
vi.mock("./InviteStep", () => ({ InviteStep: () => null }));

const email = "owner@example.test";
const organization = { id: "org-1", name: "Team", role: "owner" };
const mount = (target: Parameters<typeof CloudSetupFlow>[0]["target"] = { kind: "create" }) =>
  render(<CloudSetupFlow target={target} onExit={vi.fn()} onDone={vi.fn()} />);
const create = () => {
  fireEvent.change(screen.getByRole("textbox", { name: "Organization name" }), { target: { value: "Team" } });
  fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
};
const selectOrganization = () => {
  mocks.status = { ...mocks.status, identity: { ...mocks.status.identity!, organization: "Team", organizationId: "org-1" }, organizations: [organization] };
};

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  mocks.status = { state: "signed-in", identity: { name: "Owner", email, organization: null }, organizations: [], context: { scope: "account", revision: "rev-1" }, expiresAt: null, lastError: null };
  mocks.refreshAccount.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("creates an organization and opens its next setup step after refreshing the account", async () => {
  vi.mocked(api.organizationCreate).mockResolvedValue(organization);
  mocks.refreshAccount.mockImplementation(async () => selectOrganization());
  mount();
  create();
  expect(await screen.findByText("GitHub for org-1")).toBeTruthy();
  expect(api.organizationCreate).toHaveBeenCalledExactlyOnceWith("Team", expect.any(String));
  expect(api.organizationSelect).not.toHaveBeenCalled();
  expect(loadSetups(email)[0]).toMatchObject({ organizationId: "org-1", flow: { step: "github" } });
});

it("reuses the pending creation request after a lost response and remount", async () => {
  vi.mocked(api.organizationCreate).mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue(organization);
  mount();
  create();
  await screen.findByText("Lost response");
  const request = vi.mocked(api.organizationCreate).mock.calls[0];
  cleanup();
  mocks.refreshAccount.mockImplementation(async () => selectOrganization());
  mount();
  expect((screen.getByRole("textbox", { name: "Organization name" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
  await screen.findByText("GitHub for org-1");
  expect(vi.mocked(api.organizationCreate).mock.calls).toEqual([request, request]);
});

it("retries selection of a newly created organization without creating it again", async () => {
  vi.mocked(api.organizationCreate).mockResolvedValue({ ...organization, selected: false });
  mocks.refreshAccount.mockImplementationOnce(async () => {
    mocks.status = { ...mocks.status, organizations: [organization] };
  }).mockImplementation(async () => selectOrganization());
  vi.mocked(api.organizationSelect).mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(mocks.status);
  mount();
  create();
  await screen.findByText("Team could not be selected: Offline");
  expect(screen.queryByText("GitHub for org-1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("GitHub for org-1");
  expect(api.organizationSelect).toHaveBeenCalledTimes(2);
  expect(api.organizationSelect).toHaveBeenLastCalledWith("org-1", "rev-1");
  expect(api.organizationCreate).toHaveBeenCalledOnce();
});

it("resumes saved progress only after selecting the requested organization", async () => {
  mocks.status = { ...mocks.status, organizations: [organization], identity: { name: "Owner", email, organization: "Other", organizationId: "other" } };
  saveSetup(email, { ...newSetup("Team", "saved-request"), organizationId: "org-1", flow: { step: "environment", passed: ["organization", "github"], finishedAt: null } });
  let finishSelection!: () => void;
  vi.mocked(api.organizationSelect).mockImplementation(() => new Promise<AccountStatus>((resolve) => { finishSelection = () => resolve(mocks.status); }));
  mocks.refreshAccount.mockImplementation(async () => selectOrganization());
  mount({ kind: "resume", organizationId: "org-1" });
  await waitFor(() => expect(api.organizationSelect).toHaveBeenCalledWith("org-1", "rev-1"));
  expect(screen.queryByText("Environment for org-1")).toBeNull();
  finishSelection();
  await screen.findByText("Environment for org-1");
  expect(api.organizationCreate).not.toHaveBeenCalled();
});
