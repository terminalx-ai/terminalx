import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type AgentLogin } from "@/lib/api";
import { OrganizationAgentLogins } from "./OrganizationAgentLogins";

vi.mock("@/lib/api", () => ({
  api: {
    cloudAgentLogins: vi.fn(),
    cloudAgentLoginConnect: vi.fn(),
    cloudAgentLoginRemove: vi.fn(),
  },
}));

let stored: AgentLogin[];
const login = (fields: Partial<AgentLogin>): AgentLogin => ({ provider: "claude", authKind: "oauth-credentials-json", fingerprint: "sha256:ab", version: 1, updatedAt: 1_790_000_000_000, state: "connected", sharedUse: "organization", ...fields });
const row = (agent: string) => screen.getAllByTestId("agent-login").find((item) => item.dataset.agent === agent)!;
const show = async () => {
  render(<OrganizationAgentLogins contextRevision="org-revision" />);
  await screen.findAllByTestId("agent-login");
};
const consent = (within_: HTMLElement) => within(within_).getAllByRole("checkbox").forEach((box) => fireEvent.click(box));

beforeEach(() => {
  vi.clearAllMocks();
  stored = [];
  vi.mocked(api.cloudAgentLogins).mockImplementation(async () => ({ credentials: structuredClone(stored) }));
});
afterEach(cleanup);

describe("agent logins in Settings (PRO-79)", () => {
  it("lists each agent with its status, and what a member sees instead", async () => {
    stored = [login({ displayIdentity: "ada@example.com" }), login({ provider: "codex", authKind: "api-key", state: "revoked" })];
    await show();
    expect(within(row("claude")).getByTestId("agent-login-status").textContent).toMatch(/^Connected · subscription login · ada@example\.com · updated /);
    expect(within(row("codex")).getByTestId("agent-login-status").textContent).toMatch(/^Revoked \(API key\)/);
    expect(within(row("cursor")).getByTestId("agent-login-status").textContent).toBe("Not connected");
    // Cursor has no login on this Mac to offer; a connected agent can be disconnected, a missing one cannot.
    expect(within(row("cursor")).queryByRole("button", { name: /this Mac/ })).toBeNull();
    expect(within(row("cursor")).queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(within(row("claude")).getByRole("button", { name: "Disconnect" })).toBeTruthy();
    cleanup();

    vi.mocked(api.cloudAgentLogins).mockRejectedValue({ code: "organization_admin_required" });
    render(<OrganizationAgentLogins contextRevision="org-revision" />);
    expect((await screen.findByTestId("agent-logins-member")).textContent).toMatch(/owners and administrators connect agent logins/);
    expect(screen.queryAllByTestId("agent-login")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stores this Mac's Claude login only after both consents, and never holds the login itself", async () => {
    vi.mocked(api.cloudAgentLoginConnect).mockImplementation(async () => {
      stored = [login({})];
      return stored[0]!;
    });
    await show();
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Use this Mac's Claude Code login" }));
    const panel = within(row("claude")).getByTestId("agent-login-consent");
    // What is shared, who can use it, how to revoke it.
    expect(panel.textContent).toContain("read the Claude Code login that is on this Mac");
    expect(panel.textContent).toContain("every member's cloud workspaces");
    expect(panel.textContent).toContain("To revoke it, press Disconnect here");
    const go = within(panel).getByRole("button", { name: "Read and store this Mac's login" });
    expect(go.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(panel).getAllByRole("checkbox")[0]!);
    expect(go.hasAttribute("disabled")).toBe(true);
    expect(api.cloudAgentLoginConnect).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getAllByRole("checkbox")[1]!);
    fireEvent.click(go);
    await waitFor(() => expect(screen.getByTestId("agent-logins-notice").textContent).toContain("Claude Code is connected"));
    // The page names the source and the consent; the login is read by the app, not passed through here.
    expect(api.cloudAgentLoginConnect).toHaveBeenCalledWith("claude", "local-login", { contextRevision: "org-revision", organizationSharing: true, machineInstallation: true });
    expect(within(row("claude")).getByTestId("agent-login-status").textContent).toMatch(/^Connected/);
    expect(document.querySelector('input[type="text"], input[type="password"], textarea')).toBeNull();
  });

  it("connects with an API key through the secure dialog, and a second open starts unconsented", async () => {
    vi.mocked(api.cloudAgentLoginConnect).mockRejectedValueOnce({ code: "cloud_provider_entry_cancelled" });
    await show();
    fireEvent.click(within(row("cursor")).getByRole("button", { name: "Connect with an API key" }));
    consent(within(row("cursor")).getByTestId("agent-login-consent"));
    fireEvent.click(within(row("cursor")).getByRole("button", { name: "Enter the key" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Key entry canceled");
    expect(api.cloudAgentLoginConnect).toHaveBeenCalledWith("cursor", "api-key", expect.objectContaining({ organizationSharing: true, machineInstallation: true }));
    // The consent does not carry over to the next try.
    await waitFor(() => expect(within(row("cursor")).getByRole("button", { name: "Enter the key" }).hasAttribute("disabled")).toBe(true));
  });

  it("says in words why a login was not stored", async () => {
    await show();
    const failWith = async (code: string, text: RegExp) => {
      vi.mocked(api.cloudAgentLoginConnect).mockRejectedValueOnce({ code });
      fireEvent.click(within(row("codex")).getByRole("button", { name: "Use this Mac's Codex login" }));
      consent(within(row("codex")).getByTestId("agent-login-consent"));
      fireEvent.click(within(row("codex")).getByRole("button", { name: "Read and store this Mac's login" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(text));
    };
    await failWith("cloud_agent_local_login_not_found", /No login for this agent was found on this Mac/);
    await failWith("cloud_agent_local_login_denied", /access to it was not allowed\. Nothing was sent/);
    await failWith("cloud_workspace_credential_invalid", /provider did not accept that login/);
    await failWith("organization_admin_required", /Only an organization owner or administrator/);
    await failWith("something_new", /could not be confirmed/);
    expect(screen.getByRole("alert").textContent).not.toContain("something_new");
  });

  it("disconnects only after the confirmation, for the organization on screen", async () => {
    stored = [login({})];
    vi.mocked(api.cloudAgentLoginRemove).mockImplementation(async () => {
      stored = [];
    });
    await show();
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Disconnect" }));
    expect(api.cloudAgentLoginRemove).not.toHaveBeenCalled();
    const confirm = within(row("claude")).getByTestId("agent-login-disconnect");
    expect(confirm.textContent).toContain("Workspaces stop receiving this login at once");
    fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect Claude Code" }));
    await waitFor(() => expect(within(row("claude")).getByTestId("agent-login-status").textContent).toBe("Not connected"));
    expect(api.cloudAgentLoginRemove).toHaveBeenCalledWith("claude", "org-revision");
  });
});
