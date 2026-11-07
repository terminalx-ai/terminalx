import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import type { AccountStatus, OrganizationSummary } from "@/lib/api";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Set<() => void>(), account: { status: {} as AccountStatus } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/account", () => ({ getAccount: () => mocks.account, useAccount: () => {
  useSyncExternalStore((fn) => { mocks.listeners.add(fn); return () => mocks.listeners.delete(fn); }, () => mocks.account.status);
  return mocks.account;
} }));
import { OrganizationWelcome } from "./OrganizationWelcome";
import { agentReadiness, dismissWelcome, welcomeDismissed } from "@/lib/organizationWelcome";
import { onOpenOrganizationSettings, openOwnModelRoutes, takeOrganizationRequest } from "@/lib/settingsLinks";
const org: OrganizationSummary = { id: "org", name: "Team", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } };
const status = (account = "one", orgs = [org]): AccountStatus => ({ state: "signed-in", context: { account, scope: account, revision: account }, identity: { name: "Member", email: "same@example.com", organization: "Team" }, organizations: orgs, expiresAt: null, lastError: null });
const changeAccount = (next: AccountStatus) => act(() => { mocks.account.status = next; for (const listener of mocks.listeners) listener(); });
const line = (name: string) => screen.getByText(name, { selector: "dt" }).nextElementSibling!;
beforeEach(() => {
  localStorage.clear(); mocks.account.status = status();
  mocks.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "cloud_workspace_repositories") return { configured: true, repositories: [{ state: "accessible", fullName: "team/allowed" }, { state: "installation-revoked", fullName: "team/revoked" }] };
    if (command === "cloud_providers") return { providers: [{ availability: "available" }] };
    if (command === "organization_members_in") return { members: [{ role: "admin", displayName: "Ada", email: "ada@example.com" }, { role: "owner", email: "owner@example.com" }, { role: "member", displayName: "Hidden member" }] };
    if (command === "cloud_workspace_preflight") return { ready: args.agent !== "codex", checks: [{ kind: "agent-credential", agent: args.agent, status: args.agent === "codex" ? "failed" : "verified" }] };
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); mocks.listeners.clear(); vi.restoreAllMocks(); takeOrganizationRequest(); });

describe("new member welcome", () => {
  it("reads actual authorized repositories, per-agent preflight, compute, and admins for the named organization", async () => {
    render(<OrganizationWelcome organization={org} />);
    expect(line("Codex").textContent).toBe("Checking…");
    await waitFor(() => expect(line("Codex").textContent).toBe("Not ready"));
    expect(line("Repositories").textContent).toBe("Ready · 1 accessible");
    expect(line("Claude Code").textContent).toBe("Ready"); expect(line("Cursor").textContent).toBe("Ready");
    expect(line("Compute").textContent).toBe("Ready"); expect(line("Admins").textContent).toBe("Ada, owner@example.com");
    expect(screen.queryByText("Hidden member")).toBeNull();
    expect(mocks.invoke.mock.calls).toEqual(expect.arrayContaining([
      ["cloud_workspace_preflight", { repositories: [], orgId: "org", agent: "cursor-agent" }], ["cloud_providers", { orgId: "org" }], ["organization_members_in", { orgId: "org" }],
    ]));
  });
  it("explains non-default compute discovery and reloads after deliberate selection in existing settings", async () => {
    const active = { ...org, id: "active", name: "Active team" };
    mocks.account.status = { ...status("one", [active, org]), multiOrg: true, identity: { name: "Member", email: "same@example.com", organization: active.name, organizationId: active.id } };
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "cloud_providers" && mocks.account.status.identity?.organizationId !== args.orgId) throw { code: "active_organization_required", status: 403 };
      return original(command, args);
    });
    const open = vi.fn(); const off = onOpenOrganizationSettings(open);
    render(<OrganizationWelcome organization={org} />);
    await waitFor(() => expect(line("Compute").textContent).toMatch(/Choose Team as your default organization in Settings/));
    expect(line("Compute").textContent).not.toMatch(/try refreshing/);
    fireEvent.click(screen.getByRole("button", { name: "Open organization settings" }));
    expect(open).toHaveBeenCalledWith("organizations.overview"); expect(takeOrganizationRequest()).toBe("org");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "organization_select")).toBe(false);
    changeAccount({ ...mocks.account.status, identity: { ...mocks.account.status.identity!, organizationId: "org", organization: "Team" }, context: { account: "one", scope: "one-org", revision: "one:2" } });
    await waitFor(() => expect(line("Compute").textContent).toBe("Ready"));
    off();
  });
  it("does not infer readiness from empty, missing, or other-agent preflight checks", () => {
    expect(agentReadiness({ ready: true, checks: [] }, "codex")).toBe("unknown");
    expect(agentReadiness({ ready: true, checks: [{ kind: "agent-credential", agent: "claude", status: "verified", cloneUrl: null, errorCode: null, retryable: false }] }, "codex")).toBe("unknown");
  });
  it("distinguishes unavailable from not ready and supports a fresh retry", async () => {
    mocks.invoke.mockRejectedValue({ code: "forbidden" });
    render(<OrganizationWelcome organization={org} />);
    await waitFor(() => expect(line("Compute").textContent).toMatch(/Unavailable/));
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "cloud_workspace_repositories") return { configured: false, repositories: [] };
      if (command === "cloud_providers") return { providers: [] };
      if (command === "organization_members_in") return { members: [] };
      return { ready: true, checks: [] };
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh readiness" }));
    await waitFor(() => expect(line("Compute").textContent).toBe("Not ready"));
    expect(line("Repositories").textContent).toBe("Not ready"); expect(line("Claude Code").textContent).toBe("Unknown"); expect(line("Admins").textContent).toBe("Unknown");
  });
  it("persists dismissal across unmount/reload and isolates accounts and organizations even with the same email", async () => {
    const view = render(<OrganizationWelcome organization={org} />);
    await waitFor(() => expect(line("Compute").textContent).toBe("Ready"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss welcome to Team" }));
    expect(screen.queryByTestId("organization-welcome")).toBeNull();
    view.unmount(); render(<OrganizationWelcome organization={org} />);
    expect(screen.queryByTestId("organization-welcome")).toBeNull();
    expect(welcomeDismissed("one", "org")).toBe(true); expect(welcomeDismissed("one", "other")).toBe(false);
    changeAccount(status("two")); await screen.findByTestId("organization-welcome");
    expect(welcomeDismissed("two", "org")).toBe(false);
    changeAccount(status("one")); expect(screen.queryByTestId("organization-welcome")).toBeNull();
  });
  it("keeps the card open when durable storage fails", async () => {
    render(<OrganizationWelcome organization={org} />); await waitFor(() => expect(line("Compute").textContent).toBe("Ready"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss welcome to Team" }));
    expect(screen.getByRole("alert").textContent).toMatch(/could not be saved/); expect(screen.getByTestId("organization-welcome")).toBeTruthy();
  });
  it("drops old readiness after account replacement and logout; stale dismiss/link actions cannot target the new account", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    mocks.invoke.mockImplementation((command) => command === "cloud_providers" ? pending : Promise.reject({ code: "forbidden" }));
    render(<OrganizationWelcome organization={org} />);
    changeAccount(status("two"));
    expect(line("Compute").textContent).toBe("Checking…");
    changeAccount({ state: "signed-out", identity: null, expiresAt: null, lastError: null });
    await act(async () => { finish({ providers: [{ availability: "available" }] }); });
    expect(screen.queryByTestId("organization-welcome")).toBeNull();
    expect(dismissWelcome("one", "org")).toBe(false); openOwnModelRoutes("org", "one"); expect(takeOrganizationRequest()).toBeUndefined();
  });
  it("opens the existing personal route setting for this organization and fences a queued link by account", async () => {
    const open = vi.fn(); const off = onOpenOrganizationSettings(open);
    render(<OrganizationWelcome organization={org} />); await waitFor(() => expect(line("Compute").textContent).toBe("Ready"));
    fireEvent.click(screen.getByRole("button", { name: "Use my own model route" }));
    expect(open).toHaveBeenCalledWith("organizations.agentRoutes"); expect(takeOrganizationRequest()).toBe("org");
    openOwnModelRoutes("org", "one"); changeAccount(status("two")); expect(takeOrganizationRequest()).toBeUndefined(); off();
  });
  it("shares dismissal between simultaneous sidebar and settings cards", async () => {
    render(<><OrganizationWelcome organization={org} /><OrganizationWelcome organization={org} /></>);
    await waitFor(() => expect(screen.getAllByText("Compute", { selector: "dt" })[0].nextElementSibling?.textContent).toBe("Ready"));
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "cloud_providers")).toHaveLength(1);
    fireEvent.click(within(screen.getAllByTestId("organization-welcome")[0]).getByRole("button", { name: "Dismiss welcome to Team" }));
    expect(screen.queryAllByTestId("organization-welcome")).toHaveLength(0);
  });
});
