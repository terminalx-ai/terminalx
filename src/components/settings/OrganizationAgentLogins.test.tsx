import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type AgentLogin } from "@/lib/api";
import { agentLoginReach, agentLoginStatus, connectedNotice, lentUntil, OrganizationAgentLogins, signInOutcome } from "./OrganizationAgentLogins";

vi.mock("@/lib/api", () => ({
  api: {
    cloudAgentLogins: vi.fn(),
    cloudAgentLoginConnect: vi.fn(),
    cloudAgentLoginRemove: vi.fn(),
    cloudAgentClaudeLoginStart: vi.fn(),
    cloudAgentClaudeLoginOpen: vi.fn(),
    cloudAgentClaudeLoginComplete: vi.fn(),
    cloudAgentClaudeLoginCancel: vi.fn(),
  },
}));

let stored: AgentLogin[];
const login = (fields: Partial<AgentLogin>): AgentLogin => ({ provider: "claude", authKind: "oauth-credentials-json", fingerprint: "sha256:ab", version: 1, updatedAt: 1_790_000_000_000, state: "connected", sharedUse: "organization", ...fields });
const row = (agent: string) => screen.getAllByTestId("agent-login").find((item) => item.dataset.agent === agent)!;
const show = async () => {
  render(<OrganizationAgentLogins contextRevision="org-revision" organizationName="Acme Robotics" />);
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
    // Only Claude Code's sign-in can be lent from this Mac (Codex's cannot be used without its refresh token).
    expect(within(row("cursor")).queryByRole("button", { name: /this Mac/ })).toBeNull();
    expect(within(row("codex")).queryByRole("button", { name: /this Mac/ })).toBeNull();
    // A stored login is replaced, and the button says so.
    expect(within(row("claude")).getByRole("button", { name: "Replace with this Mac's Claude Code sign-in (temporary)" })).toBeTruthy();
    expect(within(row("cursor")).queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(within(row("claude")).getByRole("button", { name: "Disconnect" })).toBeTruthy();
    cleanup();

    vi.mocked(api.cloudAgentLogins).mockRejectedValue({ code: "organization_admin_required" });
    render(<OrganizationAgentLogins contextRevision="org-revision" />);
    expect((await screen.findByTestId("agent-logins-member")).textContent).toMatch(/owners and administrators connect agent logins/);
    expect(screen.queryAllByTestId("agent-login")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks to lend this Mac's Claude sign-in only after both consents, says what that means, and never holds the login itself", async () => {
    vi.mocked(api.cloudAgentLoginConnect).mockImplementation(async () => {
      stored = [login({})];
      return stored[0]!;
    });
    await show();
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Lend this Mac's Claude Code sign-in (temporary)" }));
    const panel = within(row("claude")).getByTestId("agent-login-consent");
    // Nothing is stored yet: there is nothing to replace and no such choice.
    expect(within(panel).queryByTestId("agent-login-replace")).toBeNull();
    // What is shared, who can use it, how to revoke it.
    expect(panel.textContent).toContain("lend its short-lived access token to Acme Robotics");
    expect(panel.textContent).toContain("The refresh token stays on this Mac");
    expect(panel.textContent).toContain("a confirmation from the app names the organization, the account and the expiry");
    expect(panel.textContent).toContain("every member's cloud workspaces of Acme Robotics");
    expect(panel.textContent).toContain("anyone who can drive a workspace can read it");
    // The revoke promise is the true one: the service can refuse.
    expect(panel.textContent).toContain("The service refuses while a workspace of the organization still uses the login");
    expect(panel.textContent).not.toMatch(/stop receiving it at once|does not change the login/);
    const go = within(panel).getByRole("button", { name: "Read this Mac's sign-in and confirm" });
    expect(go.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(panel).getAllByRole("checkbox")[0]!);
    expect(go.hasAttribute("disabled")).toBe(true);
    expect(api.cloudAgentLoginConnect).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getAllByRole("checkbox")[1]!);
    fireEvent.click(go);
    await waitFor(() => expect(screen.getByTestId("agent-logins-notice").textContent).toContain("Claude Code is connected"));
    // The page names the source and the consent; the login is read by the app, not passed through here.
    expect(api.cloudAgentLoginConnect).toHaveBeenCalledWith("claude", "local-login", { contextRevision: "org-revision", organizationSharing: true, machineInstallation: true, replaceExisting: false });
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
      fireEvent.click(within(row("claude")).getByRole("button", { name: "Lend this Mac's Claude Code sign-in (temporary)" }));
      consent(within(row("claude")).getByTestId("agent-login-consent"));
      fireEvent.click(within(row("claude")).getByRole("button", { name: "Read this Mac's sign-in and confirm" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(text));
    };
    await failWith("cloud_agent_local_login_not_found", /No login for this agent was found on this Mac/);
    await failWith("cloud_agent_local_login_denied", /access to it was not allowed\. Nothing was sent/);
    await failWith("cloud_agent_local_login_cancelled", /Canceled in the confirmation\. Nothing was sent/);
    await failWith("cloud_agent_local_login_expired", /has expired or is about to/);
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
    expect(confirm.textContent).toContain("The service refuses while a workspace of the organization still uses the login");
    fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect Claude Code" }));
    await waitFor(() => expect(within(row("claude")).getByTestId("agent-login-status").textContent).toBe("Not connected"));
    expect(api.cloudAgentLoginRemove).toHaveBeenCalledWith("claude", "org-revision");
  });

  it("says why a disconnect was refused while a workspace still uses the login, and keeps it listed", async () => {
    stored = [login({ displayIdentity: "ada@example.com" })];
    vi.mocked(api.cloudAgentLoginRemove).mockRejectedValue({ code: "cloud_workspace_credential_in_use" });
    await show();
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Disconnect Claude Code" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/still uses it\. Delete or archive those workspaces first, or revoke the login in the web console/);
    expect(within(row("claude")).getByTestId("agent-login-status").textContent).toMatch(/^Connected/);
  });

  // Review of #293: lending a sign-in silently replaced a working API key.
  it("replaces a stored login only by an explicit choice that says what stops working", async () => {
    stored = [login({ authKind: "api-key" })];
    vi.mocked(api.cloudAgentLoginConnect).mockResolvedValue(login({}));
    await show();
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Replace with this Mac's Claude Code sign-in (temporary)" }));
    const panel = within(row("claude")).getByTestId("agent-login-consent");
    const choice = within(panel).getByTestId("agent-login-replace");
    expect(choice.textContent).toContain("Replace the API key now stored for Claude Code.");
    expect(choice.textContent).toContain("When the lent sign-in expires, Claude Code agents in every workspace of Acme Robotics stop until a login is connected again.");
    const go = within(panel).getByRole("button", { name: "Read this Mac's sign-in and confirm" });
    // Both consents without the replace choice: still not enough.
    const boxes = within(panel).getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    fireEvent.click(boxes[1]!);
    fireEvent.click(boxes[2]!);
    expect(go.hasAttribute("disabled")).toBe(true);
    fireEvent.click(boxes[0]!);
    fireEvent.click(go);
    await waitFor(() => expect(api.cloudAgentLoginConnect).toHaveBeenCalledWith("claude", "local-login", expect.objectContaining({ replaceExisting: true })));
  });

  // Review of #293: the row said Connected after the lent sign-in had expired.
  it("says who a restricted login reaches by who can drive, as the service decides it", () => {
    expect(agentLoginStatus(login({ sharedUse: "managers" })).text).toContain(" · only workspaces that nobody but owners and admins can drive · ");
    expect(agentLoginStatus(login({ sharedUse: "managers" })).text).not.toContain("created by");
  });

  // Review of #429: the app sent `sharedUse: organization` with every sign-in and said "every member's" in every
  // dialog. It now sends no scope (nobody chooses one here), so the service keeps a replaced login's; the text follows.
  describe("who a login will reach", () => {
    const text = (reach: ReturnType<typeof agentLoginReach>) => `${reach.lead}${reach.who}${reach.tail}`;

    it("is the service's default for a first login, the stored scope for the same kind, and no wider for another kind", () => {
      expect(text(agentLoginReach(undefined, "oauth-credentials-json", "Acme"))).toBe("By default, agents in every member's cloud workspaces of Acme may run on this login.");
      expect(agentLoginReach(login({ state: "disconnected", sharedUse: "managers" }), "oauth-credentials-json", "Acme").rule).toBe("default");

      const narrowed = agentLoginReach(login({ sharedUse: "managers" }), "oauth-credentials-json", "Acme");
      expect(text(narrowed)).toBe("This keeps who can use the login now: only workspaces that nobody but owners and admins can drive in Acme.");
      expect(text(narrowed)).not.toMatch(/every member|by default/i);
      expect(text(agentLoginReach(login({ sharedUse: "organization" }), "oauth-credentials-json", "Acme"))).toBe("This keeps who can use the login now: agents in every member's cloud workspaces of Acme.");
      // A revoked login is still the stored one; an older server names no scope; an unknown scope is not described.
      expect(agentLoginReach(login({ state: "revoked", sharedUse: "managers" }), "oauth-credentials-json", "Acme").rule).toBe("kept");
      expect(text(agentLoginReach(login({ sharedUse: undefined }), "oauth-credentials-json", "Acme"))).toContain("every member's");
      expect(text(agentLoginReach(login({ sharedUse: "teams" }), "oauth-credentials-json", "Acme"))).not.toContain("every member");
      // Another kind of login never reaches more than the stored one, and may reach fewer (the service's default for
      // its kind can be narrower). It is not described as a first login, and the row is where to see what was stored.
      for (const [was, becomes] of [["oauth-credentials-json", "api-key"], ["api-key", "oauth-credentials-json"]] as const) {
        const narrowedOther = agentLoginReach(login({ authKind: was, sharedUse: "managers" }), becomes, "Acme");
        expect(narrowedOther.rule).toBe("no-wider");
        expect(text(narrowedOther)).toBe("This keeps who can use the login now, or fewer: at most workspaces that nobody but owners and admins can drive in Acme.");
        expect(text(narrowedOther)).not.toMatch(/every member|by default/i);
        expect(narrowedOther.note).toBe(" The row above says who the login reaches once it is stored.");
        const wideOther = agentLoginReach(login({ authKind: was, sharedUse: "organization" }), becomes, "Acme");
        expect(text(wideOther)).toBe("This keeps who can use the login now, or fewer: at most agents in every member's cloud workspaces of Acme.");
        expect(text(wideOther)).not.toMatch(/by default/i);
      }
      expect(text(agentLoginReach(login({ authKind: "api-key", sharedUse: "teams" }), "oauth-credentials-json", "Acme"))).toBe("This keeps who can use the login now, or fewer, as the account service has it for Acme.");
      expect(narrowed.note).toBe("");
    });

    it("does not claim every member when a managers-only login is replaced by logging in again", async () => {
      stored = [login({ sharedUse: "managers", displayIdentity: "ada@example.com" })];
      const started = { attemptId: "attempt_1", authorizeUrl: "https://claude.com/cai/oauth/authorize?state=s", expiresInSeconds: 600, opened: true };
      vi.mocked(api.cloudAgentClaudeLoginStart).mockResolvedValue(started);
      vi.mocked(api.cloudAgentClaudeLoginComplete).mockImplementation(async () => {
        stored = [login({ sharedUse: "managers", displayIdentity: "grace@example.com", version: 2 })];
        return { status: "complete", credential: stored[0] };
      });
      await show();
      fireEvent.click(within(row("claude")).getByRole("button", { name: "Replace by logging in with Claude" }));
      const panel = within(row("claude")).getByTestId("agent-login-consent");
      expect(within(panel).getByTestId("agent-login-reach").textContent).toBe("This keeps who can use the login now: only workspaces that nobody but owners and admins can drive in Acme Robotics.");
      expect(panel.textContent).not.toContain("every member");
      consent(panel);
      fireEvent.click(within(panel).getByRole("button", { name: "Open Claude to sign in" }));
      fireEvent.click(within(await within(row("claude")).findByTestId("agent-login-code")).getByRole("button", { name: "Enter the code" }));
      // The consent carries no scope, so the app has none to send; the notice and the row say what the service kept.
      const agreed = { contextRevision: "org-revision", organizationSharing: true, machineInstallation: true, replaceExisting: true };
      await waitFor(() => expect(api.cloudAgentClaudeLoginComplete).toHaveBeenCalledWith("attempt_1", agreed));
      await waitFor(() => expect(screen.getByTestId("agent-logins-notice").textContent).toBe("Claude Code is connected for this organization's cloud workspaces: only workspaces that nobody but owners and admins can drive. The account service keeps this login and renews it."));
      expect(within(row("claude")).getByTestId("agent-login-status").textContent).toContain("grace@example.com · only workspaces that nobody but owners and admins can drive");
    });

    it("says the default as a default for a first login, and no wider for an API key over a narrowed subscription login", async () => {
      await show();
      fireEvent.click(within(row("cursor")).getByRole("button", { name: "Connect with an API key" }));
      expect(within(row("cursor")).getByTestId("agent-login-reach").textContent).toBe(
        "By default, agents in every member's cloud workspaces of Acme Robotics may run on this login. The account service decides this, and the row above says who the login reaches once it is stored.",
      );
      cleanup();
      stored = [login({ sharedUse: "managers" })];
      vi.mocked(api.cloudAgentLoginConnect).mockImplementation(async () => login({ authKind: "api-key", sharedUse: "managers" }));
      await show();
      fireEvent.click(within(row("claude")).getByRole("button", { name: "Replace with an API key" }));
      expect(within(row("claude")).getByTestId("agent-login-reach").textContent).toBe(
        "This keeps who can use the login now, or fewer: at most workspaces that nobody but owners and admins can drive in Acme Robotics. The row above says who the login reaches once it is stored.",
      );
      // Whatever the service answers is what the notice says.
      consent(within(row("claude")).getByTestId("agent-login-consent"));
      fireEvent.click(within(row("claude")).getByRole("button", { name: "Enter the key" }));
      await waitFor(() => expect(screen.getByTestId("agent-logins-notice").textContent).toBe("Claude Code is connected for this organization's cloud workspaces: only workspaces that nobody but owners and admins can drive."));
      expect(connectedNotice("Codex", login({}))).toBe("Codex is connected for this organization's cloud workspaces.");
      expect(connectedNotice("Codex", undefined)).toBe("Codex is connected for this organization's cloud workspaces.");
    });
  });

  it("shows a lent sign-in's expiry as a time, and Expired once it has passed", () => {
    const lent = login({ displayIdentity: "ada@example.com · lent until 2026-10-03T21:40:00Z" });
    const at = Date.parse("2026-10-03T21:40:00Z");
    expect(lentUntil(lent)).toEqual({ who: "ada@example.com", at });
    expect(lentUntil(login({ displayIdentity: "ada@example.com" }))).toBeNull();
    expect(lentUntil(login({ displayIdentity: "x · lent until yesterday" }))).toBeNull();

    const before = agentLoginStatus(lent, at - 3 * 60 * 60_000);
    expect(before.text).toMatch(/^Connected · sign-in lent from a Mac · ada@example\.com · expires in 3 h \(/);
    expect(before.warn).toBe(false);
    const soon = agentLoginStatus(lent, at - 20 * 60_000);
    expect(soon.text).toContain("expires in 20 min");
    expect(soon.warn).toBe(true);
    const after = agentLoginStatus(lent, at + 60_000);
    expect(after.text).toMatch(/^Expired .*agents can no longer sign in with it\. Connect a login again\.$/);
    expect(after.text).not.toContain("Connected");
    expect(after.warn).toBe(true);
    // The time is rendered in the viewer's own zone, not the uploader's.
    expect(after.text).toContain(new Date(at).toLocaleString());
  });

  // PRO-82 on the desktop: the account service's own sign-in is the first way offered for Claude.
  describe("Log in with Claude", () => {
    const started = { attemptId: "attempt_1", authorizeUrl: "https://claude.com/cai/oauth/authorize?state=s", expiresInSeconds: 600, opened: true };
    const begin = async () => {
      vi.mocked(api.cloudAgentClaudeLoginStart).mockResolvedValue(started);
      await show();
      fireEvent.click(within(row("claude")).getByRole("button", { name: "Log in with Claude" }));
      consent(within(row("claude")).getByTestId("agent-login-consent"));
      fireEvent.click(within(row("claude")).getByRole("button", { name: "Open Claude to sign in" }));
      return within(await within(row("claude")).findByTestId("agent-login-code"));
    };

    it("is the first and primary way for Claude, with the temporary lend after it; other agents have none", async () => {
      await show();
      const labels = within(row("claude")).getAllByRole("button").map((button) => button.textContent);
      expect(labels).toEqual(["Log in with Claude", "Connect with an API key", "Lend this Mac's Claude Code sign-in (temporary)"]);
      expect(within(row("codex")).queryByRole("button", { name: /Log in with/ })).toBeNull();
      expect(within(row("cursor")).queryByRole("button", { name: /Log in with/ })).toBeNull();
    });

    it("starts after both consents, then takes the code in a native dialog and stores a login that is renewed", async () => {
      vi.mocked(api.cloudAgentClaudeLoginComplete).mockImplementation(async () => {
        stored = [login({ displayIdentity: "ada@example.com" })];
        return { status: "complete", credential: stored[0] };
      });
      await show();
      fireEvent.click(within(row("claude")).getByRole("button", { name: "Log in with Claude" }));
      const panel = within(row("claude")).getByTestId("agent-login-consent");
      expect(panel.textContent).toContain("You sign in to Claude in your browser and approve access for Acme Robotics");
      expect(panel.textContent).toContain("receives a login it can renew");
      expect(panel.textContent).toContain("every member's cloud workspaces of Acme Robotics");
      expect(panel.textContent).toContain("Disconnecting does not sign you out at the provider");
      const go = within(panel).getByRole("button", { name: "Open Claude to sign in" });
      expect(go.hasAttribute("disabled")).toBe(true);
      vi.mocked(api.cloudAgentClaudeLoginStart).mockResolvedValue(started);
      consent(panel);
      fireEvent.click(go);
      const code = within(await within(row("claude")).findByTestId("agent-login-code"));
      const agreed = { contextRevision: "org-revision", organizationSharing: true, machineInstallation: true, replaceExisting: false };
      expect(api.cloudAgentClaudeLoginStart).toHaveBeenCalledWith(agreed);
      // No field for the code on the page: the app asks for it in its own dialog.
      expect(document.querySelector('input[type="text"], input[type="password"], textarea')).toBeNull();
      // While a sign-in is open, the other ways to change this login wait.
      expect(within(row("claude")).getByRole("button", { name: "Connect with an API key" }).hasAttribute("disabled")).toBe(true);

      fireEvent.click(code.getByRole("button", { name: "Enter the code" }));
      await waitFor(() => expect(screen.getByTestId("agent-logins-notice").textContent).toContain("keeps this login and renews it"));
      expect(api.cloudAgentClaudeLoginComplete).toHaveBeenCalledWith("attempt_1", agreed);
      expect(within(row("claude")).queryByTestId("agent-login-code")).toBeNull();
      expect(within(row("claude")).getByTestId("agent-login-status").textContent).toMatch(/^Connected · subscription login · ada@example\.com/);
    });

    it("keeps the sign-in open after a wrong code or an outage, and ends it when it expired", async () => {
      const code = await begin();
      vi.mocked(api.cloudAgentClaudeLoginComplete).mockResolvedValueOnce({ status: "code-invalid", attemptsLeft: 3 });
      fireEvent.click(code.getByRole("button", { name: "Enter the code" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Claude did not accept that code (3 tries left)");
      expect(within(row("claude")).getByTestId("agent-login-code")).toBeTruthy();

      vi.mocked(api.cloudAgentClaudeLoginComplete).mockResolvedValueOnce({ status: "unavailable" });
      fireEvent.click(code.getByRole("button", { name: "Enter the code" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be reached"));
      expect(within(row("claude")).getByTestId("agent-login-code")).toBeTruthy();

      // Canceling the native dialog is not the end of the sign-in either.
      vi.mocked(api.cloudAgentClaudeLoginComplete).mockRejectedValueOnce({ code: "cloud_provider_entry_cancelled" });
      fireEvent.click(code.getByRole("button", { name: "Enter the code" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Key entry canceled"));
      expect(within(row("claude")).getByTestId("agent-login-code")).toBeTruthy();

      vi.mocked(api.cloudAgentClaudeLoginComplete).mockResolvedValueOnce({ status: "expired" });
      fireEvent.click(code.getByRole("button", { name: "Enter the code" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("expired"));
      expect(within(row("claude")).queryByTestId("agent-login-code")).toBeNull();
      expect(within(row("claude")).getByTestId("agent-login-status").textContent).toBe("Not connected");
    });

    // Review of #293: another admin stores a login during the ten minutes; the panel had no way to choose Replace.
    it("asks for the replace choice in the open sign-in when a login was stored meanwhile", async () => {
      const code = await begin();
      vi.mocked(api.cloudAgentClaudeLoginComplete).mockImplementationOnce(async () => {
        stored = [login({ authKind: "api-key" })];
        throw { code: "cloud_agent_login_replace_unconfirmed" };
      });
      fireEvent.click(code.getByRole("button", { name: "Enter the code" }));
      expect((await screen.findByRole("alert")).textContent).toContain("A login was stored for this agent after you started");
      // The sign-in is still open, with the choice in it, and cannot be finished without making it.
      const choice = await code.findByTestId("agent-login-replace");
      expect(choice.textContent).toContain("Replace the API key now stored for Claude Code.");
      expect(code.getByRole("button", { name: "Enter the code" }).hasAttribute("disabled")).toBe(true);
      vi.mocked(api.cloudAgentClaudeLoginComplete).mockResolvedValueOnce({ status: "complete" });
      fireEvent.click(within(choice).getByRole("checkbox"));
      fireEvent.click(code.getByRole("button", { name: "Enter the code" }));
      await waitFor(() => expect(api.cloudAgentClaudeLoginComplete).toHaveBeenLastCalledWith("attempt_1", expect.objectContaining({ replaceExisting: true })));
      await waitFor(() => expect(within(row("claude")).queryByTestId("agent-login-code")).toBeNull());
    });

    it("opens the page again and cancels the sign-in", async () => {
      const code = await begin();
      vi.mocked(api.cloudAgentClaudeLoginOpen).mockResolvedValue(undefined);
      fireEvent.click(code.getByRole("button", { name: "Open the page again" }));
      expect(api.cloudAgentClaudeLoginOpen).toHaveBeenCalledWith(started.authorizeUrl);
      vi.mocked(api.cloudAgentClaudeLoginCancel).mockRejectedValue({ code: "cloud_workspace_unavailable" });
      fireEvent.click(code.getByRole("button", { name: "Cancel sign-in" }));
      await waitFor(() => expect(within(row("claude")).queryByTestId("agent-login-code")).toBeNull());
      expect(api.cloudAgentClaudeLoginCancel).toHaveBeenCalledWith("attempt_1", "org-revision");
      // Nothing was stored, and the other ways are offered again.
      expect(api.cloudAgentClaudeLoginComplete).not.toHaveBeenCalled();
      expect(within(row("claude")).getByRole("button", { name: "Connect with an API key" }).hasAttribute("disabled")).toBe(false);
    });

    it("says so when the server does not offer the sign-in, and that it replaces a stored login", async () => {
      stored = [login({ authKind: "api-key" })];
      vi.mocked(api.cloudAgentClaudeLoginStart).mockRejectedValue({ code: "cloud_agent_login_flow_unavailable" });
      await show();
      fireEvent.click(within(row("claude")).getByRole("button", { name: "Replace by logging in with Claude" }));
      const panel = within(row("claude")).getByTestId("agent-login-consent");
      expect(within(panel).getByTestId("agent-login-replace").textContent).toContain("Replace the API key now stored for Claude Code.");
      const go = within(panel).getByRole("button", { name: "Open Claude to sign in" });
      const boxes = within(panel).getAllByRole("checkbox");
      fireEvent.click(boxes[1]!);
      fireEvent.click(boxes[2]!);
      expect(go.hasAttribute("disabled")).toBe(true);
      fireEvent.click(boxes[0]!);
      fireEvent.click(go);
      expect((await screen.findByRole("alert")).textContent).toContain("does not offer Log in with Claude yet");
      expect(api.cloudAgentClaudeLoginStart).toHaveBeenCalledWith(expect.objectContaining({ replaceExisting: true }));
      expect(within(row("claude")).queryByTestId("agent-login-code")).toBeNull();
    });

    it("words every way a sign-in can end", () => {
      expect(signInOutcome({ status: "complete" })).toMatchObject({ done: true, over: true });
      expect(signInOutcome({ status: "code-invalid", attemptsLeft: 1 }).text).toContain("(1 try left)");
      expect(signInOutcome({ status: "code-invalid" })).toMatchObject({ done: false, over: false });
      expect(signInOutcome({ status: "pending" })).toMatchObject({ done: false, over: false });
      for (const status of ["expired", "canceled", "failed", "something-new"]) {
        const result = signInOutcome({ status });
        expect(result).toMatchObject({ done: false, over: true });
        expect(result.text).not.toContain("something-new");
      }
    });
  });
});
