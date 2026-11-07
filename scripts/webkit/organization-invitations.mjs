#!/usr/bin/env node
// PRO-175: real WebKit sidebar acceptance, persistent welcome, narrow/light/dark.
// Requires the built app and installed Playwright WebKit. No real account or compute.
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const extra = `(() => {
  const original = window.__TAURI_INTERNALS__.invoke;
  const org = { id: "invited-team", name: "International Research and Development Organization", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } };
  const status = { state: "signed-in", identity: { name: "Member", email: "member@example.com", organization: "", organizationId: "" }, context: { account: "webkit-invite-account", scope: "webkit", revision: "webkit:1" }, expiresAt: null, lastError: null, multiOrg: true, organizations: [] };
  let invites = [{ id: "invitation", organizationName: org.name, role: "member", invitedBy: "Organization administrator", expiresAt: Date.now() + 3600000 }];
  window.__inviteCalls = [];
  window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    if (cmd === "account_status") return status;
    if (cmd === "account_refresh_roles") return { status, fresh: true };
    if (cmd === "account_invitations") return { invites };
    if (cmd === "account_invitation_accept") {
      window.__inviteCalls.push({ cmd, args });
      await new Promise(resolve => { window.__finishAccept = resolve; });
      invites = []; status.organizations = [org];
      return { organizationId: org.id, organizationName: org.name, role: org.role };
    }
    if (cmd === "account_invitation_decline") { window.__inviteCalls.push({ cmd, args }); invites = []; return { declined: true }; }
    if (cmd === "cloud_catalog_load") return null;
    if (cmd === "cloud_catalog_save") return;
    if (cmd === "cloud_workspaces") return { workspaces: [], quota: { used: 0, limit: 3 } };
    if (cmd === "cloud_workspace_repositories") return { configured: true, repositories: [{ fullName: "research/allowed", cloneUrl: "https://github.com/research/allowed.git", defaultBranch: "main", private: true, state: "accessible", reason: null }] };
    if (cmd === "cloud_providers") {
      if (args.orgId !== status.identity.organizationId) throw { code: "active_organization_required", status: 403 };
      return { providers: [{ id: "box", availability: "available" }] };
    }
    if (cmd === "organization_select") {
      status.identity = { ...status.identity, organization: org.name, organizationId: org.id };
      status.context = { ...status.context, revision: "webkit:2" };
      return status;
    }
    if (cmd === "cloud_workspace_preflight") return { ready: args.agent !== "cursor-agent", checks: [{ kind: "agent-credential", agent: args.agent, status: args.agent === "cursor-agent" ? "failed" : "verified", cloneUrl: null, errorCode: null, retryable: false }] };
    if (cmd === "organization_members_in") return { members: [{ userId: "admin", role: "admin", displayName: "Administrator", email: "admin@example.com" }], pendingInvites: [], viewerRole: "member", canManageMembers: false, contextRevision: "" };
    return original(cmd, args);
  };
})();`;
const server = await serve();
let browser;
let failed = 0;
try {
  browser = await launch();
  for (const colorScheme of ["light", "dark"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 0 }, { width: 800, height: 700 }, { extra, colorScheme });
    await sidebar(page);
    const callout = page.getByTestId("sidebar-invitations");
    await callout.getByRole("heading", { name: /^Join International/ }).waitFor();
    const before = await callout.evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth, buttons: [...node.querySelectorAll("button")].every((button) => button.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1) }));
    failed += report(colorScheme, { "narrow invitation wraps within sidebar": before.scroll <= before.width + 1 && before.buttons }, before);
    const accept = callout.getByRole("button", { name: "Accept", exact: true });
    await accept.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => !!window.__finishAccept);
    failed += report(colorScheme, { "accept and decline are disabled while accepting": await callout.getByRole("button", { name: "Accepting…" }).isDisabled() && await callout.getByRole("button", { name: "Decline" }).isDisabled() });
    await page.evaluate(() => window.__finishAccept());
    await page.getByTestId("cloud-org-list").filter({ has: page.getByRole("button", { name: "International Research and Development Organization", exact: true }) }).waitFor();
    await page.getByTestId("organization-invitation").waitFor({ state: "detached" });
    const welcome = page.getByTestId("cloud-org-list").getByTestId("organization-welcome");
    await welcome.waitFor();
    await welcome.getByText("Not ready", { exact: true }).waitFor();
    failed += report(colorScheme, { "accept was sent only once": await page.evaluate(() => window.__inviteCalls.filter(call => call.cmd === "account_invitation_accept").length === 1), "per-agent failure remains visible": await welcome.getByText("Not ready", { exact: true }).isVisible() });
    await welcome.getByText(/Choose .* as your default organization in Settings to check compute/).waitFor();
    await welcome.getByRole("button", { name: "Open organization settings" }).click();
    const settings = page.getByRole("main", { name: "Settings", exact: true });
    const makeDefault = settings.getByRole("button", { name: /^Make .* your default organization$/ });
    await makeDefault.click();
    await makeDefault.waitFor({ state: "detached" });
    // Settings replaces the sidebar in AppShell. Return through its real UI,
    // then require the sidebar card to remount before checking it or dismissing it.
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await sidebar(page);
    await welcome.waitFor();
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="cloud-org-list"] [data-testid="organization-welcome"]');
      if (!card) return false;
      const compute = [...card.querySelectorAll("dt")].find(node => node.textContent === "Compute");
      return compute?.nextElementSibling?.textContent === "Ready";
    });
    const welcomeLayout = await welcome.evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
    failed += report(colorScheme, { "welcome card remains within sidebar after explicit selection": welcomeLayout.scroll <= welcomeLayout.width + 1 }, welcomeLayout);
    await welcome.getByRole("button", { name: /^Dismiss welcome/ }).click();
    await welcome.waitFor({ state: "detached" });
    await page.reload();
    // The independent bridge resets its membership on reload, so accept again; the durable key survives.
    await page.getByTestId("sidebar-invitations").getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForFunction(() => !!window.__finishAccept); await page.evaluate(() => window.__finishAccept());
    await page.getByTestId("cloud-org-list").waitFor();
    failed += report(colorScheme, { "dismissal survives reload": await page.getByTestId("organization-welcome").count() === 0 });
    await page.close();
  }
  const declined = await open(browser, server.url, { cloud: false, localProjects: 0 }, { width: 800, height: 700 }, { extra });
  await sidebar(declined); await declined.getByTestId("sidebar-invitations").getByRole("button", { name: "Decline" }).click();
  await declined.getByTestId("sidebar-invitations").waitFor({ state: "detached" });
  failed += report("decline", { "no organization was added": await declined.getByTestId("cloud-org-list").count() === 0 });
  await declined.close();
} finally {
  await browser?.close(); server.close();
}
process.exitCode = failed ? 1 : 0;
