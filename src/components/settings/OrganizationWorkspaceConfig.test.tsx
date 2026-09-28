import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { workspaceConfig, type OrganizationConfigView, type SecretsView } from "@/lib/workspaceConfig";
import { OrganizationWorkspaceConfig } from "./OrganizationWorkspaceConfig";

vi.mock("@/lib/workspaceConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaceConfig")>()),
  workspaceConfig: {
    organization: vi.fn(),
    updateOrganization: vi.fn(),
    updateRepository: vi.fn(),
    secrets: vi.fn(),
    putSecret: vi.fn(),
    deleteSecret: vi.fn(),
    bindSecret: vi.fn(),
    unbindSecret: vi.fn(),
  },
}));

const api = vi.mocked(workspaceConfig);

const layer = (overrides: Partial<OrganizationConfigView["organization"]> = {}): OrganizationConfigView["organization"] => ({
  scope: "organization",
  scopeKey: "",
  version: 2,
  env: { NODE_ENV: "production" },
  prompt: "Org rules.",
  mcpServers: [],
  memberOverrides: { env: true, prompt: true, mcpServers: false },
  lockedEnvKeys: ["REGION"],
  updatedBy: "admin",
  updatedAt: 1,
  ...overrides,
});

const view = (overrides: Partial<OrganizationConfigView> = {}): OrganizationConfigView => ({
  organization: layer(),
  repositories: [{ ...layer({ scope: "repository", scopeKey: "github.com/acme/app", version: 1, env: { PACKAGE_MANAGER: "pnpm" }, memberOverrides: null, lockedEnvKeys: [] }) }],
  canEdit: true,
  fieldImpact: { env: "restart-sessions", prompt: "new-sessions", mcpServers: "restart-sessions", secrets: "restart-sessions" },
  contextRevision: "rev-1",
  ...overrides,
});

const vault = (overrides: Partial<SecretsView> = {}): SecretsView => ({
  secrets: [
    {
      id: "secret_1",
      name: "NPM_TOKEN",
      version: 1,
      runtimeAccess: "private-workspaces",
      value: "********",
      updatedAt: 1,
      bindings: [{ id: "binding_1", scope: "repository", scopeKey: "github.com/acme/app", envName: "NPM_TOKEN", createdAt: 1 }],
    },
  ],
  canEdit: true,
  contextRevision: "rev-1",
  ...overrides,
});

const impact = (changed: string[], restart: boolean) => ({
  layer: layer(),
  impact: { changed: changed as never, runningSessions: restart ? ("restart-required" as const) : ("unaffected" as const), rebuildRequired: false },
  contextRevision: "rev-1",
});

beforeEach(() => {
  vi.resetAllMocks();
  api.organization.mockResolvedValue(view());
  api.secrets.mockResolvedValue(vault());
});
afterEach(cleanup);

it("explains precedence, restart impact and that nothing needs a rebuild", async () => {
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  const precedence = await screen.findByLabelText("Configuration precedence");
  expect(precedence.textContent).toContain("the organization, then the repository, then the workspace");
  expect(precedence.textContent).toContain("nothing needs a rebuild");
  const impactList = screen.getByLabelText("Change impact");
  expect(impactList.textContent).toContain("Variables: running sessions need a restart");
  expect(impactList.textContent).toContain("Prompts: applies to new sessions");
});

it("saves organization defaults with overrides, locked keys and versions, then reports the impact", async () => {
  api.updateOrganization.mockResolvedValue(impact(["env"], true));
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  fireEvent.change(await screen.findByLabelText("Organization variables"), { target: { value: "NODE_ENV=test\nLOG_LEVEL=info" } });
  fireEvent.click(screen.getByLabelText("Members may override MCP servers"));
  fireEvent.change(screen.getByLabelText("Locked variables"), { target: { value: "REGION, LOG_LEVEL" } });
  fireEvent.click(screen.getByRole("button", { name: "Save organization defaults" }));
  await waitFor(() =>
    expect(api.updateOrganization).toHaveBeenCalledWith(
      {
        expectedVersion: 2,
        env: { NODE_ENV: "test", LOG_LEVEL: "info" },
        prompt: "Org rules.",
        mcpServers: [],
        memberOverrides: { env: true, prompt: true, mcpServers: true },
        lockedEnvKeys: ["REGION", "LOG_LEVEL"],
      },
      "rev-1",
    ),
  );
  expect(await screen.findByText(/Running agent sessions keep their old settings until they are restarted/)).toBeTruthy();
});

it("keeps secret-looking variables out of ordinary configuration", async () => {
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  fireEvent.change(await screen.findByLabelText("Organization variables"), { target: { value: "STRIPE_API_KEY=sk" } });
  fireEvent.click(screen.getByRole("button", { name: "Save organization defaults" }));
  expect(await screen.findByText(/looks like a secret/)).toBeTruthy();
  expect(api.updateOrganization).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Organization variables") as HTMLTextAreaElement).value).toBe("STRIPE_API_KEY=sk");
});

it("edits a repository layer with its own version", async () => {
  api.updateRepository.mockResolvedValue(impact(["prompt"], false));
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit github.com/acme/app" }));
  expect((screen.getByLabelText("Repository variables") as HTMLTextAreaElement).value).toBe("PACKAGE_MANAGER=pnpm");
  fireEvent.change(screen.getByLabelText("Repository prompt"), { target: { value: "Use pnpm." } });
  fireEvent.click(screen.getByRole("button", { name: "Save repository configuration" }));
  await waitFor(() =>
    expect(api.updateRepository).toHaveBeenCalledWith("github.com/acme/app", { expectedVersion: 1, env: { PACKAGE_MANAGER: "pnpm" }, prompt: "Use pnpm.", mcpServers: [] }, "rev-1"),
  );
  expect(await screen.findByText(/Running agent sessions are unaffected/)).toBeTruthy();
});

it("keeps unsaved organization edits when a save is refused", async () => {
  api.updateOrganization.mockRejectedValue({ code: "cloud_workspace_config_mcp_invalid", status: 422, retryAfterSeconds: null });
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  fireEvent.change(await screen.findByLabelText("Organization prompt"), { target: { value: "New rules." } });
  fireEvent.click(screen.getByRole("button", { name: "Save organization defaults" }));
  expect(await screen.findByText(/An MCP server was refused/)).toBeTruthy();
  await waitFor(() => expect(api.organization).toHaveBeenCalledTimes(2));
  expect((screen.getByLabelText("Organization prompt") as HTMLTextAreaElement).value).toBe("New rules.");
});

it("refuses to save one repository's draft over another configured repository", async () => {
  api.organization.mockResolvedValue(
    view({ repositories: [...view().repositories, { ...view().repositories[0], scopeKey: "github.com/acme/b", version: 4 }] }),
  );
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit github.com/acme/app" }));
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/Acme/B.git" } });
  fireEvent.click(screen.getByRole("button", { name: "Save repository configuration" }));
  expect(await screen.findByText(/github.com\/acme\/b is already configured/)).toBeTruthy();
  expect(api.updateRepository).not.toHaveBeenCalled();
});

it("shows secrets masked, saves a value write-only and clears the field", async () => {
  api.putSecret.mockResolvedValue(vault());
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  const stored = await screen.findByRole("list", { name: "Stored secrets" });
  const item = within(stored).getByRole("listitem", { name: "NPM_TOKEN" });
  expect(item.textContent).toContain("NPM_TOKEN = ********");
  expect(item.textContent).toContain("github.com/acme/app → NPM_TOKEN");
  expect(item.textContent).toContain("private workspaces only");
  const value = screen.getByLabelText("Secret value") as HTMLInputElement;
  expect(value.type).toBe("password");
  fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "deploy_token" } });
  fireEvent.change(value, { target: { value: "s3cret" } });
  fireEvent.change(screen.getByLabelText("Secret runtime access"), { target: { value: "all-workspaces" } });
  fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
  await waitFor(() => expect(api.putSecret).toHaveBeenCalledWith("DEPLOY_TOKEN", "s3cret", "all-workspaces", "rev-1"));
  await waitFor(() => expect(value.value).toBe(""));
  expect(document.body.textContent).not.toContain("s3cret");
});

it("binds and unbinds secrets", async () => {
  api.bindSecret.mockResolvedValue(vault());
  api.unbindSecret.mockResolvedValue(vault({ secrets: [{ ...vault().secrets[0], bindings: [] }] }));
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  fireEvent.change(await screen.findByLabelText("Secret to bind"), { target: { value: "NPM_TOKEN" } });
  fireEvent.change(screen.getByLabelText("Binding scope"), { target: { value: "workspace" } });
  fireEvent.change(screen.getByLabelText("Binding target"), { target: { value: "ws_1" } });
  fireEvent.click(screen.getByRole("button", { name: "Bind" }));
  await waitFor(() => expect(api.bindSecret).toHaveBeenCalledWith("NPM_TOKEN", "workspace", "ws_1", "NPM_TOKEN", "rev-1"));
  fireEvent.click(screen.getByRole("button", { name: "Unbind NPM_TOKEN from github.com/acme/app" }));
  await waitFor(() => expect(api.unbindSecret).toHaveBeenCalledWith("binding_1", "rev-1"));
  expect(await screen.findByText("Not bound to any workspace.")).toBeTruthy();
});

it("reports a refused override and reloads", async () => {
  api.updateOrganization.mockRejectedValue({ code: "cloud_workspace_config_conflict", status: 409, retryAfterSeconds: null });
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Save organization defaults" }));
  expect(await screen.findByText(/Someone else changed this configuration/)).toBeTruthy();
  await waitFor(() => expect(api.organization).toHaveBeenCalledTimes(2));
});

it("shows members a read-only summary without edit controls", async () => {
  api.organization.mockResolvedValue(view({ canEdit: false }));
  api.secrets.mockResolvedValue(vault({ canEdit: false }));
  render(<OrganizationWorkspaceConfig contextRevision="account-1" />);
  expect(await screen.findByText(/Only owners and admins can change workspace configuration/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save organization defaults" })).toBeNull();
  expect(screen.queryByLabelText("Secret value")).toBeNull();
  expect(screen.queryByRole("button", { name: /Unbind/ })).toBeNull();
});
