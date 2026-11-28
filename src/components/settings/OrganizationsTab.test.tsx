import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/icons", () => new Proxy({}, { has: () => true, get: (_, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : prop === "__esModule" ? true : (props: Record<string, unknown>) => <svg {...props} />) }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: import("react").ReactNode }) => children,
  WithTooltip: ({ children }: { children: import("react").ReactNode }) => children,
  Tooltip: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipContent: () => null,
  Kbd: ({ children }: { children: import("react").ReactNode }) => <kbd data-slot="kbd">{children}</kbd>,
  KbdGroup: ({ keys }: { keys: string[] }) => <span data-slot="kbd">{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>,
}));
import type { AccountStatus } from "@/lib/api";
import { SettingsPage } from "./SettingsPage";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { getCloudCatalog } from "@/lib/cloudCatalog";
import { api } from "@/lib/api";
import { onOpenCloudSetup } from "@/lib/cloudSetupFlow";
import { newSetup, saveSetup } from "@/lib/organizationSetup";
import { openAgentLogins, openOrganizationSettings, takeAgentLoginsRequest, takeOrganizationRequest } from "@/lib/settingsLinks";

const mocks = vi.hoisted(() => ({ status: null as unknown as AccountStatus, ask: vi.fn(), refreshAccount: vi.fn(), signIn: vi.fn() }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: mocks.status }), subscribeAccount: () => () => {}, useAccount: () => ({ status: mocks.status, ready: true, busy: false }), refreshAccount: mocks.refreshAccount, signIn: mocks.signIn, deleteOrganization: vi.fn() }));
vi.mock("@/lib/confirm", () => ({ confirmInApp: mocks.ask }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, organizationCreate: vi.fn(), cloudAgentLogins: vi.fn(async () => ({ credentials: [] })) } };
});
vi.mock("./ProviderControls", () => ({ ProviderControls: () => <div>Provider setup</div> }));
vi.mock("./OrganizationSetupSteps", () => ({ OrganizationSetupSteps: ({ organizationId }: { organizationId: string }) => <div data-testid="setup-organization">{organizationId}</div> }));

beforeEach(() => {
  localStorage.clear();
  mocks.refreshAccount.mockReset().mockResolvedValue(undefined);
  mocks.signIn.mockReset();
  vi.mocked(api.organizationCreate).mockReset();
  mocks.ask.mockReset().mockResolvedValue(true);
  mocks.status = { state: "signed-in", identity: { name: "Ada", email: "ada@example.com", organization: "Acme", organizationId: "a" }, expiresAt: null, lastError: null, multiOrg: true, organizations: [
    { id: "a", name: "Acme", role: "owner", isPersonal: false, cloud: { enabled: true, flags: {} } },
    { id: "b", name: "Beta", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
  ] };
  setPrefs({ organizationDisplay: "all", hiddenOrganizations: [], selectedOrganization: null });
});
afterEach(cleanup);
const mount = () => render(<SettingsPage initialTab="organizations" onBack={vi.fn()} />);
/** The open page, without the menu beside it. */
const page = () => document.querySelector<HTMLElement>('[data-search-page="organizations"]')!;

describe("organization Settings", () => {
  it.each([false, true])("opens the full-window setup to create an organization, whatever the person belongs to (existing organizations: %s)", (existing) => {
    if (!existing) mocks.status = { ...mocks.status, identity: { name: "Ada", email: "ada@example.com", organization: null, organizationId: null }, organizations: [] };
    const opened: unknown[] = [];
    const stop = onOpenCloudSetup((target) => opened.push(target));
    mount();
    expect(screen.queryByText("No cloud-enabled organizations.") === null).toBe(existing);
    fireEvent.click(within(page()).getByRole("button", { name: "Create organization" }));
    // The menu's Create organization, at the end of its organizations (PRO-464), opens the same setup.
    fireEvent.click(within(screen.getByRole("group", { name: "Organizations" })).getByRole("button", { name: "Create organization" }));
    stop();
    expect(opened).toEqual([{ kind: "create" }, { kind: "create" }]);
    expect(api.organizationCreate).not.toHaveBeenCalled();
  });

  it("offers Finish setting up on an organization whose setup was left unfinished, and resumes it", () => {
    saveSetup("ada@example.com", { ...newSetup("Beta", "request-b"), organizationId: "b", step: "compute", flow: { step: "environment", passed: ["organization", "github"], finishedAt: null } });
    saveSetup("ada@example.com", { ...newSetup("Acme", "request-a"), organizationId: "a", step: "done", flow: { step: "invite", passed: [], finishedAt: 1 } });
    const opened: unknown[] = [];
    const stop = onOpenCloudSetup((target) => opened.push(target));
    mount();
    expect(screen.queryByRole("button", { name: "Finish setting up Acme" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up Beta" }));
    stop();
    expect(opened).toEqual([{ kind: "resume", organizationId: "b" }]);
  });

  it("offers sign-in before organization creation when signed out", () => {
    mocks.status = { state: "signed-out", identity: null, expiresAt: null, lastError: null };
    mount();
    expect(screen.queryByRole("textbox", { name: "Organization name" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to create an organization" }));
    expect(mocks.signIn).toHaveBeenCalledOnce();
    expect(api.organizationCreate).not.toHaveBeenCalled();
  });

  it("lists names, roles, running state, and Show in sidebar switches; Local has no hide switch", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Organizations" })).toBeTruthy();
    expect(screen.getByText("owner · No running workspaces")).toBeTruthy();
    expect(screen.getByText("member · No running workspaces")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /Local/ })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show Beta in sidebar" }));
    expect(getPrefs().hiddenOrganizations).toEqual(["b"]);
    expect(screen.getByRole("switch", { name: "Show Beta in sidebar" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: "Show Beta in sidebar" }));
    expect(getPrefs().hiddenOrganizations).toEqual([]);
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("defaults One to the default org, offers every org including hidden ones, and restores hide choices on All", () => {
    setPrefs({ hiddenOrganizations: ["a", "b"] });
    mount();
    const choices = within(screen.getByRole("radiogroup", { name: "Organizations in sidebar" }));
    fireEvent.click(choices.getByRole("radio", { name: "One organization" }));
    expect(getPrefs()).toMatchObject({ organizationDisplay: "one", selectedOrganization: "a" });
    const picker = screen.getByRole("combobox", { name: "Organization in sidebar" });
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Acme", "Beta"]);
    expect(screen.getAllByRole("switch").every((toggle) => toggle.hasAttribute("disabled"))).toBe(true);
    fireEvent.change(picker, { target: { value: "b" } });
    expect(getPrefs().selectedOrganization).toBe("b");
    fireEvent.click(choices.getByRole("radio", { name: "All organizations" }));
    expect(getPrefs()).toMatchObject({ organizationDisplay: "all", hiddenOrganizations: ["a", "b"] });
    expect(screen.queryByRole("combobox", { name: "Organization in sidebar" })).toBeNull();
    expect(screen.getAllByRole("switch").every((toggle) => !toggle.hasAttribute("disabled"))).toBe(true);
  });

  it("states the running count, waits for confirmation, and preserves visibility on cancellation", async () => {
    // A fresh quota may include machines this member cannot list individually.
    const catalog = getCloudCatalog();
    const quota = { used: 2, limit: 3, running: { used: 2, limit: 3 } };
    catalog.orgs.b = { orgId: "b", workspaces: [], repositories: null, repositoriesAt: null, quota, fetchedAt: 1, source: "live", error: null, sessions: {} };
    try {
      mocks.ask.mockResolvedValue(false);
      mount();
      expect(screen.getByText("member · 2 running workspaces")).toBeTruthy();
      fireEvent.click(screen.getByRole("switch", { name: "Show Beta in sidebar" }));
      await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
      expect(mocks.ask.mock.calls[0][0]).toMatchObject({ title: "Hide Beta?", body: expect.stringMatching(/2 running workspaces.*keep running and costing money/), action: "Hide organization" });
      expect(getPrefs().hiddenOrganizations).toEqual([]);
      mocks.ask.mockResolvedValue(true);
      fireEvent.click(screen.getByRole("switch", { name: "Show Beta in sidebar" }));
      await waitFor(() => expect(getPrefs().hiddenOrganizations).toEqual(["b"]));
      act(() => setPrefs({ hiddenOrganizations: [] }));
    } finally {
      delete catalog.orgs.b;
    }
  });
});

describe("Organizations in the Settings menu (PRO-464)", () => {
  const nav = () => within(screen.getByRole("navigation", { name: "Settings sections" }));
  const toggle = () => nav().getByRole("button", { name: /^Organizations/ });
  const organizations = () => within(nav().getByRole("group", { name: "Organizations" }));
  const pagesOf = (name: string) => within(nav().getByRole("group", { name: `${name} settings` })).getAllByRole("button").map((button) => button.textContent);
  const shown = () => document.querySelector<HTMLElement>("[data-testid=organization-settings]");
  const breadcrumb = () => screen.getByRole("navigation", { name: "Breadcrumb" }).textContent;
  beforeEach(() => {
    takeOrganizationRequest();
    takeAgentLoginsRequest("a");
    takeAgentLoginsRequest("b");
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("is one row with its count, closed when Settings opens; opened, it lists each organization with its role and its pages", () => {
    render(<SettingsPage onBack={vi.fn()} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toContain("2");
    expect(nav().queryByRole("button", { name: /^Acme/ })).toBeNull();
    fireEvent.click(toggle());
    expect(organizations().getAllByRole("button").map((button) => button.textContent)).toEqual(["All organizations", "AAcmeOwner", "BBetaMember", "Create organization"]);
    // An organization opens at its General page, listing the pages its role allows (design 11.16).
    fireEvent.click(organizations().getByRole("button", { name: /^Acme/ }));
    expect(organizations().getByRole("button", { name: /^Acme/ }).getAttribute("aria-expanded")).toBe("true");
    expect(pagesOf("Acme")).toEqual(["General", "Members", "Cloud compute", "Agent logins", "Model access", "GitHub", "Workspace settings", "Environment", "Diagnostics"]);
    expect(shown()?.dataset).toMatchObject({ organization: "a", organizationPage: "general" });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
    expect(screen.getByText("Acme · you are an owner")).toBeTruthy();
    expect(breadcrumb()).toBe("OrganizationsAcmeGeneral");
    fireEvent.click(within(nav().getByRole("group", { name: "Acme settings" })).getByRole("button", { name: "GitHub" }));
    expect(shown()?.dataset.organizationPage).toBe("github");
    expect(breadcrumb()).toBe("OrganizationsAcmeGitHub");
    // One organization at a time; a member of one that is not active has the pages they can use there.
    fireEvent.click(organizations().getByRole("button", { name: /^Beta/ }));
    expect(nav().queryByRole("group", { name: "Acme settings" })).toBeNull();
    expect(pagesOf("Beta")).toEqual(["General", "Agent logins", "Model access"]);
  });

  it("leads with All organizations, the list with each one's Show in sidebar switch", () => {
    render(<SettingsPage onBack={vi.fn()} />);
    fireEvent.click(toggle());
    fireEvent.click(organizations().getByRole("button", { name: /^Acme/ }));
    fireEvent.click(organizations().getByRole("button", { name: "All organizations" }));
    expect(shown()).toBeNull();
    expect(organizations().getByRole("button", { name: "All organizations" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Organizations");
    expect(screen.getByRole("radiogroup", { name: "Organizations in sidebar" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Show Beta in sidebar" })).toBeTruthy();
  });

  it("offers a member no search results for the pages their menu leaves out", () => {
    // Beta, a member there, is open: its managers' rows are not offered; its own are.
    render(<SettingsPage initialTab="organizations" onBack={vi.fn()} />);
    fireEvent.click(organizations().getByRole("button", { name: /^Beta/ }));
    const search = screen.getByRole("combobox", { name: "Search settings" });
    for (const [query, id] of [["members", "organizations.members"], ["github", "organizations.github"], ["compute limits", "organizations.compute"], ["workspace settings", "organizations.workspace"]]) {
      fireEvent.change(search, { target: { value: query } });
      expect(document.getElementById(`settings-result-${id}`)).toBeNull();
    }
    fireEvent.change(search, { target: { value: "model access" } });
    expect(document.getElementById("settings-result-organizations.agentRoutes")).toBeTruthy();
    // Acme, where the person is an owner, offers them all.
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(organizations().getByRole("button", { name: /^Acme/ }));
    for (const [query, id] of [["members", "organizations.members"], ["github", "organizations.github"], ["compute limits", "organizations.compute"], ["workspace settings", "organizations.workspace"]]) {
      fireEvent.change(search, { target: { value: query } });
      expect(document.getElementById(`settings-result-${id}`)).toBeTruthy();
    }
  });

  it("stays as the person left it until Settings closes", () => {
    const view = render(<SettingsPage onBack={vi.fn()} />);
    fireEvent.click(toggle());
    fireEvent.click(nav().getByRole("button", { name: "Appearance" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(organizations().getByRole("button", { name: /^Acme/ }));
    // Closed on an organization's page, it stays closed on that page and when another is chosen.
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(shown()?.dataset.organization).toBe("a");
    fireEvent.click(nav().getByRole("button", { name: "Account" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    view.unmount();
    render(<SettingsPage onBack={vi.fn()} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens its group and the organization a message asks for, at its agent logins, whether Settings was open or not", async () => {
    openAgentLogins("b");
    render(<SettingsPage initialTab="organizations.agentLogins" onBack={vi.fn()} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(organizations().getByRole("button", { name: /^Beta/ }).getAttribute("aria-expanded")).toBe("true");
    expect(shown()?.dataset).toMatchObject({ organization: "b", organizationPage: "agentLogins" });
    expect(within(nav().getByRole("group", { name: "Beta settings" })).getByRole("button", { name: "Agent logins" }).getAttribute("aria-current")).toBe("page");
    // Already open, on another section with the group closed: a message about Acme opens the group and Acme's page.
    fireEvent.click(toggle());
    fireEvent.click(nav().getByRole("button", { name: "General" }));
    act(() => openAgentLogins("a"));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(shown()?.dataset).toMatchObject({ organization: "a", organizationPage: "agentLogins" });
    await waitFor(() => expect(screen.getByTestId("agent-logins-title").textContent).toBe("Agent logins for Acme"));
    // A message naming no page opens the organization's General.
    act(() => openOrganizationSettings("b"));
    expect(shown()?.dataset).toMatchObject({ organization: "b", organizationPage: "general" });
  });

  it("opens the active organization when a message names none, and drops a request for one with no page here", () => {
    openAgentLogins(null);
    render(<SettingsPage initialTab="organizations.agentLogins" onBack={vi.fn()} />);
    expect(shown()?.dataset.organization).toBe("a");
    cleanup();
    openAgentLogins("org-left");
    render(<SettingsPage initialTab="organizations.agentLogins" onBack={vi.fn()} />);
    expect(shown()).toBeNull();
    expect(takeOrganizationRequest()).toBeUndefined();
    expect(takeAgentLoginsRequest("org-left")).toBe(false);
  });

  it("opens a row link, or a search result, on the organization already open, else the active one", () => {
    const view = render(<SettingsPage initialTab="organizations.github" openRequest={1} onBack={vi.fn()} />);
    expect(shown()?.dataset).toMatchObject({ organization: "a", organizationPage: "github" });
    expect(organizations().getByRole("button", { name: /^Acme/ }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(organizations().getByRole("button", { name: /^Beta/ }));
    view.rerender(<SettingsPage initialTab="organizations.agentRoutes" openRequest={2} onBack={vi.fn()} />);
    expect(shown()?.dataset).toMatchObject({ organization: "b", organizationPage: "modelAccess" });
    // Search finds every organization row while the group is closed.
    fireEvent.click(toggle());
    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), { target: { value: "agent logins" } });
    fireEvent.click(document.getElementById("settings-result-organizations.agentLogins")!);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(shown()?.dataset).toMatchObject({ organization: "b", organizationPage: "agentLogins" });
  });
});
