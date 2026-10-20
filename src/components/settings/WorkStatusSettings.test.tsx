import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { OrganizationWorkStatusSettings, WorkStatusSettings } = await import("./WorkStatusSettings");

let organizationShares = true;
let linearWorkspaces: string[] = [];

beforeEach(() => {
  organizationShares = true;
  linearWorkspaces = [];
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "work_status_settings":
        return { shareWithTeam: true };
      case "set_work_status_settings":
        return { shareWithTeam: args.shareWithTeam };
      case "organization_work_status":
        return { shareWorkStatus: organizationShares, canManage: true, personal: false, linearWorkspaces };
      case "set_organization_work_status": {
        const patch = args.patch as { shareWorkStatus?: boolean; linearWorkspaces?: string[] };
        organizationShares = patch.shareWorkStatus ?? organizationShares;
        linearWorkspaces = patch.linearWorkspaces ?? linearWorkspaces;
        return { shareWorkStatus: organizationShares, canManage: true, personal: false, linearWorkspaces };
      }
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(cleanup);

const organizations = [
  { id: "org-admin", name: "Acme", role: "admin" },
  { id: "org-member", name: "Other", role: "member" },
  { id: "org-personal", name: "Me", role: "owner", isPersonal: true },
];

describe("work status settings", () => {
  it("turns off sharing with the team, which the publisher reads", async () => {
    render(<WorkStatusSettings />);
    const share = await screen.findByRole("switch", { name: "Show my team what I’m working on" });
    await waitFor(() => expect(share.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(share);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_work_status_settings", { shareWithTeam: false }));
    await waitFor(() => expect(share.getAttribute("aria-checked")).toBe("false"));
    // An organization's own switches are on its page in Settings → Organizations (PRO-107).
    expect(invoke.mock.calls.some(([command]) => command === "organization_work_status")).toBe(false);
  });

  it("gives an admin the organization's switch, and nobody else", async () => {
    render(
      <>
        {organizations.map((organization) => (
          <OrganizationWorkStatusSettings key={organization.id} organization={organization} />
        ))}
      </>,
    );
    const org = await screen.findByRole("switch", { name: "Share work status in Acme" });
    expect(screen.queryByRole("switch", { name: "Share work status in Other" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Share work status in Me" })).toBeNull();
    expect(invoke.mock.calls.filter(([command]) => command === "organization_work_status")).toEqual([["organization_work_status", { orgId: "org-admin" }]]);
    // The organization's Linear workspaces, as the admin names them.
    const field = screen.getByRole("textbox", { name: "Linear workspaces of Acme" });
    fireEvent.change(field, { target: { value: "not a key!" } });
    expect(screen.getByRole("alert").textContent).toMatch(/after linear.app/);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Acme, https://linear.app/other-co/issue/ENG-1, acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_organization_work_status", { orgId: "org-admin", patch: { linearWorkspaces: ["acme", "other-co"] } }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Linear workspaces of Acme" }) as HTMLInputElement).value).toBe("acme, other-co"));
    fireEvent.click(org);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_organization_work_status", { orgId: "org-admin", patch: { shareWorkStatus: false } }));
    await waitFor(() => expect(org.getAttribute("aria-checked")).toBe("false"));
    // Off, there are no workspaces to name.
    expect(screen.queryByRole("textbox", { name: "Linear workspaces of Acme" })).toBeNull();
  });
});
