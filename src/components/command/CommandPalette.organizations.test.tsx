import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => null),
  roster: vi.fn(async () => ({ members: [{}, {}] })),
  status: null as unknown as AccountStatus,
  enabled: true,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/lib/organizationVisibilityGate", () => ({
  organizationSwitchingEnabled: () => mocks.enabled,
  useOrganizationSwitchingEnabled: () => mocks.enabled,
}));
vi.mock("@/lib/organizationRoster", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/organizationRoster")>(),
  readOrganizationRoster: mocks.roster,
}));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status }),
  getAccount: () => ({ status: mocks.status }),
  subscribeAccount: () => () => {},
}));

const { CommandPalette } = await import("./CommandPalette");
const { getPrefs, setPrefs } = await import("@/lib/prefs");
const { ONLY_THIS_MAC, organizationVisibility } = await import("@/lib/organizationVisibility");
const { getSessionStore, selectCloudSession, selectSession } = await import("@/lib/sessions");
const { takeOrganizationRequest } = await import("@/lib/settingsLinks");

const account: AccountStatus = {
  state: "signed-in",
  identity: { name: "Alice", email: "alice@example.com", organization: "Beta", organizationId: "b" },
  expiresAt: null,
  lastError: null,
  multiOrg: true,
  organizations: [
    { id: "a", name: "Acme", role: "member", cloud: { enabled: true, flags: {} } },
    { id: "c", name: "Community", role: "member" },
    { id: "b", name: "Beta", role: "owner", cloud: { enabled: true, flags: {} } },
  ],
};

beforeEach(() => {
  mocks.enabled = true;
  mocks.status = account;
  mocks.invoke.mockClear();
  mocks.roster.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  setPrefs({ organizationDisplay: "all", selectedOrganization: null, hiddenOrganizations: ["a"], shortcuts: {} });
  selectSession(null);
});

afterEach(cleanup);

function mount(query = "switch") {
  const settings = vi.fn();
  const close = vi.fn();
  render(<CommandPalette open onOpenChange={close} onOpenSettings={settings} onCreated={vi.fn()} />);
  const field = screen.getByRole("textbox", { name: "Command palette search" });
  fireEvent.change(field, { target: { value: query } });
  return { field, settings, close };
}

describe("organization switching from the palette", () => {
  it("lists every membership in shortcut order and changes the current row on Enter", async () => {
    const { field, close } = mount();
    const group = await screen.findByRole("group", { name: "Organizations" });
    const rows = within(group).getAllByRole("option");
    expect(rows.map((row) => row.id)).toEqual(["palette:organization:b", "palette:organization:a", "palette:organization:c", `palette:organization:${ONLY_THIS_MAC}`]);
    expect(rows[0].getAttribute("aria-current")).toBe("true");
    expect(rows[3].textContent).toContain("Local sessions, nothing shared");
    await waitFor(() => expect(rows[1].textContent).toContain("2 members"));
    expect(screen.getByRole("status").textContent).toContain("No sessions on the server match");

    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect(listedIds()).toEqual(["a"]);
    expect(getPrefs().hiddenOrganizations).toEqual(["a"]);
    expect(close).not.toHaveBeenCalled();

    fireEvent.click(rows[2]);
    expect(rows[2].getAttribute("aria-current")).toBe("true");
    expect(listedIds()).toEqual(["c"]);
  });

  it("hides all sidebar organizations for Only this Mac even with an open cloud session", async () => {
    act(() => selectCloudSession("cloud:b:workspace:session"));
    mount();
    fireEvent.click(await screen.findByRole("option", { name: /Only this Mac/ }));
    expect(getPrefs().selectedOrganization).toBe(ONLY_THIS_MAC);
    expect(getSessionStore().selectedSessionId).toBe("cloud:b:workspace:session");
    expect(listedIds()).toEqual([]);
    expect(screen.getByRole("status").textContent).toContain("No sessions on this Mac match");
    expect(mocks.invoke.mock.calls.flat().join(" ")).not.toMatch(/cloud_workspace_resume|stop_tab|cloud_remote_attach|organization_select/);
  });

  it("searches the Organizations tab and opens the existing Settings destinations", async () => {
    const { field, settings } = mount("");
    fireEvent.click(screen.getByRole("tab", { name: "Organizations" }));
    fireEvent.change(field, { target: { value: "acme" } });
    const group = await screen.findByRole("group", { name: "Organizations" });
    expect(within(group).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(within(group).getByRole("option", { name: /Switch to Acme/ }));
    fireEvent.click(screen.getByRole("option", { name: "Organization settings" }));
    await waitFor(() => expect(takeOrganizationRequest()).toBe("a"));
    fireEvent.click(screen.getByRole("option", { name: "Create organization…" }));
    await waitFor(() => expect(settings).toHaveBeenCalledWith("organizations.create"));
  });

  it.each(["signed out", "feature off"])("omits switching rows and tab when %s", async (caseName) => {
    if (caseName === "signed out") mocks.status = { ...account, state: "signed-out", identity: null };
    else mocks.enabled = false;
    mount();
    expect(screen.queryByRole("tab", { name: "Organizations" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Organizations" })).toBeNull();
    expect(screen.queryByRole("option", { name: /Only this Mac/ })).toBeNull();
    expect(mocks.roster).not.toHaveBeenCalled();
  });
});

function listedIds() {
  return organizationVisibility(mocks.status, getPrefs(), getSessionStore().selectedSessionId, true).orgs.map(({ id }) => id);
}
