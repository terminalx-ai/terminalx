import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These cover the forms as a Mac runs them, where the secure system dialog exists.
vi.mock("@/lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/platform")>()), hasSecureDialog: true }));
import type { AccountStatus, AgentLogin, OrganizationSummary } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  status: null as unknown as AccountStatus,
  refreshAccount: vi.fn(async () => {}),
  deleteOrganization: vi.fn(async () => {}),
  stored: {} as Record<string, AgentLogin[]>,
  api: {
    cloudAgentLogins: vi.fn(),
    cloudAgentLoginConnect: vi.fn(),
    cloudAgentLoginRemove: vi.fn(),
    cloudAgentCodexLoginCancel: vi.fn(),
    cloudWorkspacePreflight: vi.fn(),
    organizationSelect: vi.fn(),
    cloudDiagnostics: vi.fn(),
    cloudConnectionDiagnostics: vi.fn(),
    cloudDiagnosticsExport: vi.fn(),
    organizationConsoleOpen: vi.fn(),
  },
  workStatus: {
    organization: vi.fn(),
    setOrganization: vi.fn(),
  },
}));

vi.mock("@/lib/account", () => ({
  getAccount: () => ({ status: mocks.status }),
  subscribeAccount: () => () => {},
  useAccount: () => ({ ready: true, busy: false, status: mocks.status }),
  refreshAccount: mocks.refreshAccount,
  deleteOrganization: mocks.deleteOrganization,
}));
vi.mock("@/lib/api", () => ({ api: mocks.api, workStatus: mocks.workStatus, errorMessage: (error: unknown) => String((error as { message?: string })?.message ?? error) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), save: vi.fn() }));
// The active organization's other sections have tests of their own; here they only show where they are.
vi.mock("./OrganizationMembers", () => ({ OrganizationMembers: () => <div data-testid="section-members" /> }));
vi.mock("./OrganizationCompute", () => ({ OrganizationCompute: () => <div data-testid="section-compute" /> }));
vi.mock("./OrganizationGithubApp", () => ({ OrganizationGithubApp: () => <div data-testid="section-github" /> }));
vi.mock("./OrganizationWorkspaceConfig", () => ({ OrganizationWorkspaceConfig: () => <div data-testid="section-config" /> }));
vi.mock("./OrganizationEnvironment", () => ({ OrganizationEnvironment: () => <div data-testid="section-environment" /> }));
vi.mock("./OrganizationCloudTeardown", () => ({ OrganizationCloudTeardown: () => <div data-testid="section-teardown" /> }));
// The person's own model access (PRO-18) has tests of its own; here it shows which organization it is for.
vi.mock("./OrganizationAgentRoutes", () => ({ OrganizationAgentRoutes: ({ organizationId }: { organizationId: string }) => <div data-testid="section-routes" data-organization={organizationId} /> }));

const { OrganizationSettings, organizationPageForRow, organizationPages } = await import("./OrganizationSettings");
const { takeAgentLoginsRequest, takeOrganizationRequest } = await import("@/lib/settingsLinks");

const acme: OrganizationSummary = { id: "a", name: "Acme", role: "owner", isPersonal: false, cloud: { enabled: true, flags: {} } };
const beta: OrganizationSummary = { id: "b", name: "Beta", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } };
const login = (fields: Partial<AgentLogin>): AgentLogin => ({ provider: "codex", authKind: "api-key", fingerprint: "sha256:ab", version: 1, updatedAt: 1, state: "connected", ...fields });
const row = (agent: string) => screen.getAllByTestId("agent-login").find((item) => item.dataset.agent === agent)!;

beforeEach(() => {
  vi.clearAllMocks();
  takeOrganizationRequest();
  takeAgentLoginsRequest("a");
  takeAgentLoginsRequest("b");
  mocks.status = {
    state: "signed-in",
    identity: { name: "Ada", email: "ada@example.com", organization: "Acme", organizationId: "a" },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "rev-1" },
    multiOrg: true,
    organizations: [acme, beta],
  } as AccountStatus;
  // Each organization has its own logins: A has a Codex key, B has none until one is set.
  mocks.stored = { a: [login({ fingerprint: "sha256:aa" })], b: [] };
  mocks.api.cloudAgentLogins.mockImplementation(async (org: string) => ({ credentials: structuredClone(mocks.stored[org] ?? []) }));
  mocks.api.cloudAgentLoginConnect.mockImplementation(async (provider: string, _source: string, consent: { organizationId: string }) => {
    const saved = login({ provider: provider as AgentLogin["provider"], fingerprint: "sha256:bb", version: (mocks.stored[consent.organizationId]?.length ?? 0) + 1 });
    mocks.stored[consent.organizationId] = [saved];
    return saved;
  });
  mocks.api.cloudDiagnostics.mockRejectedValue({ code: "cloud_diagnostics_not_supported" });
  mocks.api.cloudConnectionDiagnostics.mockResolvedValue([]);
  mocks.workStatus.organization.mockImplementation(async () => ({ shareWorkStatus: true, canManage: true, personal: false, linearWorkspaces: [] }));
  mocks.workStatus.setOrganization.mockImplementation(async (_org: string, patch: { shareWorkStatus?: boolean }) => ({ shareWorkStatus: patch.shareWorkStatus ?? true, canManage: true, personal: false, linearWorkspaces: [] }));
});
afterEach(cleanup);

describe("an organization's settings pages (PRO-107, PRO-464)", () => {
  it("changes a non-active organization's agent logins by its id, and leaves the active one's alone", async () => {
    render(<OrganizationSettings organization={beta} page="agentLogins" onDeleted={vi.fn()} />);
    await screen.findAllByTestId("agent-login");
    expect(screen.getByTestId("agent-logins-title").textContent).toBe("Agent logins for Beta");
    expect(mocks.api.cloudAgentLogins).toHaveBeenCalledWith("b");
    expect(mocks.api.cloudAgentLogins).not.toHaveBeenCalledWith("a");

    // Set B's Codex login, then replace it, with A active throughout.
    const connect = async (button: string, replace: boolean) => {
      fireEvent.click(within(row("codex")).getByRole("button", { name: button }));
      const panel = within(row("codex")).getByTestId("agent-login-consent");
      expect(!!within(panel).queryByTestId("agent-login-replace")).toBe(replace);
      within(panel).getAllByRole("checkbox").forEach((box) => fireEvent.click(box));
      fireEvent.click(within(panel).getByRole("button", { name: "Enter the key" }));
      await waitFor(() => expect(screen.getByTestId("agent-logins-notice").textContent).toContain("Codex is connected"));
    };
    await connect("Connect with an API key", false);
    await connect("Replace with an API key", true);
    expect(mocks.api.cloudAgentLoginConnect.mock.calls.map((call) => [call[0], call[2].organizationId, call[2].replaceExisting])).toEqual([
      ["codex", "b", false],
      ["codex", "b", true],
    ]);
    expect(mocks.stored.a).toEqual([login({ fingerprint: "sha256:aa" })]);
    expect(mocks.api.organizationSelect).not.toHaveBeenCalled();
  });

  it("offers a non-active organization's General the way to the pages the service keeps on the active one", () => {
    render(<OrganizationSettings organization={beta} onDeleted={vi.fn()} />);
    expect(screen.getByTestId("organization-settings").textContent).toContain("You are an administrator of Beta. It is not your default organization. What you change on this page applies to Beta only.");
    expect(screen.getByTestId("organization-settings-inactive").textContent).toContain("Members, compute, GitHub, workspace settings, environment, diagnostics and teardown of Beta are changed while it is your default organization.");
    expect(screen.queryByTestId("section-teardown")).toBeNull();
    cleanup();
    // A page it does not have while not active shows General, with that way.
    render(<OrganizationSettings organization={beta} page="members" onDeleted={vi.fn()} />);
    expect(screen.getByTestId("organization-settings").dataset.organizationPage).toBe("general");
    expect(screen.queryByTestId("section-members")).toBeNull();
    expect(screen.getByTestId("organization-settings-inactive")).toBeTruthy();
  });

  it("makes it the active organization only when asked", async () => {
    mocks.api.organizationSelect.mockResolvedValue(mocks.status);
    render(<OrganizationSettings organization={beta} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Make Beta your default organization" }));
    await waitFor(() => expect(mocks.refreshAccount).toHaveBeenCalled());
    expect(mocks.api.organizationSelect).toHaveBeenCalledWith("b", "rev-1");
  });

  it("shows a member read-only status for that organization, with no controls", async () => {
    mocks.api.cloudAgentLogins.mockRejectedValue({ code: "organization_admin_required" });
    mocks.api.cloudWorkspacePreflight.mockImplementation(async (_repositories: unknown, _org: string, agent: string) => ({
      ready: false,
      checks: [{ kind: "agent-credential", cloneUrl: null, agent, status: "failed", errorCode: "cloud_workspace_agent_credential_required", retryable: false }],
    }));
    render(<OrganizationSettings organization={{ ...beta, role: "member" }} page="agentLogins" onDeleted={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-login-member-status")).toHaveLength(3));
    expect(mocks.api.cloudWorkspacePreflight).toHaveBeenCalledWith([], "b", "codex");
    expect(screen.queryByRole("button", { name: /Connect|Log in|Disconnect|Replace/ })).toBeNull();
    cleanup();
    render(<OrganizationSettings organization={{ ...beta, role: "member" }} onDeleted={vi.fn()} />);
    expect(screen.getByTestId("organization-settings").textContent).toContain("You are a member of Beta.");
  });

  it("puts each section of the active organization on its own page", async () => {
    const shown = (page: Parameters<typeof OrganizationSettings>[0]["page"]) => {
      cleanup();
      render(<OrganizationSettings organization={acme} page={page} onDeleted={vi.fn()} />);
      expect(screen.getByTestId("organization-settings").dataset.organizationPage).toBe(page);
    };
    shown("general");
    expect(screen.getByTestId("organization-settings").textContent).toContain("You are an owner of Acme. It is your default organization.");
    expect(screen.queryByTestId("organization-settings-inactive")).toBeNull();
    // Removing cloud resources and deleting the organization are on General.
    expect(screen.getByTestId("section-teardown")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete organization…" })).toBeTruthy();
    for (const [page, section] of [["members", "members"], ["cloudCompute", "compute"], ["modelAccess", "routes"], ["github", "github"], ["workspace", "config"], ["environment", "environment"]] as const) {
      shown(page);
      expect(screen.getByTestId(`section-${section}`)).toBeTruthy();
      expect(screen.queryByTestId("section-teardown")).toBeNull();
    }
    shown("cloudCompute");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Providers", "Limits"]);
    shown("agentLogins");
    await screen.findAllByTestId("agent-login");
    expect(screen.getByTestId("agent-logins-title").textContent).toBe("Agent logins for Acme");
    expect(mocks.api.cloudAgentLogins).toHaveBeenCalledWith("a");
    // Diagnostics are for owners and administrators (moved here from Settings → Account).
    shown("diagnostics");
    expect(screen.getByText("Cloud diagnostics")).toBeTruthy();
    await waitFor(() => expect(mocks.api.cloudDiagnostics).toHaveBeenCalledWith(7, null));
  });

  it("has the organization's work status for its owners and administrators, active or not (#441)", async () => {
    render(<OrganizationSettings organization={beta} onDeleted={vi.fn()} />);
    const share = await screen.findByRole("switch", { name: "Share work status in Beta" });
    expect(mocks.workStatus.organization).toHaveBeenCalledWith("b");
    expect(screen.getByTestId("organization-settings-inactive").textContent).toContain("Its agent logins and work status are changed as it is.");
    expect(screen.getByTestId("organization-settings-inactive").textContent).toContain("So is your own model access in it.");
    fireEvent.click(share);
    await waitFor(() => expect(mocks.workStatus.setOrganization).toHaveBeenCalledWith("b", { shareWorkStatus: false }));
    expect(mocks.api.organizationSelect).not.toHaveBeenCalled();
    cleanup();

    // Personal and per organization, so model access is a page of any organization, active or not.
    render(<OrganizationSettings organization={beta} page="modelAccess" onDeleted={vi.fn()} />);
    expect(screen.getByTestId("section-routes").dataset.organization).toBe("b");
    cleanup();

    render(<OrganizationSettings organization={acme} onDeleted={vi.fn()} />);
    expect(await screen.findByRole("switch", { name: "Share work status in Acme" })).toBeTruthy();
    cleanup();

    // A member is shown no organization switch, and nothing is asked for it.
    mocks.workStatus.organization.mockClear();
    render(<OrganizationSettings organization={{ ...beta, role: "member" }} onDeleted={vi.fn()} />);
    expect(screen.getByTestId("organization-settings").dataset.organization).toBe("b");
    expect(screen.queryByTestId("organization-work-status")).toBeNull();
    expect(mocks.workStatus.organization).not.toHaveBeenCalled();
    expect(screen.getByTestId("organization-settings-inactive").textContent).toContain("Diagnostics of Beta are changed while it is your default organization. Its agent logins are changed as it is.");
    cleanup();
    // A member sets their own model access too.
    render(<OrganizationSettings organization={{ ...beta, role: "member" }} page="modelAccess" onDeleted={vi.fn()} />);
    expect(screen.getByTestId("section-routes").dataset.organization).toBe("b");
  });

  it("asks a member of the active organization for no diagnostics", async () => {
    render(<OrganizationSettings organization={{ ...acme, role: "member" }} page="diagnostics" onDeleted={vi.fn()} />);
    expect(await screen.findByText(/Only organization owners and administrators/)).toBeTruthy();
    expect(mocks.api.cloudConnectionDiagnostics).toHaveBeenCalled();
    expect(mocks.api.cloudDiagnostics).not.toHaveBeenCalled();
  });
});

describe("which pages an organization has (PRO-464)", () => {
  const labels = (role: string, active: boolean) => organizationPages({ role }, active).map((entry) => entry.label);
  it("lists every page for an owner or administrator of the active organization", () => {
    for (const role of ["owner", "admin"]) {
      expect(labels(role, true)).toEqual(["General", "Members", "Cloud compute", "Agent logins", "Model access", "GitHub", "Workspace settings", "Environment", "Diagnostics"]);
    }
  });
  it("leaves out the pages a member cannot manage, and the active-only pages of another organization", () => {
    expect(labels("member", true)).toEqual(["General", "Agent logins", "Model access", "Diagnostics"]);
    expect(labels("owner", false)).toEqual(["General", "Agent logins", "Model access"]);
    expect(labels("member", false)).toEqual(["General", "Agent logins", "Model access"]);
  });
  it("finds the page each organization row is on", () => {
    expect(organizationPageForRow("organizations.providers")).toBe("cloudCompute");
    expect(organizationPageForRow("organizations.compute")).toBe("cloudCompute");
    expect(organizationPageForRow("organizations.agentRoutes")).toBe("modelAccess");
    expect(organizationPageForRow("organizations.teardown")).toBe("general");
    expect(organizationPageForRow("organizations.delete")).toBe("general");
    expect(organizationPageForRow(null)).toBe("general");
  });
});

describe("the link to the organization's API keys and webhooks in the console (PRO-40)", () => {
  it("opens the active organization's console page for an owner", async () => {
    mocks.api.organizationConsoleOpen.mockResolvedValue(undefined);
    render(<OrganizationSettings organization={acme} onDeleted={vi.fn()} />);
    const link = await screen.findByTestId("organization-console-link");
    expect(link.textContent).toContain("API keys and webhooks");
    fireEvent.click(within(link).getByRole("button", { name: /Manage in the console/ }));
    await waitFor(() => expect(mocks.api.organizationConsoleOpen).toHaveBeenCalledWith("a"));
  });

  it("opens another organization's page by its own id, for its administrator, without switching", async () => {
    mocks.api.organizationConsoleOpen.mockResolvedValue(undefined);
    render(<OrganizationSettings organization={beta} onDeleted={vi.fn()} />);
    const link = await screen.findByTestId("organization-console-link");
    expect(link.textContent).toContain("Beta");
    fireEvent.click(within(link).getByRole("button", { name: /Manage in the console/ }));
    await waitFor(() => expect(mocks.api.organizationConsoleOpen).toHaveBeenCalledWith("b"));
    expect(mocks.api.organizationSelect).not.toHaveBeenCalled();
  });

  it("shows nothing to a member", async () => {
    render(<OrganizationSettings organization={{ ...beta, role: "member" }} onDeleted={vi.fn()} />);
    await screen.findByTestId("organization-settings");
    expect(screen.queryByTestId("organization-console-link")).toBeNull();
    render(<OrganizationSettings organization={{ ...acme, role: "member" }} onDeleted={vi.fn()} />);
    expect(screen.queryByTestId("organization-console-link")).toBeNull();
  });

  it("says so when the browser could not be opened", async () => {
    mocks.api.organizationConsoleOpen.mockRejectedValue(new Error("No browser is available."));
    render(<OrganizationSettings organization={acme} onDeleted={vi.fn()} />);
    const link = await screen.findByTestId("organization-console-link");
    fireEvent.click(within(link).getByRole("button", { name: /Manage in the console/ }));
    expect((await within(link).findByRole("alert")).textContent).toContain("No browser is available.");
  });
});

describe("owner deletion wiring", () => {
  it("deletes an inactive owned test organization by its own id without selecting it", async () => {
    const onDeleted = vi.fn();
    render(<OrganizationSettings organization={{ ...beta, role: "owner" }} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete organization…" }));
    fireEvent.change(screen.getByLabelText("Organization name to delete"), { target: { value: "Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete Beta permanently" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(mocks.deleteOrganization).toHaveBeenCalledWith({ organizationId: "b", contextRevision: "rev-1", confirmationName: "Beta" });
    expect(mocks.api.organizationSelect).not.toHaveBeenCalled();
  });
  it("protects personal organizations without hiding unrelated settings", () => {
    render(<OrganizationSettings organization={{ ...acme, isPersonal: true }} onDeleted={vi.fn()} />);
    expect(screen.getByText("Personal/default organizations cannot be deleted.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete organization…" })).toBeNull();
    expect(screen.getByTestId("section-teardown")).toBeTruthy();
  });
});
