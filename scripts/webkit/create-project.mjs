#!/usr/bin/env node
// PRO-286: "Create a project" (Quick start) and Settings › Projects in the built app,
// with real keyboard events in WebKit. Synthetic bridge only; nothing is created on disk.
// Run after pnpm build: node scripts/webkit/create-project.mjs
// WEBKIT_LAYOUT_SCREENSHOTS=<dir> also saves each state in light and dark.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, open, serve } from "./harness.mjs";

const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const mod = process.platform === "darwin" ? "Meta" : "Control";

const server = await serve();
const browser = await launch();
try {
  const page = await open(browser, server.url, { cloud: false, localProjects: 0 }, { width: 1100, height: 900 }, {
    extra: `
      localStorage.setItem('raccoon.prefs', JSON.stringify({ sidebarOpen: false }));
      window.__CREATE_CALLS__ = [];
      const BUILT_IN = [
        { id: "empty", name: "Empty", description: "A README, a .gitignore and nothing else", builtIn: true },
        { id: "vite-react", name: "Vite + React", description: "TypeScript, Tailwind and Vitest", builtIn: true },
        { id: "agent-starter", name: "Agent starter", description: "CLAUDE.md, AGENTS.md, setup and test scripts", builtIn: true },
      ];
      window.__TEMPLATES__ = BUILT_IN;
      window.__CREATE__ = null;
      Object.assign(window.__PW_STUB__.answers, {
        "plugin:path|resolve_directory": "/Users/demo",
        project_start_defaults: ({ parent }) => ({ projectsDir: parent ?? "/Users/demo/TerminalX/Projects", suggestedName: "tx-review-lab" }),
        project_templates: () => window.__TEMPLATES__,
        project_template_add: ({ path }) => {
          const added = { id: "user:1", name: path.split("/").pop(), description: path, path, builtIn: false };
          window.__TEMPLATES__ = [...window.__TEMPLATES__, added];
          return added;
        },
        project_template_remove: ({ id }) => { window.__TEMPLATES__ = window.__TEMPLATES__.filter((t) => t.id !== id); return null; },
        project_create: (args) => {
          window.__CREATE_CALLS__.push(args);
          return window.__CREATE__ ? window.__CREATE__(args) : args.parent + "/" + args.name;
        },
        add_project: ({ path }) => ({ path, name: path.split("/").pop(), kind: "git" }),
      });
    `,
  });
  const capture = async (name, locator = page.getByRole("dialog").last()) => {
    if (!shots) return;
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction((mode) => document.documentElement.dataset.mode === mode, colorScheme);
      const png = await locator.screenshot({ path: `${shots}/${name}-${colorScheme}.png`, animations: "disabled" });
      assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a", "WebKit returns a real PNG screenshot");
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  const openDialog = async () => {
    const start = page.getByTestId("start-screen");
    if (await start.count()) {
      await start.getByRole("button", { name: "Quick start", exact: true }).click();
    } else {
      // Once a project exists the start screen gives way; the palette keeps all three actions.
      await page.keyboard.press(`${mod}+K`);
      await page.getByLabel("Command palette search").fill("Add a project: Quick start");
      await page.getByRole("option", { name: /Add a project: Quick start/ }).first().click();
    }
    const dialog = page.getByTestId("start-quick-dialog");
    await dialog.getByRole("radiogroup", { name: "Template" }).waitFor();
    await page.waitForFunction(() => document.querySelector("#start-quick-name")?.value === "tx-review-lab");
    return dialog;
  };
  const radio = (dialog, name) => dialog.getByRole("radio", { name: new RegExp(`^${name.replace(/\+/g, "\\+")}`) });

  // The default state, as the design draws it.
  let dialog = await openDialog();
  assert.equal(await dialog.getByRole("heading", { name: "Create a project" }).count(), 1);
  assert.equal(await page.locator("#start-quick-name").evaluate((el) => el === document.activeElement), true, "the name is focused");
  assert.equal(await dialog.getByTestId("start-destination").textContent(), "~/TerminalX/Projects/tx-review-lab");
  assert.equal(await dialog.getByTestId("start-parent").textContent(), "~/TerminalX/Projects");
  assert.deepEqual(await dialog.getByRole("radio").evaluateAll((els) => els.map((el) => [el.dataset.template, el.getAttribute("aria-checked")])), [["empty", "true"], ["vite-react", "false"], ["agent-starter", "false"]]);
  assert.equal(await dialog.getByRole("checkbox", { name: "Open a new session in it when it's ready" }).isChecked(), true);
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  const box = await dialog.boundingBox();
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  // 580px in the design at 16px text; the app sizes dialogs in rem so they follow Settings › Appearance › Text size.
  assert.ok(box && Math.abs(box.width - 36.25 * rem) <= 1, `the dialog is 36.25rem wide (${box?.width} at ${rem}px)`);
  await capture("01-default");

  // A template picked, then Esc: nothing is created.
  await radio(dialog, "Vite + React").click();
  assert.equal(await radio(dialog, "Vite + React").getAttribute("aria-checked"), "true");
  await capture("02-vite-react-selected");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal((await page.evaluate(() => window.__CREATE_CALLS__)).length, 0, "Esc creates nothing");

  // A folder already in use: the existing failure message, and the dialog stays.
  await page.evaluate(() => {
    window.__CREATE__ = () => Promise.reject({ code: "destination-exists", message: "/Users/demo/TerminalX/Projects/tx-review-lab already exists. Choose another name." });
  });
  dialog = await openDialog();
  await page.keyboard.press(`${mod}+Enter`);
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.getByRole("alert").textContent(), /already exists\. Choose another name\./);
  await capture("03-folder-in-use");

  // Creating: the dialog holds while the backend works.
  await page.evaluate(() => {
    window.__CREATE__ = (args) => new Promise((resolve) => { window.__FINISH_CREATE__ = () => resolve(args.parent + "/" + args.name); });
  });
  await page.locator("#start-quick-name").fill("tx-review-lab-2");
  await radio(dialog, "Agent starter").click();
  await dialog.getByRole("checkbox", { name: "Open a new session in it when it's ready" }).uncheck();
  await capture("04-session-off");
  await page.keyboard.press(`${mod}+Enter`);
  await page.waitForFunction(() => typeof window.__FINISH_CREATE__ === "function");
  assert.equal(await dialog.getByRole("button", { name: /^Create/ }).isDisabled(), true, "Create waits while the project is made");
  await capture("05-creating");
  await page.evaluate(() => window.__FINISH_CREATE__());
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual((await page.evaluate(() => window.__CREATE_CALLS__)).at(-1), { parent: "/Users/demo/TerminalX/Projects", name: "tx-review-lab-2", template: "agent-starter" });
  assert.equal(await page.locator("textarea[data-new-session-prompt]").count(), 0, "with the checkbox off no new-session view opens");
  console.log("ok create a project: fields, templates, Esc, Cmd+Enter, failure, checkbox off");

  // The link opens Settings › Projects, where a folder is added as a template.
  await page.evaluate(() => { window.__CREATE__ = null; window.__PW_STUB__.answers["plugin:dialog|open"] = "/Users/demo/templates/house-style"; });
  dialog = await openDialog();
  await dialog.getByRole("button", { name: "Add your own templates in Settings › Projects" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  const settings = page.locator('[data-setting-id="projects.templates"]');
  await settings.getByRole("list", { name: "Built-in templates" }).waitFor();
  await capture("06-settings-empty", page.locator("main"));
  await settings.getByRole("button", { name: "Add a template from a folder…" }).click();
  await settings.getByRole("list", { name: "Your templates" }).getByText("house-style", { exact: true }).waitFor();
  await capture("07-settings-added", page.locator("main"));
  await page.keyboard.press("Escape");

  // The template added there is offered in the dialog and is what the project is made from.
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor({ state: "detached" });
  dialog = await openDialog();
  await radio(dialog, "house-style").click();
  await capture("08-user-template");
  await dialog.getByRole("button", { name: /^Create/ }).click();
  await page.locator("textarea[data-new-session-prompt]").waitFor();
  assert.deepEqual((await page.evaluate(() => window.__CREATE_CALLS__)).at(-1), { parent: "/Users/demo/TerminalX/Projects", name: "tx-review-lab", template: "user:1" });
  console.log("ok settings › projects: add a folder, offered in the dialog, opens a session by default");
  await page.close();
} finally {
  await browser.close();
  server.close();
}
