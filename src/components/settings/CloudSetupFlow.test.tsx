import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type AccountStatus } from "@/lib/api";
import { organizationGithubApp } from "@/lib/organizationGithubApp";
import { CloudSetupFlow } from "./CloudSetupFlow";

const mocks = vi.hoisted(() => ({ status: {} as AccountStatus, select: vi.fn(), finish: vi.fn(), exit: vi.fn() }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: mocks.status }), refreshAccount: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { organizationSelect: vi.fn(), cloudProviders: vi.fn(), cloudAgentLogins: vi.fn() }, errorMessage: (e: Error) => e.message }));
vi.mock("@/lib/cloudCatalog", () => ({ defaultOrgId: (s: AccountStatus) => s.identity?.organizationId }));
vi.mock("@/lib/sessions", () => ({ selectCloudWorkspace: mocks.select }));
vi.mock("@/lib/organizationGithubApp", () => ({ organizationGithubApp: { summary: vi.fn() } }));
vi.mock("./ProviderControls", () => ({ ProviderControls: () => <div>Existing provider controls</div> }));
vi.mock("./ComputerColorPicker", () => ({ ComputerColorPicker: () => <div>Computer color picker</div> }));
vi.mock("./OrganizationGithubApp", () => ({ OrganizationGithubApp: () => <div>Existing GitHub connection</div> }));
vi.mock("./OrganizationAgentLogins", () => ({ OrganizationAgentLogins: () => <div>Existing organization logins</div>, agentLoginUsable: (login: { state: string }) => login.state === "connected" }));
vi.mock("./OrganizationOnboarding", () => ({ OrganizationOnboarding: () => <div>Existing organization creation</div> }));
vi.mock("./OrganizationSetupSteps", () => ({ OrganizationSetupSteps: ({ onRecord, record }: { onRecord: (record: unknown) => void; record: object }) => <button onClick={() => onRecord({ ...record, step: "done", workspace: { id: "setup-ws" } })}>Workspace becomes ready</button> }));

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  mocks.status = { state: "signed-in", identity: { email: "a@b.c", name: "A", organization: "Team", organizationId: "org" }, context: { revision: "rev", account: "account", scope: "scope" }, organizations: [{ id: "org", name: "Team", role: "admin" }] } as AccountStatus;
  vi.mocked(api.cloudProviders).mockResolvedValue({ providers: [{ id: "box", availability: "available" }] } as never);
  vi.mocked(organizationGithubApp.summary).mockResolvedValue({ repositories: [{ state: "accessible", cloneUrl: "https://github.com/a/b" }] } as never);
  vi.mocked(api.cloudAgentLogins).mockResolvedValue({ credentials: [{ state: "connected" }] } as never);
});
afterEach(cleanup);
const mount = () => render(<CloudSetupFlow organizationId="org" onExit={mocks.exit} onFinish={mocks.finish} />);
const next = async (title: string) => { fireEvent.click(screen.getByRole("button", { name: "Continue" })); await screen.findByRole("heading", { name: title }); };

it("takes an admin through each reused step to the running setup workspace without Settings", async () => {
  mount();
  expect(screen.getByRole("heading", { name: "Get started" })).toBeTruthy();
  await next("Cloud computer"); expect(screen.getByText("Existing provider controls")).toBeTruthy();
  await next("Connect GitHub"); expect(screen.getByText("Existing GitHub connection")).toBeTruthy();
  await next("Agents"); expect(screen.getByText("Existing organization logins")).toBeTruthy();
  await next("You're all set");
  expect((screen.getByText("Go to workspaces") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Workspace becomes ready"));
  fireEvent.click(screen.getByText("Go to workspaces"));
  expect(mocks.select).toHaveBeenCalledWith("cloud:org:setup-ws"); expect(mocks.finish).toHaveBeenCalledOnce(); expect(mocks.exit).not.toHaveBeenCalled();
});

it("keeps the computer step until new machines are available", async () => {
  vi.mocked(api.cloudProviders).mockResolvedValue({ providers: [] }); mount(); await next("Cloud computer");
  fireEvent.click(screen.getByText("Continue")); await screen.findByText(/Connect a provider and allow/);
  expect(screen.getByRole("heading", { name: "Cloud computer" })).toBeTruthy();
});

it("requires an accessible GitHub repository and a usable agent login", async () => {
  mount(); await next("Cloud computer"); await next("Connect GitHub");
  vi.mocked(organizationGithubApp.summary).mockResolvedValue({ repositories: [] } as never);
  fireEvent.click(screen.getByText("Continue")); await screen.findByText(/select at least one/);
  vi.mocked(organizationGithubApp.summary).mockResolvedValue({ repositories: [{ state: "accessible", cloneUrl: "https://github.com/a/b" }] } as never);
  await next("Agents"); vi.mocked(api.cloudAgentLogins).mockResolvedValue({ credentials: [] });
  fireEvent.click(screen.getByText("Continue")); await screen.findByText(/Connect at least one agent/);
});

it("continues with Enter, returns to Settings with Escape, and keeps Enter inside inputs", async () => {
  mount(); fireEvent.keyDown(screen.getByRole("heading", { name: "Get started" }), { key: "Enter" });
  await screen.findByRole("heading", { name: "Cloud computer" });
  fireEvent.keyDown(window, { key: "Escape" }); expect(mocks.exit).toHaveBeenCalledOnce();
});

it("does not offer admin steps to a member", () => {
  mocks.status.organizations![0].role = "member"; mount();
  expect((screen.getByText("Continue") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("Existing provider controls")).toBeNull();
});

it("selects a different organization before rendering its active-only controls", async () => {
  mocks.status.identity!.organizationId = "other";
  vi.mocked(api.organizationSelect).mockImplementation(async () => { mocks.status.identity!.organizationId = "org"; return mocks.status; });
  mount(); await next("Cloud computer");
  await waitFor(() => expect(api.organizationSelect).toHaveBeenCalledWith("org", "rev"));
});
