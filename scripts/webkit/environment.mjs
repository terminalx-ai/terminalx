#!/usr/bin/env node
// PRO-20: the organization's Environment section in the desktop's WebKit
// engine. The machine script, each repository's setup, the versions and a
// recipe's results must stay readable and inside the Settings column at the
// narrow window width, and looking at any of it must start nothing.
// PRO-144: the local Environment pages too: Personal and a repository's
// variables with their sources, documented variables and the Add sheet's
// Keychain switch, inside the column and without overlapping controls.
// PRO-376: at 1440 wide, in dark and light, the Personal table's rows are
// 40 px with every action on one line, no value breaks mid-token, the buttons
// sit beside the page title, and Add variables is a sheet at the right edge.
import { launch, open, report, serve } from "./harness.mjs";

const at = Date.UTC(2026, 9, 1);
const version = (number, extra = {}) => ({
  id: `version-${number}`,
  provider: "local-docker",
  number,
  state: "succeeded",
  stage: "complete",
  configurationRevision: number,
  repositories: [{ owner: "acme", name: "widgets-with-a-rather-long-repository-name", defaultBranch: "main", path: "/home/repos/acme/widgets", commit: "0123456789abcdef0123456789abcdef01234567" }],
  createdAt: at,
  finishedAt: at,
  publishedAt: at,
  rollbackAvailable: false,
  ...extra,
});
const definition = {
  installScript: "apt-get update && apt-get install -y ripgrep build-essential pkg-config libssl-dev\nnpm install --global pnpm@10 @openai/codex",
  repositories: [
    { owner: "acme", name: "widgets-with-a-rather-long-repository-name", defaultBranch: "main", setup: [{ workingDirectory: "packages/web", script: "pnpm install --frozen-lockfile" }] },
    { owner: "acme", name: "api", defaultBranch: "release/2026-10", setup: [] },
  ],
};
const status = {
  provider: "local-docker",
  supported: true,
  canManage: true,
  retention: { publishedAndRollback: 2 },
  template: { revision: 4, definition, updatedAt: at },
  activeVersion: version(3, { publication: "published" }),
  rebuildRequired: true,
  pendingChanges: ["install-script", "setup-steps"],
  versions: [
    version(4, { state: "failed", stage: "install", failurePhase: "install", errorCode: "cloud_environment_install_failed", finishedAt: at }),
    version(3, { publication: "published" }),
    version(2, { publication: "retained", rollbackAvailable: true }),
  ],
};
const check = (kind, command, state, extra = {}) => ({ kind, command, status: state, ...extra });
const recipes = {
  recipes: [
    {
      id: "recipe-1",
      provider: "local-docker",
      state: "proposed",
      baseRevision: 4,
      definition: { ...definition, installScript: `${definition.installScript}\ncorepack enable\n${Array.from({ length: 40 }, (_, line) => `echo "step ${line}"`).join("\n")}\ncurl -fsSL https://example.test/install.sh | sh` },
      definitionDigest: "sha256:x",
      observations: {
        v: 1,
        observedBy: "verification",
        machine: { status: "passed", exitCode: 0, durationMs: 41000 },
        repositories: [
          {
            owner: "acme",
            name: "widgets-with-a-rather-long-repository-name",
            commit: "a".repeat(40),
            checks: [
              check("install", "pnpm install --frozen-lockfile", "passed", { exitCode: 0, durationMs: 9000 }),
              check("lint", "pnpm --filter ./packages/web run lint -- --max-warnings=0 --report-unused-disable-directives", "passed", { exitCode: 0 }),
              check("test", "pnpm test", "failed", { exitCode: 1, preexisting: true }),
              check("build", "pnpm build", "passed", { exitCode: 0 }),
              check("start", "", "skipped"),
            ],
          },
          { owner: "acme", name: "api", commit: "b".repeat(40), checks: [check("install", "cargo fetch", "passed", { exitCode: 0 }), check("lint", "cargo clippy", "timed-out"), check("test", "cargo test", "not-run"), check("build", "cargo build", "not-run"), check("start", "cargo run", "not-run")] },
        ],
      },
      createdBy: "user-1",
      createdAt: at,
    },
  ],
};

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  // PRO-391: also at the design's 1440 width, in dark and light.
  for (const [width, colorScheme] of [[1440, "dark"], [1440, "light"], [960, undefined], [720, undefined]]) {
    // The price assertion uses the US currency format, regardless of the VM's locale.
    const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width, height: 900 }, { locale: "en-US", colorScheme });
    await page.evaluate(
      ({ status, recipes }) => {
        window.__ENVIRONMENT_CALLS__ = [];
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = (command, args) => {
          window.__ENVIRONMENT_CALLS__.push(command);
          return invoke(command, args);
        };
        const answers = window.__PW_STUB__.answers;
        // The provider is named by the descriptor the server's registry publishes (PRO-415): the app names no provider.
        answers.cloud_providers = { providers: [{ id: "local-docker", displayName: "Local Docker", availability: "available", canManage: true, connection: { state: "connected", connectedAt: 1, lastValidatedAt: 1, credentialFingerprint: null }, capabilities: {},
          descriptor: {
            id: "local-docker", label: "Local Docker", icon: "container", order: 90, description: "Containers on a machine you run. Good for trying cloud workspaces out.", billing: "Your own hardware", billedByProvider: false, listed: true,
            credentialFields: [{ name: "credential", kind: "text", label: "Connection marker", helpUrl: null }],
            offering: { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "provider-rate", suspendedBilling: "none" },
            capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false },
            allowedIdleSuspendMinutes: [5, 15, 60, 0], allowedRetentionDays: [30],
          } }] };
        answers.organization_environment_status = { ...status, contextRevision: "s:1" };
        answers.organization_environment_recipes = { ...recipes, contextRevision: "s:1" };
        answers.organization_compute_policy = { policy: { version: 1, maxWorkspaces: 5, maxRunningWorkspaces: 3 }, canEdit: true, counts: { workspaces: 2, running: 1 }, workspaceCeiling: 10, runningWorkspaceCeiling: 10 };
        answers.cloud_agent_logins = { credentials: [{ provider: "claude" }, { provider: "codex" }] };
        answers.cloud_workspace_setup = { provider: "local-docker", currency: "USD", pricing: "provider-rate", defaults: { sourceId: "s", locationId: "l", machineClassId: "m", idleSuspendMinutes: 15, retentionDays: 30, networkPolicy: "relay-only" }, allowedIdleSuspendMinutes: [5, 15, 60, 0], allowedRetentionDays: [30], sources: [], locations: [], machineClasses: [] };
        answers.cloud_workspace_quote = { id: "quote-1", provider: "local-docker", expiresAt: Date.now() + 300000, currency: "USD", pricing: "provider-rate", activeHourlyMicros: 20000, alwaysOnThirtyDayMicros: 14400000, estimatedSuspendedMonthlyMicros: null, configuration: {} };
        answers.organization_environment_version = { ...status.versions[0], contextRevision: "s:1", logs: [{ phase: "install", content: "E: Unable to locate package build-essentials\nexit status 100", occurredAt: 1 }] };
      },
      { status, recipes },
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Account", exact: true }).click(); // Settings opens on General (PRO-374).
    // The section is on the active organization's page (PRO-107), reached from Settings → Account.
    await page.getByTestId("account-organization-settings").getByRole("button", { name: "Open", exact: true }).click();
    // PRO-391: the environment is the Environment tab of Cloud compute.
    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    const template = page.getByRole("form", { name: "Environment template" });
    await template.waitFor();
    await page.getByRole("region", { name: "Environment recipes" }).waitFor();
    const rows = await page.getByRole("list", { name: "Environment versions" }).evaluate((list) => [...list.children].map((row) => ({ height: row.getBoundingClientRect().height, line: row.firstElementChild.getBoundingClientRect().height, text: row.textContent })));
    const unbuilt = await page.getByRole("region", { name: "Unbuilt changes" }).textContent();
    // The page before anything is opened, as the design draws it.
    await page.getByTestId("organization-cloud-compute").screenshot({ path: `/tmp/pro-391-environment-${width}-${colorScheme ?? "default"}.png` });
    await page.getByRole("region", { name: "Environment builds" }).getByRole("button", { name: "Build environment" }).click();
    await page.getByRole("listitem", { name: "Version 4" }).getByRole("button", { name: "View log" }).click();
    await page.getByLabel("Build log of version 4").getByText(/Unable to locate/).waitFor();
    await page.getByRole("button", { name: "Apply…" }).click();
    // PRO-20 part 4: asking to configure with an agent prices a machine and shows the confirmation; it starts none.
    await page.getByRole("button", { name: "Configure with an agent…" }).click();
    const before = page.getByLabel("Before the machine starts");
    await before.waitFor();
    await before.getByRole("button", { name: "Show what the agent is asked" }).click();
    const section = page.getByTestId("organization-environment");
    const layout = await section.evaluate((root) => {
      const main = root.closest('[role="main"]') ?? document.body;
      const inside = (element) => {
        const box = element.getBoundingClientRect();
        const bounds = root.getBoundingClientRect();
        return box.width === 0 || (box.left >= bounds.left - 1 && box.right <= bounds.right + 1);
      };
      const controls = [...root.querySelectorAll("button, input, textarea, select, table, pre")];
      const overlaps = [];
      const buttons = [...root.querySelectorAll("button")].map((button) => ({ label: button.textContent, box: button.getBoundingClientRect() })).filter(({ box }) => box.width > 0);
      for (let a = 0; a < buttons.length; a++)
        for (let b = a + 1; b < buttons.length; b++) {
          const one = buttons[a].box;
          const two = buttons[b].box;
          if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps.push([buttons[a].label, buttons[b].label]);
        }
      return {
        noPageOverflow: main.scrollWidth <= main.clientWidth + 1,
        outside: controls.filter((control) => !inside(control)).map((control) => `${control.tagName}:${(control.getAttribute("aria-label") ?? control.textContent ?? "").slice(0, 40)}`),
        overlaps,
        text: root.textContent,
        small: [...root.querySelectorAll("*")].filter((element) => element.offsetParent !== null && [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()) && parseFloat(getComputedStyle(element).fontSize) < 12).map((element) => element.textContent.slice(0, 30)),
      };
    });
    // Tall enough that the whole section is laid out on screen for the picture.
    await page.setViewportSize({ width, height: 3200 });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: `/tmp/pro-20-environment-${width}-${colorScheme ?? "default"}.png` });
    const calls = await page.evaluate(() => window.__ENVIRONMENT_CALLS__);
    failed += report(`environment section at ${width}px${colorScheme ? ` (${colorScheme})` : ""}`, {
      "no text on the Environment tab is smaller than 12px": layout.small.length === 0,
      "versions are 44px rows named Environment vN": rows.length === 3 && rows.every((row) => row.line >= 43 && row.line <= 45) && rows.slice(1).every((row) => row.height >= 43 && row.height <= 45) && /^Environment v4/.test(rows[0].text),
      // #1093: the retry is under the failed row from the start, not only once its log is open.
      "a failed version offers Build again… on a line under its row, with its log closed": /View logBuild again…$/.test(rows[0].text) && rows[0].height > rows[0].line + 20 && rows[0].height <= rows[0].line + 45 && rows.slice(1).every((row) => !/Build again/.test(row.text)),
      "the active version has an ACTIVE badge and older built ones offer Activate": /Active/.test(rows[1].text) && /Activate/.test(rows[2].text),
      "a failed version says where it failed, without the error code": /Failed in install script/.test(rows[0].text) && !/cloud_environment_install_failed/.test(layout.text),
      "times are relative ages or short dates, not locale timestamps": !/\d+\/\d+\/\d{4}/.test(layout.text),
      "the unbuilt changes bar names what changed": /Unbuilt changes/.test(unbuilt) && /Changed: install script, setup steps/.test(unbuilt),
      "the section does not widen the Settings column": layout.noPageOverflow,
      "every control, table and script stays inside the section": layout.outside.length === 0,
      "no two buttons overlap": layout.overlaps.length === 0,
      "the machine script and repository setup are separate fields": (await template.getByLabel("Machine install script").count()) === 1 && (await template.getByRole("listitem").count()) === 2,
      "a failing check reads as failing, and a pre-existing one says so": /Failed \(also fails without this recipe's setup\) \(exit 1\)/.test(layout.text) && /Timed out/.test(layout.text),
      "proposed scripts are shown whole, with no scroll box": await section.evaluate((root) => [...root.querySelectorAll('pre[aria-label^="Proposed"], pre[aria-label^="Script of step"]')].every((pre) => pre.scrollHeight <= pre.clientHeight + 1 && getComputedStyle(pre).overflowY === "visible")) && /lines?, shown in full/.test(layout.text),
      "results are not called independent of the agent": /Re-run by TerminalX on the preparation machine/.test(layout.text) && /not an independent result/.test(layout.text),
      "the build and the apply each ask first": /starts a temporary builder machine on Local Docker/.test(layout.text) && /Replace the template's machine script/.test(layout.text),
      "configuring with an agent asks first, with the price, the running limit and the 60 minutes": /about \$0\.02 an hour/.test(layout.text) && /1 of 3 are running now/.test(layout.text) && /after 60 minutes/.test(layout.text) && /Never edit code, tests or configuration/.test(layout.text),
      "asking starts no machine and stores no recipe": !calls.includes("cloud_workspace_create") && !calls.includes("organization_environment_recipe_propose"),
      "looking and asking sends no build, retry, rollback, apply or save": !calls.some((command) => /^organization_environment_(build|update|version_retry|version_cancel|version_rollback|recipe_apply|recipe_dismiss)$/.test(command)) && !calls.some((command) => /^cloud_(remote_attach|workspace_resume|workspace_create)$/.test(command)),
    }, { small: layout.small, outside: layout.outside, overlaps: layout.overlaps, calls: calls.filter((command) => command.startsWith("organization_environment")) });
    await page.close();
  }
  failed += await localEnvironment();
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);

async function localEnvironment() {
  let failures = 0;
  const rows = {
    user: [
      { name: "ANTHROPIC_API_KEY", scope: "user", overridden: false },
      { name: "NODE_OPTIONS", scope: "user", overridden: false, secret: false, value: "--max-old-space-size=8192" },
      { name: "DATABASE_URL", scope: "user", overridden: false, secret: false, value: "postgres://localhost:5432/dev", overriddenIn: ["/repos/p0/.git"] },
    ],
    "/repos/p0": [
      { name: "ANTHROPIC_API_KEY", scope: "user", overridden: false },
      { name: "DATABASE_URL", scope: "user", overridden: true, secret: false, value: "postgres://localhost:5432/dev" },
      { name: "DATABASE_URL", scope: "repository", overridden: false, secret: false, value: "postgres://localhost:5432/a_database_with_a_rather_long_name_dev" },
      { name: "STRIPE_SECRET_KEY_FOR_THE_STAGING_ACCOUNT", scope: "repository", overridden: false },
      { name: "VITE_RELAY_URL", scope: "repositoryShared", overridden: false, secret: false },
    ],
  };
  for (const width of [960, 720]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 2 }, { width, height: 900 });
    await page.evaluate((rows) => {
      window.__LOCAL_ENVIRONMENT_CALLS__ = [];
      const answers = window.__PW_STUB__.answers;
      const log = (command, answer) => (args) => { window.__LOCAL_ENVIRONMENT_CALLS__.push(command); return answer(args); };
      answers.environment_list = log("environment_list", ({ projectPath }) => structuredClone(rows[projectPath ?? "user"] ?? []));
      answers.environment_save = log("environment_save", () => true);
      answers.environment_reveal = log("environment_reveal", () => "hidden");
    }, rows);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Environment", exact: true }).click();
    await page.getByRole("button", { name: "Reveal ANTHROPIC_API_KEY" }).first().waitFor();
    await page.getByRole("combobox", { name: "Scope" }).selectOption("/repos/p0");
    const repository = page.getByRole("region", { name: "Environment of local-0" });
    await repository.getByRole("button", { name: "Reveal STRIPE_SECRET_KEY_FOR_THE_STAGING_ACCOUNT" }).waitFor();
    await repository.getByText(/^Documented variables/).click();
    const measure = (locator) => locator.evaluate((root) => {
      const main = root.closest('[role="main"]') ?? document.body;
      const bounds = root.getBoundingClientRect();
      const outside = [...root.querySelectorAll("button, input, textarea, select, table, li")].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1);
      }).map((element) => `${element.tagName}:${(element.getAttribute("aria-label") ?? element.textContent ?? "").slice(0, 40)}`);
      const boxes = [...root.querySelectorAll("button, input[type=checkbox], td")].map((element) => ({ label: element.getAttribute("aria-label") ?? element.textContent, box: element.getBoundingClientRect() })).filter(({ box }) => box.width > 0);
      const overlaps = [];
      for (let a = 0; a < boxes.length; a++)
        for (let b = a + 1; b < boxes.length; b++) {
          const one = boxes[a].box, two = boxes[b].box;
          const nested = (one.left <= two.left && one.right >= two.right && one.top <= two.top && one.bottom >= two.bottom) || (two.left <= one.left && two.right >= one.right && two.top <= one.top && two.bottom >= one.bottom);
          if (!nested && one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps.push([boxes[a].label, boxes[b].label]);
        }
      return { noPageOverflow: main.scrollWidth <= main.clientWidth + 1, outside, overlaps, text: root.textContent };
    });
    const layout = await measure(repository);
    await repository.screenshot({ path: `/tmp/pro-144-repository-environment-${width}.png` });
    const databaseRows = await repository.locator("tbody tr").evaluateAll((rows) => rows.filter((row) => row.cells[0].textContent.startsWith("DATABASE_URL")).length);
    await repository.getByRole("button", { name: "Paste KEY=VALUE" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Variables").fill("SENTRY_AUTH_TOKEN=sntrys_eyJpYXQiOjE3\nVITE_RELAY_URL=wss://relay.dev.example\n2FA_SEED=JBSWY3DPEHPK3PXP");
    const keychain = sheet.getByRole("checkbox", { name: "Keep values that look like secrets in the Keychain" });
    const sheetLayout = await measure(sheet);
    await sheet.screenshot({ path: `/tmp/pro-144-add-variables-${width}.png` });
    const calls = await page.evaluate(() => window.__LOCAL_ENVIRONMENT_CALLS__);
    failures += report(`local environment pages at ${width}px`, {
      "the repository page does not widen the Settings column": layout.noPageOverflow,
      "every control and row stays inside the repository page": layout.outside.length === 0,
      "no two controls or cells overlap on the repository page": layout.overlaps.length === 0,
      "the column reads Applies to, with each source": /Applies to/i.test(layout.text) && /from Personal/.test(layout.text) && /overrides Personal/.test(layout.text) && /This project/.test(layout.text) && /\.terminalx\/settings\.json/.test(layout.text),
      "a Personal value the project overrides is listed once": databaseRows === 1,
      "documented variables say where each is set": /Documented variables \(13\)/.test(layout.text) && /Set in Personal/.test(layout.text) && /Not set/.test(layout.text),
      "the Add sheet's Keychain box is ticked by default": await keychain.isChecked(),
      "the Add sheet stays inside itself with no overlaps": sheetLayout.outside.length === 0 && sheetLayout.overlaps.length === 0,
      "the sheet marks the secret-looking value and the bad line": /SENTRY_AUTH_TOKENsecret/.test(sheetLayout.text) && /line 3: starts with a digit/.test(sheetLayout.text) && /1 line skipped/.test(sheetLayout.text),
      "looking reveals and saves nothing": !calls.includes("environment_reveal") && !calls.includes("environment_save"),
    }, { outside: [...layout.outside, ...sheetLayout.outside], overlaps: [...layout.overlaps, ...sheetLayout.overlaps], calls });
    await page.close();
  }
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 2 }, { width: 1440, height: 900 }, { colorScheme });
    await page.evaluate((rows) => {
      const answers = window.__PW_STUB__.answers;
      answers.environment_list = ({ projectPath }) => structuredClone(rows[projectPath ?? "user"] ?? []);
      answers.environment_save = () => true;
    }, { ...rows, user: [...rows.user, { name: "PNPM_HOME", scope: "user", overridden: false, secret: false, value: "/Users/alex/Library/pnpm/a/rather/long/path/that/must/not/wrap/anywhere" }] });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Environment", exact: true }).click();
    const table = page.getByRole("table", { name: "Environment variables" }).first();
    await table.getByRole("button", { name: "Reveal ANTHROPIC_API_KEY" }).waitFor();
    const personal = await table.evaluate((root) => {
      const rows = [...root.querySelectorAll("tbody tr")];
      const title = document.getElementById("settings-section-title").getBoundingClientRect();
      const add = [...document.querySelectorAll("button")].find((b) => b.textContent === "Add variable").getBoundingClientRect();
      const header = getComputedStyle(root.querySelector("th"));
      return {
        heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
        // Each row's buttons share one line, and each cell holds one line of text.
        oneLineActions: rows.every((row) => new Set([...row.querySelectorAll("td:last-child button")].map((b) => Math.round(b.getBoundingClientRect().top))).size <= 1),
        oneLineValues: rows.every((row) => { const cell = row.children[1]; return cell.scrollHeight <= cell.clientHeight + 1 && getComputedStyle(cell).whiteSpace === "nowrap"; }),
        valueSize: getComputedStyle(rows[0].children[1]).fontSize,
        kicker: header.textTransform === "uppercase" && parseFloat(header.fontSize) <= 11,
        besideTitle: Math.abs((add.top + add.bottom) / 2 - (title.top + title.bottom) / 2) < 12 && add.left > title.left + 200,
      };
    });
    await page.locator("main").screenshot({ path: `/tmp/pro-376-environment-1440-${colorScheme}.png` });
    await page.getByRole("button", { name: "Paste KEY=VALUE" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Variables").fill("SENTRY_AUTH_TOKEN=sntrys_eyJpYXQiOjE3\nVITE_RELAY_URL=wss://relay.dev.example\n2FA_SEED=JBSWY3DPEHPK3PXP\nPOSTHOG_KEY=phc_8Qm2xR7tLw0");
    await page.waitForTimeout(400);
    const box = await sheet.boundingBox();
    await page.screenshot({ path: `/tmp/pro-376-add-variables-1440-${colorScheme}.png` });
    failures += report(`Personal environment at 1440px, ${colorScheme}`, {
      "every row is 40 px": personal.heights.every((height) => height === 40),
      "every row's actions are on one line": personal.oneLineActions,
      "no value wraps": personal.oneLineValues,
      "values are 12.5 px": personal.valueSize === "12.5px",
      "column headers are uppercase kickers": personal.kicker,
      "Add variable sits beside the page title": personal.besideTitle,
      "Add variables is a full-height sheet at the right edge": Math.round(box.x + box.width) === 1440 && box.y === 0 && Math.round(box.height) === 900 && box.width <= 460,
      "the sheet's footer counts the skipped line and the chosen variables": (await sheet.getByText("1 line skipped").count()) === 1 && (await sheet.getByRole("button", { name: "Add 3 variables" }).count()) === 1,
    }, personal);
    await page.close();
  }
  return failures;
}
