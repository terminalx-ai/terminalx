#!/usr/bin/env node
// PRO-20: the organization's Environment section in the desktop's WebKit
// engine. The machine script, each repository's setup, the versions and a
// recipe's results must stay readable and inside the Settings column at the
// narrow window width, and looking at any of it must start nothing.
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
      definition: { ...definition, installScript: `${definition.installScript}\ncorepack enable` },
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
  for (const width of [960, 720]) {
    const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width, height: 900 });
    await page.evaluate(
      ({ status, recipes }) => {
        window.__ENVIRONMENT_CALLS__ = [];
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = (command, args) => {
          window.__ENVIRONMENT_CALLS__.push(command);
          return invoke(command, args);
        };
        const answers = window.__PW_STUB__.answers;
        answers.cloud_providers = { providers: [{ id: "local-docker", displayName: "Local Docker", availability: "available", canManage: true, connection: { state: "connected", connectedAt: 1, lastValidatedAt: 1, credentialFingerprint: null }, capabilities: {} }] };
        answers.organization_environment_status = { ...status, contextRevision: "s:1" };
        answers.organization_environment_recipes = { ...recipes, contextRevision: "s:1" };
        answers.organization_environment_version = { ...status.versions[0], contextRevision: "s:1", logs: [{ phase: "install", content: "E: Unable to locate package build-essentials\nexit status 100", occurredAt: 1 }] };
      },
      { status, recipes },
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const template = page.getByRole("form", { name: "Environment template" });
    await template.waitFor();
    await page.getByRole("region", { name: "Environment recipes" }).waitFor();
    await page.getByRole("button", { name: "Build version…" }).click();
    await page.getByRole("listitem", { name: "Version 4" }).getByRole("button", { name: "Show log" }).click();
    await page.getByLabel("Build log of version 4").getByText(/Unable to locate/).waitFor();
    await page.getByRole("button", { name: "Apply…" }).click();
    const section = page.locator("div.rounded-lg", { has: page.getByText("Cloud environment", { exact: true }) }).last();
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
      };
    });
    // Tall enough that the whole section is laid out on screen for the picture.
    await page.setViewportSize({ width, height: 3200 });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: `/tmp/pro-20-environment-${width}.png` });
    const calls = await page.evaluate(() => window.__ENVIRONMENT_CALLS__);
    failed += report(`environment section at ${width}px`, {
      "the section does not widen the Settings column": layout.noPageOverflow,
      "every control, table and script stays inside the section": layout.outside.length === 0,
      "no two buttons overlap": layout.overlaps.length === 0,
      "the machine script and repository setup are separate fields": (await template.getByLabel("Machine install script").count()) === 1 && (await template.getByRole("listitem").count()) === 2,
      "a failing check reads as failing, and a pre-existing one says so": /Failed \(already failing before this recipe\) \(exit 1\)/.test(layout.text) && /Timed out/.test(layout.text),
      "the build and the apply each ask first": /starts a temporary builder machine on Local Docker/.test(layout.text) && /Replace the template's machine script/.test(layout.text),
      "looking and asking sends no build, retry, rollback, apply or save": !calls.some((command) => /^organization_environment_(build|update|version_retry|version_cancel|version_rollback|recipe_apply|recipe_dismiss)$/.test(command)) && !calls.some((command) => /^cloud_(remote_attach|workspace_resume|workspace_create)$/.test(command)),
    }, { outside: layout.outside, overlaps: layout.overlaps, calls: calls.filter((command) => command.startsWith("organization_environment")) });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
