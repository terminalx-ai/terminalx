#!/usr/bin/env node
// PRO-191: the full-window setup flow's keyboard path in the desktop's WebKit engine.
import { launch, open, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  const page = await open(browser, server.url, { cloud: true, localProjects: 0 }, { width: 960, height: 800 }, { extra: `
    const answers = window.__PW_STUB__.answers;
    answers.cloud_providers = { providers: [{ id: "box", displayName: "Box", availability: "available", canManage: true, connection: { state: "connected" }, capabilities: {} }] };
    answers.organization_github_app = { configured: true, canManage: true, contextRevision: "s:1", installations: [], repositories: [{ id: "r", installationId: "i", githubRepositoryId: 1, fullName: "acme/app", state: "accessible", cloneUrl: "https://github.com/acme/app.git", private: true }] };
    answers.organization_members = { members: [], pendingInvites: [], viewerRole: "admin", canManageMembers: true, contextRevision: "s:1" };
    answers.organization_computer_color = (args) => { answers.account_status.organizations[0].computerColor = args.color; return answers.account_status; };
  ` });
  await page.getByRole("button", { name: "Set up cloud computer", exact: true }).click();
  const flow = page.getByRole("main", { name: "Cloud setup" });
  await flow.getByRole("heading", { name: "Get started", exact: true }).waitFor();
  for (const heading of ["Cloud computer", "Connect GitHub", "Agents", "You're all set"]) {
    await page.keyboard.press("Enter");
    await flow.getByRole("heading", { name: heading, exact: true }).waitFor();
    failed += report("cloud setup", { [`Enter reaches ${heading}`]: await flow.getByRole("heading", { name: heading, exact: true }).isVisible() });
    if (heading === "Cloud computer") {
      await flow.getByRole("button", { name: "Teal", exact: true }).focus();
      await page.keyboard.press("Enter");
      await flow.getByRole("button", { name: "Teal", exact: true }).getAttribute("aria-pressed").then((pressed) => { failed += report("cloud setup", { "Enter activates the focused swatch without advancing": pressed === "true" }); });
      await flow.getByRole("heading", { name: heading, exact: true }).focus();
    }
  }
  failed += report("cloud setup", {
    "finish waits for a running workspace": await flow.getByRole("button", { name: "Go to workspaces", exact: true }).isDisabled(),
    "full window has no sidebar": await page.locator('[data-testid="sidebar-rail"]').count() === 0,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("main", { name: "Settings", exact: true }).waitFor();
  failed += report("cloud setup", { "Escape returns to Settings": await page.getByRole("main", { name: "Settings", exact: true }).isVisible() });
  await page.close();
} finally { await browser.close(); server.close(); }
process.exitCode = failed ? 1 : 0;
