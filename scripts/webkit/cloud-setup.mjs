#!/usr/bin/env node
// PRO-389: the full-window cloud setup flow (12.01–12.07, 14.15) at 1440×900
// in dark and light. Step titles sit on a 32px line, ↵ keycaps and small
// counts are 12px or more, no status bar shows under the flow, the compute
// step has no extra rows, a failed build offers Restart build, Fix with an
// agent and Copy logs with its exit status, invitations read as two lines
// with two-letter initials, and the setup check's coach mark stays wholly
// above the composer. Pictures go to $CLOUD_SETUP_SHOTS (default /tmp).
import { launch, open, openCloudSession, report, serve } from "./harness.mjs";

const SHOTS = process.env.CLOUD_SETUP_SHOTS ?? "/tmp";
const VIEWPORT = { width: 1440, height: 900 };
const ORG = "org-a";
const at = Date.UTC(2026, 9, 1);

const record = (step) => ({
  v: 2,
  requestId: "request-1",
  name: "Demo",
  organizationId: ORG,
  createdAt: at,
  step: "compute",
  agent: "required",
  workspace: null,
  completedAt: null,
  flow: { step, passed: ["organization", "github", "compute", "logins"], finishedAt: null },
});
const seed = (step) => `localStorage.setItem("terminalx.organization-setup.v2.a%40b%2Ec", ${JSON.stringify(JSON.stringify({ v: 2, records: [record(step)] }))});`;

const version = (number, extra = {}) => ({
  id: `version-${number}`,
  number,
  state: "succeeded",
  stage: "complete",
  publication: null,
  configurationRevision: number,
  repositories: [],
  createdAt: at,
  startedAt: at,
  finishedAt: at + 180_000,
  publishedAt: null,
  rollbackAvailable: false,
  ...extra,
});
const failed = version(8, { state: "failed", stage: "install", failurePhase: "install", errorCode: "cloud_environment_install_failed", finishedAt: at + 151_000 });
const environment = (versions) => ({
  provider: "hetzner",
  supported: true,
  canManage: true,
  retainedVersions: 2,
  template: { revision: 8, definition: { installScript: "apt-get update\napt-get install -y nope", repositories: [] }, updatedAt: at },
  activeVersion: version(7, { publication: "published" }),
  rebuildRequired: false,
  pendingChanges: [],
  versions,
  contextRevision: "s:1",
});

// What today's build worker stores: the step's own output, with no exit status or line in it (PRO-413 adds them as fields).
const SCRIPT_OUTPUT = "Reading package lists...\nBuilding dependency tree...\nE: Unable to locate package nope";

const answers = ({ environment, failed, read }) => {
  const answers = window.__PW_STUB__.answers;
  answers.status_bar_settings = { visible: true, usage: true, resources: false, percent: "used", usageMode: "detailed", usageRefreshMinutes: 1 };
  const capabilities = { suspend: true, resume: true, releaseDisposition: "retain", locationSelection: "required", sourceSelection: "none", pricing: "provider-rate" };
  // The descriptors the server's provider registry publishes (PRO-415): the app names no provider.
  const offering = { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "provider-rate", suspendedBilling: "none" };
  const descriptor = (id, label, icon, order, description, billing, billedByProvider, credentialFields) => ({
    id, label, icon, order, description, billing, billedByProvider, listed: true, credentialFields, offering,
    capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false },
    allowedIdleSuspendMinutes: [5, 10, 15, 30, 60, 0],
    allowedRetentionDays: [7, 30],
  });
  answers.cloud_providers = {
    providers: [
      {
        id: "hetzner", displayName: "Hetzner Cloud", availability: "available", canManage: true, connection: { state: "connected", connectedAt: 1, lastValidatedAt: 1, credentialFingerprint: "abcd1234" }, capabilities,
        descriptor: descriptor("hetzner", "Hetzner Cloud", "server", 20, "Machines in Falkenstein, Nuremberg, Helsinki, Ashburn and Hillsboro.", "Hourly, billed by Hetzner", true, [{ name: "credential", kind: "secret", label: "Hetzner API token", helpUrl: "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token" }]),
      },
      {
        id: "box", displayName: "Boat", availability: "not-connected", canManage: true, connection: null, capabilities,
        descriptor: descriptor("box", "Boat", "ship", 10, "Fast-start sandboxes that sleep when idle. Part of the disk resets on resume.", "Per second, billed by Boat", true, [{ name: "credential", kind: "secret", label: "Boat API token", helpUrl: null }]),
      },
      {
        id: "local-docker", displayName: "Local Docker", availability: "not-connected", canManage: true, connection: null, capabilities,
        descriptor: descriptor("local-docker", "Local Docker (development)", "container", 90, "Containers on a machine you run. Good for trying cloud workspaces out.", "Your own hardware", false, [{ name: "credential", kind: "text", label: "Connection marker", helpUrl: null }]),
      },
    ],
  };
  answers.cloud_provider = { provider: "hetzner", state: "connected", canManage: true, credentialFingerprint: "abcd1234", connectedAt: 1, lastValidatedAt: 1, providerAccount: "project 4471" };
  answers.cloud_workspace_setup = {
    provider: "hetzner",
    currency: "EUR",
    pricing: "provider-rate",
    defaults: { sourceId: "", locationId: "fsn1", machineClassId: "cx32", idleSuspendMinutes: 15, retentionDays: 30, networkPolicy: "relay-only" },
    allowedIdleSuspendMinutes: [15],
    allowedRetentionDays: [30],
    sources: [],
    locations: [{ id: "fsn1", label: "Falkenstein" }],
    machineClasses: [
      { id: "cx22", label: "Small", vcpus: 2, memoryMib: 4096, diskGb: 40, activeHourlyMicros: 6000 },
      { id: "cx32", label: "Medium", vcpus: 4, memoryMib: 8192, diskGb: 80, activeHourlyMicros: 11000 },
    ],
  };
  answers.organization_compute_policy = { policy: { version: 1, maxWorkspaces: 5, maxRunningWorkspaces: 3 }, canEdit: true, counts: { workspaces: 0, running: 0 }, workspaceCeiling: 10, runningWorkspaceCeiling: 10 };
  answers.organization_environment_status = environment;
  answers.organization_environment_recipes = { recipes: [], contextRevision: "s:1" };
  answers.organization_environment_version = {
    ...failed,
    contextRevision: "s:1",
    ...read,
  };
  answers.workspace_config_organization = { organization: { env: { NODE_ENV: "development" } }, canEdit: true, contextRevision: "s:1" };
  answers.cloud_agent_logins = { credentials: [{ provider: "claude" }] };
  answers.organization_github_app = { installed: false, repositories: [] };
  const roster = {
    members: [{ userId: "u1", email: "a@b.c", name: "A", role: "owner" }],
    pendingInvites: [
      { email: "ana.kim@example.com", role: "member", createdAt: Date.now() - 1000 },
      { email: "sam.rivera@example.com", role: "admin", createdAt: Date.now() - 2000 },
    ],
    viewerRole: "owner",
    canManageMembers: true,
    canInvite: true,
    contextRevision: "s:1",
  };
  answers.organization_members = roster;
  answers.organization_members_in = roster;
};

const box = (locator) => locator.evaluate((node) => {
  const rect = node.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
});
const fontSize = (locator) => locator.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));

async function flowAt(browser, server, step, colorScheme, envStatus = environment([failed, version(7, { publication: "published" })]), read = { logs: [{ phase: "install", content: SCRIPT_OUTPUT, occurredAt: 1 }] }) {
  const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, VIEWPORT, { colorScheme, locale: "en-US", extra: seed(step) });
  await page.evaluate(answers, { environment: envStatus, failed, read });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const statusBarInSettings = await page.locator("[data-status-bar]").count();
  await page.evaluate(() => window.__PW_STUB__.emit?.("status_bar_settings", window.__PW_STUB__.answers.status_bar_settings));
  // PRO-464: Organizations is one row in the menu; an organization's General offers to finish its setup.
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("button", { name: /^Organizations \d+$/ }).click();
  await nav.getByRole("group", { name: "Organizations", exact: true }).getByRole("button", { name: /^Demo/ }).click();
  await page.getByRole("button", { name: "Finish setting up Demo" }).click();
  await page.locator(`[data-testid="cloud-setup-flow"][data-step="${step}"]`).waitFor();
  return { page, statusBarInSettings };
}

const server = await serve();
const browser = await launch();
let failures = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    // 12.03 Compute: no extra rows; the ↵ keycap, title line and status bar.
    {
      const { page } = await flowAt(browser, server, "compute", colorScheme);
      const flow = page.getByTestId("cloud-setup-flow");
      await flow.getByText("Machine size", { exact: false }).first().waitFor();
      await page.getByRole("radio", { name: /Medium/ }).first().waitFor({ state: "attached" });
      const title = page.locator("#cloud-setup-step-title");
      const titleLine = await title.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
      const kbd = await fontSize(flow.locator("[data-cloud-setup-primary] kbd").first());
      const replace = flow.getByRole("button", { name: "Replace key" });
      const replaceBox = (await replace.count()) ? await box(replace) : null;
      const tokenBox = await box(page.getByTestId("cloud-setup-provider-connection"));
      const cards = await page.locator('[data-testid^="cloud-setup-provider-"]:is(label)').allTextContents();
      const text = await flow.textContent();
      await page.screenshot({ path: `${SHOTS}/pro-389-compute-${colorScheme}.png` });
      failures += report(`compute (${colorScheme})`, {
        "no status bar under the flow": (await page.locator("[data-status-bar]").count()) === 0,
        "the title sits on a 32px line": titleLine === 32,
        "the ↵ keycap is 12px or more": kbd >= 12,
        "Replace key shares the token field's label line": replaceBox !== null && replaceBox.bottom <= tokenBox.top,
        "no provider card adds a Connected line": cards.length > 0 && cards.every((card) => !/Connected/.test(card)),
        "no repeated helper line under the computer name": !/Everyone in the organization sees the cloud computer/.test(text),
        // The provider is named by its descriptor (PRO-415); a VAT note needs a descriptor field the server does not send yet.
        "the size hint names whose prices they are": /Machine size · prices from Hetzner Cloud/.test(text),
      }, { replaceBox, tokenBox, cards, titleLine, kbd });
      await page.close();
    }

    // 14.15 Environment: the failed card and the shared variables heading, first as today's worker
    // reports a failure (output only), then with the exit status and line the server is to send (PRO-413).
    for (const [label, read, expected] of [
      ["output only", { logs: [{ phase: "install", content: SCRIPT_OUTPUT, occurredAt: 1 }] }, { header: /after 2m 31s · failed while running the machine install script/, tail: /Unable to locate package nope\s*failed while running the machine install script · environment v7 stays active/ }],
      ["exit status sent", { exitCode: 100, failureLine: 9, logs: [{ phase: "install", content: SCRIPT_OUTPUT, occurredAt: 1 }] }, { header: /after 2m 31s · exit 100 in the install script, line 9/, tail: /install script exited with 100 · environment v7 stays active/ }],
    ]) {
      const { page } = await flowAt(browser, server, "environment", colorScheme, undefined, read);
      const panel = page.locator(`[data-testid="cloud-setup-build-panel"]:visible`);
      await panel.getByRole("button", { name: "Fix with an agent" }).waitFor();
      await panel.getByText("Unable to locate package nope").first().waitFor();
      const alert = await panel.getByRole("alert").textContent();
      const heading = page.getByRole("region", { name: "Shared environment variables" }).locator("> div").first();
      await page.getByText("Shared environment variables", { exact: true }).waitFor();
      const headingBox = await box(heading);
      await page.screenshot({ path: `${SHOTS}/pro-389-environment-${label.replace(/ /g, "-")}-${colorScheme}.png` });
      failures += report(`environment, ${label} (${colorScheme})`, {
        "the failed card offers Restart build, Fix with an agent and Copy logs": (await panel.getByRole("button", { name: /Restart build|Fix with an agent|Copy logs/ }).count()) === 3,
        "its header says what failed": expected.header.test(alert ?? ""),
        "its log tail ends with what failed and what stays active": expected.tail.test(alert ?? ""),
        "the internal error code is not shown": !/cloud_environment_install_failed/.test(await page.getByTestId("cloud-setup-flow").textContent()),
        "the shared variables heading is one line": headingBox.height <= 30,
      }, { alert, headingBox });
      // Fix with an agent opens the priced confirmation and starts nothing.
      await panel.getByRole("button", { name: "Fix with an agent" }).click();
      await page.locator(`[data-testid="cloud-setup-fix-with-agent"]:visible`).waitFor();
      await page.close();
    }

    // 12.06 Invite: two-line rows, initials, the role select, the environment row.
    {
      const building = version(9, { state: "running", stage: "install", startedAt: Date.now() - 60_000, finishedAt: null });
      const { page } = await flowAt(browser, server, "invite", colorScheme, environment([building, version(7, { publication: "published" })]));
      const list = page.getByRole("list", { name: "Pending invitations" });
      await list.waitFor();
      const row = list.getByRole("listitem").first();
      const lines = await row.locator("div.min-w-0 > div").allTextContents();
      const avatar = row.locator("span[aria-hidden]").first();
      const select = await box(page.getByLabel("Role for these invites"));
      const input = page.locator("#cloud-setup-invite-email");
      await input.fill("lee.park@example.com,");
      const chip = page.locator("span", { hasText: "lee.park@example.com" }).locator("> span").first();
      const environmentRow = page.getByText(/^Version 9 building · /);
      await environmentRow.waitFor();
      const envBox = await box(environmentRow);
      await page.screenshot({ path: `${SHOTS}/pro-389-invite-${colorScheme}.png` });
      failures += report(`invite (${colorScheme})`, {
        "a pending row reads name over email": lines.length >= 2 && lines[0] === "Ana Kim" && lines[1] === "ana.kim@example.com",
        "its avatar has two letters at 12px or more": (await avatar.textContent()) === "AK" && (await fontSize(avatar)) >= 12,
        "the role select is 150px wide": Math.round(select.width) === 150,
        "chip initials are two letters at 12px or more": (await chip.textContent()) === "LP" && (await fontSize(chip)) >= 12,
        "the environment row is one line": envBox.height <= 19,
        "the environment row says the time left": /about \d+ minutes? left|about a minute left/.test((await environmentRow.textContent()) ?? ""),
      }, { lines, select, envBox });
      await page.close();
    }

    // 12.07 Setup check: the coach mark stays above the composer.
    {
      const coach = `localStorage.setItem("terminalx.setup-check-draft.v1", JSON.stringify([{ orgId: "${ORG}", workspaceId: "w1", text: "x", tabId: "t1", coachDismissed: false, createdAt: Date.now() }]));`;
      const page = await open(browser, server.url, { cloud: true, localProjects: 0, session: { role: "manager", lines: 3 } }, VIEWPORT, { colorScheme, locale: "en-US", extra: coach });
      await openCloudSession(page, await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle));
      const textarea = page.locator("main [data-composer-box] textarea");
      await textarea.waitFor();
      await textarea.fill("Set up this computer for development. Install what each repository needs, then check that tests and the app run in api and web. Write what you changed to SETUP.md.");
      const card = page.getByTestId("setup-check-coach");
      await card.waitFor();
      await page.waitForTimeout(300);
      const cardBox = await box(card);
      const composerBox = await box(page.locator("main [data-composer-box]"));
      const count = card.getByText("1 of 1", { exact: true });
      await page.screenshot({ path: `${SHOTS}/pro-389-coach-${colorScheme}.png` });
      failures += report(`setup check coach (${colorScheme})`, {
        "the coach mark sits wholly above the composer": cardBox.bottom <= composerBox.top,
        "it stays in the window": cardBox.top >= 0 && cardBox.right <= VIEWPORT.width,
        "its step count is 12px or more": (await fontSize(count)) >= 12,
      }, { cardBox, composerBox });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failures ? 1 : 0);
