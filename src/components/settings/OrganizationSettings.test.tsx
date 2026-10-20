import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, AgentLogin, OrganizationSummary } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  status: null as unknown as AccountStatus,
  refreshAccount: vi.fn(async () => {}),
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

const { OrganizationSettings } = await import("./OrganizationSettings");
const { OrganizationsTab } = await import("./OrganizationsTab");
const { openAgentLogins, takeAgentLoginsRequest, takeOrganizationRequest } = await import("@/lib/settingsLinks");

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

describe("an organization's settings page (PRO-107)", () => {
  it("changes a non-active organization's agent logins by its id, and leaves the active one's alone", async () => {
    render(<OrganizationSettings organization={beta} onBack={vi.fn()} />);
    expect(screen.getByTestId("organization-settings-name").textContent).toBe("Beta");
    expect(screen.getByTestId("organization-settings").textContent).toContain("You are an administrator of Beta. It is not your default organization. What you change on this page applies to Beta only.");
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

    // The settings the service keeps on the active organization are not shown for B; the way to them is.
    expect(screen.queryByTestId("section-members")).toBeNull();
    expect(screen.queryByText("Cloud diagnostics")).toBeNull();
    expect(screen.getByTestId("organization-settings-inactive").textContent).toContain("Members, compute, GitHub, workspace settings, environment, diagnostics and teardown of Beta are changed while it is your default organization.");
  });

  it("makes it the active organization only when asked", async () => {
    mocks.api.organizationSelect.mockResolvedValue(mocks.status);
    render(<OrganizationSettings organization={beta} onBack={vi.fn()} />);
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
    render(<OrganizationSettings organization={{ ...beta, role: "member" }} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-login-member-status")).toHaveLength(3));
    expect(mocks.api.cloudWorkspacePreflight).toHaveBeenCalledWith([], "b", "codex");
    expect(screen.getByTestId("organization-settings").textContent).toContain("You are a member of Beta.");
    expect(screen.queryByRole("button", { name: /Connect|Log in|Disconnect|Replace/ })).toBeNull();
  });

  it("holds every section of the active organization, agent logins among them", async () => {
    render(<OrganizationSettings organization={acme} onBack={vi.fn()} />);
    expect(screen.getByTestId("organization-settings").textContent).toContain("You are an owner of Acme. It is your default organization.");
    for (const section of ["members", "compute", "github", "config", "environment", "teardown"]) expect(screen.getByTestId(`section-${section}`)).toBeTruthy();
    expect(screen.queryByTestId("organization-settings-inactive")).toBeNull();
    await screen.findAllByTestId("agent-login");
    expect(screen.getByTestId("agent-logins-title").textContent).toBe("Agent logins for Acme");
    expect(mocks.api.cloudAgentLogins).toHaveBeenCalledWith("a");
    // Diagnostics are for owners and administrators (moved here from Settings → Account).
    expect(screen.getByText("Cloud diagnostics")).toBeTruthy();
    await waitFor(() => expect(mocks.api.cloudDiagnostics).toHaveBeenCalledWith(7, null));
  });

  it("has the organization's work status for its owners and administrators, active or not (#441)", async () => {
    render(<OrganizationSettings organization={beta} onBack={vi.fn()} />);
    const share = await screen.findByRole("switch", { name: "Share work status in Beta" });
    expect(mocks.workStatus.organization).toHaveBeenCalledWith("b");
    expect(screen.getByTestId("organization-settings-inactive").textContent).toContain("Its agent logins and work status above are changed as it is.");
    fireEvent.click(share);
    await waitFor(() => expect(mocks.workStatus.setOrganization).toHaveBeenCalledWith("b", { shareWorkStatus: false }));
    expect(mocks.api.organizationSelect).not.toHaveBeenCalled();
    cleanup();

    render(<OrganizationSettings organization={acme} onBack={vi.fn()} />);
    expect(await screen.findByRole("switch", { name: "Share work status in Acme" })).toBeTruthy();
    cleanup();

    // A member is shown no organization switch, and nothing is asked for it.
    mocks.workStatus.organization.mockClear();
    render(<OrganizationSettings organization={{ ...beta, role: "member" }} onBack={vi.fn()} />);
    expect(screen.getByTestId("organization-settings").dataset.organization).toBe("b");
    expect(screen.queryByTestId("organization-work-status")).toBeNull();
    expect(mocks.workStatus.organization).not.toHaveBeenCalled();
    expect(screen.getByTestId("organization-settings-inactive").textContent).toContain("Its agent logins above are changed as it is.");
  });

  it("asks a member of the active organization for no diagnostics", async () => {
    render(<OrganizationSettings organization={{ ...acme, role: "member" }} onBack={vi.fn()} />);
    expect(await screen.findByText(/Only organization owners and administrators/)).toBeTruthy();
    expect(mocks.api.cloudConnectionDiagnostics).toHaveBeenCalled();
    expect(mocks.api.cloudDiagnostics).not.toHaveBeenCalled();
  });
});

describe("Settings → Organizations opens each organization's page (PRO-107)", () => {
  it("from its row, and back to the list", async () => {
    render(<OrganizationsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Settings for Beta" }));
    expect(screen.getByTestId("organization-settings").dataset.organization).toBe("b");
    fireEvent.click(screen.getByRole("button", { name: /All organizations/ }));
    expect(screen.queryByTestId("organization-settings")).toBeNull();
    expect(screen.getByRole("button", { name: "Settings for Acme" })).toBeTruthy();
  });

  it("at the organization a message asked for, with its agent logins in view, whether the section was open or not", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    openAgentLogins("b");
    render(<OrganizationsTab />);
    expect((await screen.findByTestId("organization-settings")).dataset.organization).toBe("b");
    await screen.findAllByTestId("agent-login");
    expect(scrolled.mock.contexts.at(-1)).toBe(screen.getByTestId("agent-logins"));
    expect(screen.getByTestId("agent-logins-title").textContent).toBe("Agent logins for Beta");

    // Already open on Beta's page: a message about Acme opens Acme's.
    openAgentLogins("a");
    await waitFor(() => expect(screen.getByTestId("organization-settings").dataset.organization).toBe("a"));
    await waitFor(() => expect(screen.getByTestId("agent-logins-title").textContent).toBe("Agent logins for Acme"));
  });

  it("drops a request for an organization with no page here, so a page opened later by hand is not scrolled", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    // An organization this account is not a member of (any more).
    openAgentLogins("org-left");
    render(<OrganizationsTab />);
    await waitFor(() => expect(takeOrganizationRequest()).toBeUndefined());
    expect(screen.queryByTestId("organization-settings")).toBeNull();
    expect(takeAgentLoginsRequest("org-left")).toBe(false);
    cleanup();

    // No organization named and no default one: the request names no page, and no later page takes it.
    mocks.status = { ...mocks.status, identity: { ...mocks.status.identity!, organization: null, organizationId: null } } as AccountStatus;
    openAgentLogins(null);
    render(<OrganizationsTab />);
    await waitFor(() => expect(takeOrganizationRequest()).toBeUndefined());
    expect(takeAgentLoginsRequest("b")).toBe(false);
    openAgentLogins(null);
    await waitFor(() => expect(takeOrganizationRequest()).toBeUndefined());
    fireEvent.click(screen.getByRole("button", { name: "Settings for Beta" }));
    await screen.findAllByTestId("agent-login");
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("at the active organization when the message named none", async () => {
    openAgentLogins(null);
    render(<OrganizationsTab />);
    expect((await screen.findByTestId("organization-settings")).dataset.organization).toBe("a");
  });
});
