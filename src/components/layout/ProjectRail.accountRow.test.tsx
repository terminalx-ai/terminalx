import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  account: { ready: true, busy: false, status: { state: "signed-in", identity: { name: "Ada", email: "ada@example.test", organization: "Acme" }, lastError: null } } as Record<string, unknown>,
  relay: "connected",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));
vi.mock("@/lib/account", async (original) => ({ ...(await original<typeof import("@/lib/account")>()), useAccount: () => mocks.account }));
vi.mock("@/lib/pairing", async (original) => ({ ...(await original<typeof import("@/lib/pairing")>()), usePairing: () => ({ status: { relay: { phase: mocks.relay } } }) }));
vi.mock("@/components/account/AccountAvatar", () => ({ AccountAvatar: () => <span data-testid="avatar" /> }));

const { ProjectRail } = await import("./ProjectRail");
const store = await import("@/lib/sessions");

const onOpenSettings = vi.fn();
const onOpenAccount = vi.fn();
const noop = () => {};
const mount = () =>
  render(
    <TooltipProvider>
      <ProjectRail onOpenSettings={onOpenSettings} onOpenAccount={onOpenAccount} onOpenIssues={noop} onOpenAgents={noop} onOpenStats={noop} onOpenAutomations={noop} onOpenSkills={noop} onSearch={noop} />
    </TooltipProvider>,
  );
const row = () => screen.getByTestId("sidebar-account-row");

beforeEach(async () => {
  onOpenSettings.mockClear();
  onOpenAccount.mockClear();
  mocks.relay = "connected";
  mocks.account = { ready: true, busy: false, status: { state: "signed-in", identity: { name: "Ada", email: "ada@example.test", organization: "Acme" }, lastError: null } };
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects: [{ path: "/alpha", name: "Alpha" }], lastSelected: "/alpha" };
    if (command === "list_sessions" || command === "list_workspaces" || command === "list_harnesses") return [];
    return undefined;
  });
  await act(async () => {
    await store.bootSessions();
  });
});
afterEach(cleanup);

// PRO-49: Settings was a full row of its own under the account entry.
describe("the sidebar's account row", () => {
  it("is one row: the account, its relay status, then the Settings gear at the right end", () => {
    mount();
    const buttons = within(row()).getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).toContain("Ada");
    expect(buttons[0]!.textContent).toContain("Relay connected");
    // The gear is icon-only, named for assistive technology, and the last thing in the row.
    const gear = within(row()).getByRole("button", { name: "Settings" });
    expect(gear).toBe(buttons[1]);
    expect(gear.textContent).toBe("");
    expect(row().lastElementChild).toBe(gear);
    // No Settings row of its own is left anywhere in the sidebar.
    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1);
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("keeps the two targets apart: the account opens Account, the gear opens Settings", () => {
    mount();
    fireEvent.click(within(row()).getByRole("button", { name: /Ada/ }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
    fireEvent.click(within(row()).getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    // The general way in names no section (the click's event is not passed along).
    expect(onOpenSettings).toHaveBeenCalledWith();
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it("gives a long name and status the ellipsis, never the gear's room", () => {
    mocks.relay = "idle";
    mocks.account = { ready: true, busy: false, status: { state: "signed-in", identity: { name: "Bartholomew Maximilian Featherstonehaugh-Cholmondeley III", email: "b@example.test" }, lastError: null } };
    mount();
    const name = within(row()).getByText(/Bartholomew/);
    expect(name.className).toContain("truncate");
    expect(within(row()).getByText("Relay not configured").className).toContain("truncate");
    // The account side may shrink (min-w-0) and clips; the gear may not.
    const account = within(row()).getByRole("button", { name: /Bartholomew/ });
    expect(account.parentElement!.className).toContain("min-w-0");
    expect(account.className).toContain("overflow-hidden");
    expect(within(row()).getByRole("button", { name: "Settings" }).className).toContain("shrink-0");
    expect(row().className).not.toContain("flex-wrap");
  });

  it("keeps the gear next to Sign in when nobody is signed in", () => {
    mocks.account = { ready: true, busy: false, status: { state: "signed-out", identity: null, lastError: null } };
    mount();
    expect(within(row()).getByRole("button", { name: "Sign in" })).toBeTruthy();
    fireEvent.click(within(row()).getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
