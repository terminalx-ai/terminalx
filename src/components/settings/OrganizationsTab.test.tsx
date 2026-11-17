import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { SettingsPage } from "./SettingsPage";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { getCloudCatalog } from "@/lib/cloudCatalog";
import { api } from "@/lib/api";
import { onOpenCloudSetup } from "@/lib/cloudSetupFlow";
import { newSetup, saveSetup } from "@/lib/organizationSetup";

const mocks = vi.hoisted(() => ({ status: null as unknown as AccountStatus, ask: vi.fn(), refreshAccount: vi.fn(), signIn: vi.fn() }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: mocks.status }), subscribeAccount: () => () => {}, useAccount: () => ({ status: mocks.status, ready: true, busy: false }), refreshAccount: mocks.refreshAccount, signIn: mocks.signIn }));
vi.mock("@/lib/confirm", () => ({ confirmInApp: mocks.ask }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, organizationCreate: vi.fn() } };
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

describe("organization Settings", () => {
  it.each([false, true])("opens the full-window setup to create an organization, whatever the person belongs to (existing organizations: %s)", (existing) => {
    if (!existing) mocks.status = { ...mocks.status, identity: { name: "Ada", email: "ada@example.com", organization: null, organizationId: null }, organizations: [] };
    const opened: unknown[] = [];
    const stop = onOpenCloudSetup((target) => opened.push(target));
    mount();
    expect(screen.queryByText("No cloud-enabled organizations.") === null).toBe(existing);
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
    stop();
    expect(opened).toEqual([{ kind: "create" }]);
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
